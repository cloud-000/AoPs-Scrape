import { CleanupText } from "./CleanupText.js";
import { ForumSession, makeProblem } from "./ForumSession.js";
import { TYPES } from "../contest_id.js";
import { wikiTestMetadata } from "./testMetadata.js";

const WIKI_API = "https://artofproblemsolving.com/wiki/api.php";
const MCQ_LETTERS = ["A", "B", "C", "D", "E"];

/**
 * Client for the AoPS MediaWiki Action API (https://artofproblemsolving.com/wiki/api.php).
 *
 * Parallels ForumSession: same constructor shape, randomized request delay,
 * optional ResponseCache, and Cloudflare/JSON retry envelope — but it issues GET
 * requests to the wiki API instead of POSTing to the community ajax endpoint. The
 * wiki sits behind the same Cloudflare as the forum, so it needs the same session
 * `headers` (cookies + UA) a `.env.js` user carries; a plain GET returns a 403
 * challenge page.
 *
 * Produced problems use the shared makeProblem() shape (from ForumSession) so wiki
 * and forum problems are interchangeable downstream; getContest() returns a
 * ScrapedTest-shaped object consumable by db.upsertWikiResults().
 */
export class WikiSession {
    constructor(
        loggedIn,
        userId,
        sessionId,
        headers = null,
        onProblemAdd = null,
    ) {
        this.loggedIn = loggedIn;
        this.userId = userId;
        this.sessionId = sessionId;
        this.headers = headers;
        this.debug = true;
        this.onProblemAdd = onProblemAdd ?? (() => {});
        this.requestDelay = [100, 250];
        this.cache = null;
        // Where log() writes. The CLI points this at its live status region so
        // messages land in scrollback instead of being erased by the next
        // repaint; leaving it as console.log keeps the class usable standalone.
        this.logger = (message) => console.log(message);
        // Structured lifecycle hook, called with the event objects documented on
        // `_emit`. Distinct from `logger`: this is machine-readable progress for
        // a UI, not prose. Never let a consumer's throw abort a scrape.
        this.onEvent = () => {};
        // Counters for the end-of-run summary; see `resetStats` for the shape.
        this.resetStats();
    }

    resetStats() {
        this.stats = {
            requests: 0, // logical fetches, cached or not
            cacheHits: 0,
            networkRequests: 0,
            networkMs: 0, // wall time in fetch(), excluding the politeness delay
            slowest: 0,
            missing: 0, // API replied "missingtitle" (a 404 page)
            retries: 0,
            challenges: 0, // Cloudflare / 403 interstitials
        };
        return this.stats;
    }

    /** Mean network latency in ms, or null before any uncached request. */
    get averageNetworkMs() {
        const { networkRequests, networkMs } = this.stats;
        return networkRequests > 0 ? networkMs / networkRequests : null;
    }

    log(message) {
        if (this.debug) this.logger(message);
    }

    /**
     * Emits a progress event. Event `type` is one of:
     *   request  { page, cached, ms, missing }  a wiki API call completed
     *   retry    { page, kind, attempt, delayMs } a call is being retried
     *   test     { name, phase: "start"|"done", count } a contest-year boundary
     *   problem  { name, index, total, page }   a problem page was accepted
     *   warn     { message }                    a non-fatal anomaly
     * Consumer errors are swallowed so instrumentation can never break a scrape.
     */
    _emit(type, payload = {}) {
        try {
            this.onEvent({ type, ...payload });
        } catch {
            /* a broken listener must not abort the run */
        }
    }

    // Low-level GET to the wiki API. `params` is a plain object of query params
    // and doubles as the ResponseCache key. Mirrors ForumSession.sendRequest's
    // retry structure.
    async _get(params) {
        const page = params.page ?? "(unknown page)";
        this.stats.requests++;

        if (this.cache && this.cache.has(params)) {
            const cached = await this.cache.get(params);
            this.stats.cacheHits++;
            if (cached?.error?.code === "missingtitle") this.stats.missing++;
            this._emit("request", {
                page,
                cached: true,
                ms: 0,
                missing: cached?.error?.code === "missingtitle",
            });
            return cached;
        }

        const url = `${WIKI_API}?${new URLSearchParams(params)}`;
        const init = { method: "GET", credentials: "include" };
        if (this.headers) init.headers = this.headers;

        if (this.requestDelay[0] > 0) {
            await new Promise((r) =>
                setTimeout(
                    r,
                    this.requestDelay[0] +
                        (this.requestDelay[1] - this.requestDelay[0]) *
                            Math.random(),
                ),
            );
        }

        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const startedAt = performance.now();
            const response = await fetch(url, init);
            const text = await response.text();
            const elapsed = performance.now() - startedAt;
            this.stats.networkRequests++;
            this.stats.networkMs += elapsed;
            this.stats.slowest = Math.max(this.stats.slowest, elapsed);

            const isChallenge =
                text.includes("challenges.cloudflare.com") ||
                (response.status === 403 && !text.trimStart().startsWith("{"));
            if (isChallenge) {
                this.stats.challenges++;
                if (attempt === MAX_RETRIES) {
                    throw new Error(
                        "Cloudflare challenge / 403 from the wiki after all retries. Copy fresh headers from your browser's DevTools and update .env.js.",
                    );
                }
                const delayMs = 5000 * (attempt + 1);
                this.stats.retries++;
                this._emit("retry", {
                    page,
                    kind: "cloudflare",
                    attempt: attempt + 1,
                    delayMs,
                });
                this.log(
                    `Cloudflare challenge on "${page}" (attempt ${attempt + 1}/${MAX_RETRIES + 1}, HTTP ${response.status}), waiting ${delayMs / 1000}s...`,
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }
            try {
                const parsed = JSON.parse(text);
                if (this.cache) await this.cache.set(params, parsed);
                const missing = parsed?.error?.code === "missingtitle";
                if (missing) this.stats.missing++;
                this._emit("request", {
                    page,
                    cached: false,
                    ms: elapsed,
                    missing,
                });
                return parsed;
            } catch (e) {
                if (attempt === MAX_RETRIES) {
                    this.log(
                        `Failed to parse wiki JSON for "${page}" after ${MAX_RETRIES + 1} attempts (HTTP ${response.status}). Response: ${text.slice(0, 500)}`,
                    );
                    throw e;
                }
                const delayMs = 1000 * 2 ** attempt;
                this.stats.retries++;
                this._emit("retry", {
                    page,
                    kind: "json",
                    attempt: attempt + 1,
                    delayMs,
                });
                this.log(
                    `JSON parse failed for "${page}" (attempt ${attempt + 1}/${MAX_RETRIES + 1}, HTTP ${response.status}), retrying in ${delayMs}ms...`,
                );
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }

    // Parse a wiki page. Returns rendered HTML (default) or raw wikitext, for the
    // whole page or a single section. Throws an Error carrying `.code` (e.g.
    // "missingtitle") when the API reports an error.
    async parse(page, { section = null, wikitext = false } = {}) {
        const params = { action: "parse", page, format: "json" };
        if (wikitext) params.prop = "wikitext";
        if (section != null) params.section = section;
        const json = await this._get(params);
        if (json.error) {
            const e = new Error(`wiki parse "${page}": ${json.error.code}`);
            e.code = json.error.code;
            throw e;
        }
        return wikitext ? json.parse.wikitext["*"] : json.parse.text["*"];
    }

    // Splits wikitext into a lead (text before the first header) and named
    // sections. Handles ==H2== / ===H3=== style MediaWiki headers.
    static _splitSections(wikitext) {
        const headerRe = /^(={2,})\s*(.*?)\s*\1\s*$/gm;
        const sections = [];
        let lastIndex = 0;
        let lead = wikitext;
        let m;
        let firstHeaderAt = null;
        const marks = [];
        while ((m = headerRe.exec(wikitext)) !== null) {
            marks.push({
                title: m[2],
                start: m.index,
                bodyStart: m.index + m[0].length,
            });
            if (firstHeaderAt === null) firstHeaderAt = m.index;
        }
        if (firstHeaderAt !== null) lead = wikitext.slice(0, firstHeaderAt);
        for (let i = 0; i < marks.length; i++) {
            const end =
                i + 1 < marks.length ? marks[i + 1].start : wikitext.length;
            sections.push({
                title: marks[i].title,
                body: wikitext.slice(marks[i].bodyStart, end),
            });
        }
        return { lead, sections };
    }

    // Parses a `#REDIRECT [[Target]]` wikitext page, returning the normalized
    // target page title (spaces not underscores, no |display or #anchor), or null
    // if the wikitext is not a redirect. AoPS marks a shared problem (e.g. an
    // AMC 12 problem that repeats an AMC 10 problem) with such a redirect.
    static _parseRedirect(wikitext) {
        const m = /^\s*#REDIRECT\s*\[\[\s*([^\]]+?)\s*\]\]/i.exec(wikitext ?? "");
        if (!m) return null;
        return m[1].split("|")[0].split("#")[0].replace(/_/g, " ").trim() || null;
    }

    // Fetches and parses a single problem page into a makeProblem-shaped object.
    // `computational`/`choices` come from the contest type: `choices` true =>
    // MCQ (AMC), extract \textbf{(A)} options + a letter answer; false => numeric
    // (AIME), take the boxed value literally.
    //
    // Redirect handling: if `page` is a `#REDIRECT` to another problem page, we
    // follow it to the canonical content (so this placement row is still
    // populated) but keep this page's own number, and stamp `redirectTarget` on
    // the returned problem so db.upsertWikiResults can record the duplicate link.
    async getProblemPage(page, { computational = true, choices = true } = {}) {
        let full = await this.parse(page, { wikitext: true });
        let redirectTarget = WikiSession._parseRedirect(full);
        if (redirectTarget) {
            // Follow one hop to the canonical page for the actual content.
            full = await this.parse(redirectTarget, { wikitext: true });
        }
        const { lead, sections } = WikiSession._splitSections(full);

        // Statement: an explicit "Problem" section if present, else the lead.
        // Normalize <math>…</math> to $…$ so the forum-oriented CleanupText
        // helpers (extractChoices/cleanChoices/getBoxed) apply cleanly.
        const problemSection = sections.find((s) => /^\s*Problem/i.test(s.title));
        let statementSrc = CleanupText.normalizeWikiMath(
            (problemSection ? problemSection.body : lead).trim(),
        );

        // Fetch rendered HTML only when we need asy image URLs. Render the
        // content page (the redirect target when this page is a redirect).
        const contentPage = redirectTarget ?? page;
        let rendered = null;
        if (/<asy\b/i.test(statementSrc)) {
            try {
                rendered = await this.parse(contentPage);
            } catch {
                rendered = null;
            }
            // Choice extraction understands the shared `[asy]...[/asy]` form.
            // Convert raw wiki blocks before splitting A–E so a diagram that
            // starts on the line after its label remains the choice value.
            statementSrc = CleanupText.toWikiAsyLinks(statementSrc, rendered);
        }

        // MCQ choices, pulled out of the statement before cleaning.
        let choiceList = null;
        if (computational && choices) {
            const extracted = CleanupText.extractChoices(statementSrc);
            const hasChoiceValues =
                extracted.length >= 3 &&
                extracted.every((choice) => String(choice ?? "").trim() !== "");
            const visualChoices = hasChoiceValues
                ? []
                : CleanupText.extractVisualChoiceLabels(statementSrc, {
                      fallbackCount:
                          extracted.length >= 3 && extracted.length <= 5
                              ? extracted.length
                              : 5,
                  });
            if (visualChoices.length >= 3) {
                // Keep the composite visual in the statement and expose only
                // its A-E identities as the machine-readable choice values.
                choiceList = visualChoices;
            } else if (extracted.length >= 3) {
                choiceList = extracted;
                statementSrc = CleanupText.cleanChoices(statementSrc);
            } else {
                this.log(
                    `⚠️  ${page}: expected MCQ choices but found ${extracted.length}; leaving the source statement intact.`,
                );
            }
        }
        const statement = CleanupText.cleanWikiProblem(statementSrc, rendered);

        // Solutions: every ==Solution N== section, lightly cleaned.
        const solutionSections = sections.filter((s) =>
            /solution/i.test(s.title),
        );
        const solutions = solutionSections
            .map((s) => ({
                content: CleanupText.cleanWikiProblem(s.body).trim(),
                is_official: true,
            }))
            .filter((s) => s.content.length > 0);

        // Answer: pick the most-trustworthy \boxed{...} across all solution
        // sections. For MCQ, only a box matching a choice survives; otherwise a
        // solution that boxes intermediate steps (or an early wrong box) could
        // win over the real answer. Non-MCQ takes the value verbatim.
        let answerValue = null;
        let answerIndex = -1;
        if (computational) {
            const raw = CleanupText.selectBoxedAnswer(
                solutions.map((s) => s.content),
                {
                    answerKind: choiceList ? "mcq" : "numeric",
                    choices: choiceList,
                },
            );
            if (raw != null) {
                if (choiceList) {
                    const idx = CleanupText.choiceIndexOfAnswer(raw, choiceList);
                    if (idx >= 0) {
                        answerIndex = idx;
                        answerValue = MCQ_LETTERS[idx]; // MCQ answer is a letter
                    }
                } else {
                    answerValue = raw
                        .replace(/\\textbf\{([^}]*)\}/g, "$1")
                        .trim();
                }
            }
        }

        // Problem number from the page title ("…/Problem 23" -> n = 22).
        const numMatch = page.match(/Problem\s+(\d+)/i);
        const n = numMatch ? Number(numMatch[1]) - 1 : 0;

        const problem = makeProblem({
            statement,
            n,
            choices: choiceList,
            answerIndex,
            answerValue,
            solutions,
            page,
        });
        // Non-null only for a redirect placement; consumed by upsertWikiResults.
        problem.redirectTarget = redirectTarget;
        return problem;
    }

    // Converts a MediaWiki "# item" numbered list into "1. item\n2. item…" so the
    // forum-oriented CleanupText.parseAnswerKey can read a wiki answer-key page.
    static _wikiListToNumbered(text) {
        let i = 0;
        return text.replace(/^#\s*(.+)$/gm, (_, item) => `${++i}. ${item}`);
    }

    // Resolves a raw Answer Key value (a letter for MCQ, or a literal for
    // numeric) into { answerValue, answerIndex } for a problem with the given
    // `choices` (null for numeric contests).
    static _resolveKeyAnswer(raw, choices) {
        if (choices) {
            const parsed = CleanupText.parseMCQAns(raw);
            if (parsed?.type === "letter") {
                return {
                    answerValue: parsed.value,
                    answerIndex: MCQ_LETTERS.indexOf(parsed.value),
                };
            }
            const value = parsed?.value ?? raw;
            return { answerValue: value, answerIndex: choices.indexOf(value) };
        }
        return { answerValue: raw, answerIndex: -1 };
    }

    // Normalizes an answer literal for cross-checking a boxed solution answer
    // against the Answer Key: strips $…$ delimiters and \textbf wrappers,
    // upcases MCQ letters, and collapses integers (so "008" == "8") and stray
    // whitespace in LaTeX so equal answers aren't reported as a mismatch.
    static _normalizeAnswer(v) {
        if (v == null) return null;
        let s = String(v).trim();
        s = s.replace(/^\$+|\$+$/g, "").trim();
        s = s.replace(/\\textbf\{([^}]*)\}/g, "$1").trim();
        if (/^[A-Ea-e]$/.test(s)) return s.toUpperCase();
        if (/^-?\d+$/.test(s)) return String(parseInt(s, 10));
        return s.replace(/\s+/g, "");
    }

    /**
     * Assembles a full test for one contest variant + year (e.g. "AMC 10A",
     * 2021).
     *
     * Two distinct titles are in play, and conflating them is a bug:
     *
     * - `pageBase` addresses the **wiki**, e.g. "AHSME" → the page family
     *   "1950 AHSME Problems/Problem 3".
     * - `testName` (defaulting to `pageBase`) is what the test is **stored** as,
     *   and must match the forum's normalized category name so the natural key
     *   (series, name, year) merges wiki rows onto the forum rows rather than
     *   creating a parallel copy.
     *
     * They differ only where the wiki publishes a contest under a name the forum
     * does not use. AHSME is the case that motivated the split: the forum stores
     * those years as "1950 AMC 12", so `{ pageBase: "AHSME", testName: "AMC 12" }`.
     * The stored name also drives type inference — `inferType("1950 AHSME")` is
     * `null` (→ UNKNOWN → not computational, no choices, statements left with
     * their A–E options glued on), while `inferType("1950 AMC 12")` correctly
     * yields an MCQ contest.
     */
    async getContest(pageBase, year, { testName = null } = {}) {
        let actualPageBase = pageBase;
        let actualTestBase = testName ?? pageBase;
        if (year < 2000 && (pageBase === "AIME I" || pageBase === "AIME II")) {
            if (pageBase === "AIME II") return null;
            actualPageBase = "AIME";
            // Only when the caller did not name one explicitly: a pre-2000 AIME
            // was a single administration published (and stored) as plain "AIME".
            if (testName == null) actualTestBase = "AIME";
        }
        const pageTitle = `${year} ${actualPageBase}`;
        const name = `${year} ${actualTestBase}`;
        // Resolve metadata from the title the test is actually stored under, not
        // the variant we asked for: a pre-2000 AIME was a single administration,
        // so fetching it as the "AIME I" variant must not stamp it format = "I"
        // alongside the genuine 2000+ AIME I tests.
        const metadata = wikiTestMetadata(actualTestBase);
        const type = ForumSession.inferType(name, true) ?? TYPES.UNKNOWN;
        const computational = type.computational ?? false;
        const hasChoices = type.choices ?? false;

        this._emit("test", { name, pageTitle, phase: "start" });

        // Discover the problem count from the aggregate "… Problems" page.
        const defaultN = hasChoices ? 25 : 15;
        let N = defaultN;
        try {
            const agg = await this.parse(`${pageTitle} Problems`, {
                wikitext: true,
            });
            const nums = [...agg.matchAll(/==\s*Problem\s+(\d+)\s*==/gi)].map(
                (m) => Number(m[1]),
            );
            if (nums.length) N = Math.max(...nums);
        } catch (e) {
            this.log(
                `(no aggregate Problems page for "${pageTitle}", defaulting to ${defaultN} problems)`,
            );
        }

        // Optional answer-key fallback for problems whose solution has no \boxed.
        let key = {};
        try {
            const keyText = await this.parse(`${pageTitle} Answer Key`, {
                wikitext: true,
            });
            key = CleanupText.parseAnswerKey(
                WikiSession._wikiListToNumbered(keyText),
                pageTitle,
            );
        } catch {
            key = {};
        }

        const problems = [];
        for (let k = 1; k <= N; k++) {
            const page = `${pageTitle} Problems/Problem ${k}`;
            // Emitted before the fetch so a stalled or throttled request shows
            // up as "currently on problem k", not as silence.
            this._emit("problem", { name, pageTitle, index: k, total: N, page });
            let problem;
            try {
                problem = await this.getProblemPage(page, {
                    computational,
                    choices: hasChoices,
                });
            } catch (e) {
                if (e.code === "missingtitle") continue;
                throw e;
            }
            problem.n = k - 1;

            // Cross-check against the official Answer Key page. The key is
            // authoritative (curated), while the boxed answer comes from
            // user-written solution content — so the key wins on disagreement
            // and fills in a missing answer, and any conflict is logged.
            if (key[String(k)] != null) {
                const resolved = WikiSession._resolveKeyAnswer(
                    key[String(k)],
                    problem.choices,
                );
                const boxed = WikiSession._normalizeAnswer(problem.answerValue);
                const keyed = WikiSession._normalizeAnswer(resolved.answerValue);
                if (problem.answerValue == null) {
                    // No boxed answer: adopt the key silently.
                    problem.answerValue = resolved.answerValue;
                    problem.answerIndex = resolved.answerIndex;
                } else if (boxed !== keyed) {
                    // Mismatch: the key is authoritative — overwrite and warn.
                    this.log(
                        `⚠️  ${pageTitle} Problem ${k}: boxed answer "${problem.answerValue}" disagrees with Answer Key "${resolved.answerValue}"; using the key.`,
                    );
                    problem.answerValue = resolved.answerValue;
                    problem.answerIndex = resolved.answerIndex;
                }
                // else: they agree — nothing to do.
            }

            problems.push(problem);
            this.onProblemAdd(problem);
        }

        this._emit("test", {
            name,
            pageTitle,
            phase: "done",
            count: problems.length,
        });

        return {
            id: null,
            name,
            year: Number(year),
            ...(metadata ?? {}),
            type: type.name,
            computational,
            sections: [],
            problems,
            count: problems.length,
        };
    }
}
