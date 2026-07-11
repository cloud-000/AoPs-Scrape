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
    }

    log(message) {
        if (this.debug) console.log(message);
    }

    // Low-level GET to the wiki API. `params` is a plain object of query params
    // and doubles as the ResponseCache key. Mirrors ForumSession.sendRequest's
    // retry structure.
    async _get(params) {
        if (this.cache && this.cache.has(params)) {
            return await this.cache.get(params);
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
            const response = await fetch(url, init);
            const text = await response.text();
            const isChallenge =
                text.includes("challenges.cloudflare.com") ||
                (response.status === 403 && !text.trimStart().startsWith("{"));
            if (isChallenge) {
                if (attempt === MAX_RETRIES) {
                    throw new Error(
                        "Cloudflare challenge / 403 from the wiki after all retries. Copy fresh headers from your browser's DevTools and update .env.js.",
                    );
                }
                const delay = 5000 * (attempt + 1);
                this.log(
                    `\nCloudflare challenge (attempt ${attempt + 1}/${MAX_RETRIES + 1}), waiting ${delay / 1000}s...`,
                );
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            try {
                const parsed = JSON.parse(text);
                if (this.cache) await this.cache.set(params, parsed);
                return parsed;
            } catch (e) {
                if (attempt === MAX_RETRIES) {
                    console.error(
                        `\nFailed to parse wiki JSON after ${MAX_RETRIES + 1} attempts. Response: ${text.slice(0, 500)}`,
                    );
                    throw e;
                }
                const delay = 1000 * 2 ** attempt;
                this.log(
                    `\nJSON parse failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`,
                );
                await new Promise((r) => setTimeout(r, delay));
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

    // Fetches and parses a single problem page into a makeProblem-shaped object.
    // `computational`/`choices` come from the contest type: `choices` true =>
    // MCQ (AMC), extract \textbf{(A)} options + a letter answer; false => numeric
    // (AIME), take the boxed value literally.
    async getProblemPage(page, { computational = true, choices = true } = {}) {
        const full = await this.parse(page, { wikitext: true });
        const { lead, sections } = WikiSession._splitSections(full);

        // Statement: an explicit "Problem" section if present, else the lead.
        // Normalize <math>…</math> to $…$ so the forum-oriented CleanupText
        // helpers (extractChoices/cleanChoices/getBoxed) apply cleanly.
        const problemSection = sections.find((s) => /^\s*Problem/i.test(s.title));
        let statementSrc = CleanupText.normalizeWikiMath(
            (problemSection ? problemSection.body : lead).trim(),
        );

        // Fetch rendered HTML only when we need asy image URLs.
        let rendered = null;
        if (/<asy\b/i.test(statementSrc)) {
            try {
                rendered = await this.parse(page);
            } catch {
                rendered = null;
            }
        }

        // MCQ choices, pulled out of the statement before cleaning.
        let choiceList = null;
        if (computational && choices) {
            const extracted = CleanupText.extractChoices(statementSrc);
            if (extracted.length >= 3) {
                choiceList = extracted;
                statementSrc = CleanupText.cleanChoices(statementSrc);
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

        // Answer: scan solutions for the first \boxed{...}.
        let answerValue = null;
        let answerIndex = -1;
        for (const sol of solutions) {
            const boxed = CleanupText.getBoxed(sol.content);
            if (!boxed) continue;
            if (choiceList) {
                const parsed = CleanupText.parseMCQAns(boxed);
                if (parsed?.type === "letter") {
                    answerValue = parsed.value;
                    answerIndex = MCQ_LETTERS.indexOf(parsed.value);
                } else if (parsed) {
                    answerValue = parsed.value;
                    answerIndex = choiceList.indexOf(parsed.value);
                }
            } else {
                answerValue = boxed.replace(/\\textbf\{([^}]*)\}/g, "$1").trim();
            }
            if (answerValue != null) break;
        }

        // Problem number from the page title ("…/Problem 23" -> n = 22).
        const numMatch = page.match(/Problem\s+(\d+)/i);
        const n = numMatch ? Number(numMatch[1]) - 1 : 0;

        return makeProblem({
            statement,
            n,
            choices: choiceList,
            answerIndex,
            answerValue,
            solutions,
            page,
        });
    }

    // Converts a MediaWiki "# item" numbered list into "1. item\n2. item…" so the
    // forum-oriented CleanupText.parseAnswerKey can read a wiki answer-key page.
    static _wikiListToNumbered(text) {
        let i = 0;
        return text.replace(/^#\s*(.+)$/gm, (_, item) => `${++i}. ${item}`);
    }

    // Assembles a full test for one contest variant + year (e.g. "AMC 10A",
    // 2021). `name` must match the forum's normalized category name so the
    // natural key (series, name, year) merges wiki rows onto forum rows.
    async getContest(titleBase, year) {
        const name = `${year} ${titleBase}`;
        const metadata = wikiTestMetadata(titleBase);
        const type = ForumSession.inferType(name, true) ?? TYPES.UNKNOWN;
        const computational = type.computational ?? false;
        const hasChoices = type.choices ?? false;

        // Discover the problem count from the aggregate "… Problems" page.
        const defaultN = hasChoices ? 25 : 15;
        let N = defaultN;
        try {
            const agg = await this.parse(`${name} Problems`, { wikitext: true });
            const nums = [...agg.matchAll(/==\s*Problem\s+(\d+)\s*==/gi)].map(
                (m) => Number(m[1]),
            );
            if (nums.length) N = Math.max(...nums);
        } catch (e) {
            this.log(
                `\n(no aggregate Problems page for "${name}", defaulting to ${defaultN} problems)`,
            );
        }

        // Optional answer-key fallback for problems whose solution has no \boxed.
        let key = {};
        try {
            const keyText = await this.parse(`${name} Answer Key`, {
                wikitext: true,
            });
            key = CleanupText.parseAnswerKey(
                WikiSession._wikiListToNumbered(keyText),
                name,
            );
        } catch {
            key = {};
        }

        const problems = [];
        for (let k = 1; k <= N; k++) {
            let problem;
            try {
                problem = await this.getProblemPage(
                    `${name} Problems/Problem ${k}`,
                    { computational, choices: hasChoices },
                );
            } catch (e) {
                if (e.code === "missingtitle") continue;
                throw e;
            }
            problem.n = k - 1;

            // Apply the answer-key fallback when the page had no boxed answer.
            if (problem.answerValue == null && key[String(k)] != null) {
                const raw = key[String(k)];
                if (problem.choices) {
                    const parsed = CleanupText.parseMCQAns(raw);
                    if (parsed?.type === "letter") {
                        problem.answerValue = parsed.value;
                        problem.answerIndex = MCQ_LETTERS.indexOf(parsed.value);
                    } else {
                        problem.answerValue = parsed?.value ?? raw;
                        problem.answerIndex = problem.choices.indexOf(
                            problem.answerValue,
                        );
                    }
                } else {
                    problem.answerValue = raw;
                }
            }

            problems.push(problem);
            this.onProblemAdd(problem);
        }

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
