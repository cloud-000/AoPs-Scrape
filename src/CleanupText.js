// The `problems.acgn` / `production_problems.topic` vocabulary. `O` is the
// "nothing scored" fallback, not a subject. Defined here because INFER_WORDS
// below emits these codes; src/topicPolicy.js and src/testMetadata.js name
// them from here so the set has exactly one definition.
export const TOPIC = {
    CALCULUS: "K",
    ALGEBRA: "A",
    COMBINATORICS: "C",
    GEOMETRY: "G",
    NUMBER_THEORY: "N",
    OTHER: "O",
};

export class CleanupText {
    static multiLineRegexes = [
        {
            regex: /^\s*(\d+\.\s+.+)(\n\s*\n|\n)(\d+\.\s+.+)(?:\n\s*\n|\n(\d+\.\s+.+))*$/s,
            line: (n) => new RegExp(`^(?:p${n}|${n})\\.\\s*(.+)$`),
            index: 1,
        },
    ];

    static imgAsyRegex = /<img\b[^>]*\bclass\s*=\s*["']asy-image["'][^>]*>/gi;

    static INFER_WORDS = [
        {
            name: TOPIC.CALCULUS,
            keywords: [
                "derivative",
                "differentiate",
                "differentiable",
                "differentiation",
                "integration",
                "integrate",
                "integral",
                "antiderivative",
                "\\lim",
                "\\int",
                "dy/dx",
                "\\frac{dx}",
                "d/dx",
                "f'(x)",
                "g'(x)",
                "rate of change",
                "critical point",
                "inflection point",
                "taylor series",
                "maclaurin series",
                "chain rule",
                "l'hopital",
                "riemann sum",
                "limit as",
                "continuous function",
                "continuity",
                "mean value theorem",
                "intermediate value theorem",
                "calculus",
            ],
        },
        {
            name: TOPIC.ALGEBRA,
            keywords: [
                "real number",
                "complex number",
                "coefficient",
                "expansion",
                "y =",
                "y=",
                "x^2",
                "polynomial",
                "function",
                "sequence",
                "series",
                "arithmetic",
                "geometric",
                "logarithm",
                "inequality",
                "root",
                "equation",
                "sum of",
                "minimum",
                "maximum",
                "optimize",
            ],
        },
        {
            name: TOPIC.COMBINATORICS,
            keywords: [
                "probability",
                "number of ways",
                "how many",
                "rearranged",
                "expected value",
                "expected sum",
                "identical",
                "permutation",
                "palindrome",
                "graph",
                "counting",
                "bijection",
                "pigeonhole",
                "combination",
                "path",
                "tree",
                "cycle",
                "arrangement",
                "choose",
                "select",
                "committee",
                "subset",
            ],
        },
        {
            name: TOPIC.GEOMETRY,
            keywords: [
                "circle",
                "radius",
                "ellipse",
                "triangle",
                "rectangle",
                "polygon",
                "intersects",
                "plane",
                "area",
                "equilateral",
                "isosceles",
                "scalene",
                "vertex",
                "vertice",
                "diagonal",
                "congruent",
                "parallel",
                "concurrent",
                "co-centric",
                "collinear",
                "\\circ",
                "midpoint",
                "\\angle",
                "convex",
                "concave",
                "angle",
                "perpendicular",
                "circumradius",
                "inscribed",
                "tangent",
                "chord",
                "altitude",
                "median",
                "centroid",
                "circumcircle",
                "incircle",
                "hexagon",
                "quadrilateral",
                "perimeter",
                "hypotenuse",
            ],
        },
        {
            name: TOPIC.NUMBER_THEORY,
            keywords: [
                "integer",
                "divisor",
                "whole number",
                "lcm",
                "gcd",
                "digits",
                "integers",
                "factor",
                "perfect square",
                "prime",
                "divisible",
                "remainder",
                "modulo",
                "floor",
                "ceiling",
                "digit sum",
                "congruent",
                "modular",
                "base",
                "number theory",
                "\\lfloor",
                "\\lceil",
            ],
        },
    ];

    static buildNestedPattern(depth) {
        let pattern = "[^{}]*";
        for (let i = 0; i < depth; i++) {
            pattern = `(?:[^{}]|\\{${pattern}\\})*`;
        }
        return String.raw`\\boxed{(${pattern})}`;
    }

    static getBoxed(str, depth = 3) {
        let regex = new RegExp(CleanupText.buildNestedPattern(depth));
        let match = str.match(regex);
        return match ? match[1] : null;
    }

    // Every \boxed{…} value in a string, in document order. Unlike getBoxed
    // (which returns only the first), this feeds selectBoxedAnswer so a post
    // that boxes intermediate steps doesn't force the first box to win.
    static getAllBoxed(str, depth = 3) {
        const regex = new RegExp(CleanupText.buildNestedPattern(depth), "g");
        const out = [];
        for (const m of String(str).matchAll(regex)) out.push(m[1]);
        return out;
    }

    // Canonical form for comparing two answer literals (for MCQ-choice matching
    // and cross-post voting): drops $…$ delimiters and \textbf wrappers, upcases
    // MCQ letters, collapses integers ("008" == "8"), and strips inner whitespace.
    static normalizeAnswer(v) {
        if (v == null) return "";
        let s = String(v).trim();
        // Drop $…$ math delimiters and \$ currency markers so a boxed "17"
        // matches a choice written "\$17", and strip \textbf wrappers.
        s = s.replace(/\\?\$/g, "");
        s = s.replace(/\\textbf\{([^}]*)\}/g, "$1").trim();
        s = s.replace(/,(?=\d)/g, ""); // thousands separators: 11,400 -> 11400
        if (/^[A-Ea-e]$/.test(s)) return s.toUpperCase();
        if (/^-?\d+$/.test(s)) return String(parseInt(s, 10));
        return s.replace(/\s+/g, "");
    }

    // Is `value` a legitimate MCQ answer for the given choice list? A letter is
    // valid only if it indexes into the choices (or, when choices couldn't be
    // extracted, any A–J letter as a fallback); a text answer must equal one of
    // the choices. This is what discards a boxed intermediate result that isn't
    // one of the options.
    static isValidMCQAnswer(value, choices) {
        const parsed = CleanupText.parseMCQAns(value);
        if (!parsed) return false;
        const hasChoices = Array.isArray(choices) && choices.length > 0;
        if (parsed.type === "letter") {
            const idx = "ABCDEFGHIJ".indexOf(parsed.value);
            if (idx < 0) return false;
            return hasChoices ? idx < choices.length : true;
        }
        if (!hasChoices) return false;
        const norm = CleanupText.normalizeAnswer(parsed.value);
        return choices.some((c) => CleanupText.normalizeAnswer(c) === norm);
    }

    // Maps a boxed MCQ answer (a letter like "\textbf{(C)}" or a value like
    // "17") to its index in the choice list. Letters index directly; values are
    // matched by normalizeAnswer so "17" finds a choice written "\$17". Returns
    // -1 when it doesn't correspond to a listed choice.
    static choiceIndexOfAnswer(raw, choices) {
        if (raw == null || !Array.isArray(choices)) return -1;
        const parsed = CleanupText.parseMCQAns(raw);
        if (!parsed) return -1;
        if (parsed.type === "letter") {
            const idx = "ABCDEFGHIJ".indexOf(parsed.value);
            return idx >= 0 && idx < choices.length ? idx : -1;
        }
        const norm = CleanupText.normalizeAnswer(parsed.value);
        return choices.findIndex((c) => CleanupText.normalizeAnswer(c) === norm);
    }

    // Picks the single most-trustworthy \boxed{} answer out of a list of post
    // contents (a topic's replies, or a wiki page's solution sections).
    //
    // - answerKind "mcq": only boxes that are valid choices survive (see
    //   isValidMCQAnswer); "numeric"/"proof": any box is accepted verbatim
    //   (LaTeX/fractions/words are all fine).
    // - Ranking encodes the two rules for the multi-\boxed case: a post whose
    //   sole content is one box (a clean answer post) beats the last box of a
    //   multi-box post (an intermediate-steps post), which beats earlier boxes;
    //   ties break toward the value that recurs across the most posts (a vote),
    //   then the earliest post.
    //
    // Returns the raw boxed string of the winner, or null.
    static selectBoxedAnswer(
        postContents,
        { answerKind = "numeric", choices = null } = {},
    ) {
        if (!Array.isArray(postContents)) return null;
        const candidates = [];
        postContents.forEach((content, postIndex) => {
            if (content == null) return;
            const boxes = CleanupText.getAllBoxed(content);
            boxes.forEach((value, boxIndex) => {
                candidates.push({
                    value,
                    postIndex,
                    isSole: boxes.length === 1,
                    isLast: boxIndex === boxes.length - 1,
                    norm: CleanupText.normalizeAnswer(value),
                });
            });
        });

        const pool =
            answerKind === "mcq"
                ? candidates.filter((c) =>
                      CleanupText.isValidMCQAnswer(c.value, choices),
                  )
                : candidates;
        if (pool.length === 0) return null;

        // Vote: how many distinct posts carry each normalized value.
        const postsByNorm = new Map();
        for (const c of pool) {
            if (!postsByNorm.has(c.norm)) postsByNorm.set(c.norm, new Set());
            postsByNorm.get(c.norm).add(c.postIndex);
        }

        let best = null;
        for (const c of pool) {
            const vote = postsByNorm.get(c.norm).size;
            const score = (c.isSole ? 100 : 0) + (c.isLast ? 10 : 0) + vote;
            if (
                best === null ||
                score > best.score ||
                (score === best.score && c.postIndex < best.postIndex)
            ) {
                best = { value: c.value, score, postIndex: c.postIndex };
            }
        }
        return best ? best.value : null;
    }

    // Decides a test's answer format from the structural evidence of its own
    // problems. A clear MCQ-vs-other majority (differing by ≥2) forces every
    // problem to that kind; a tie or off-by-one leaves the test mixed, so each
    // problem keeps its own detected kind. `otherKind` names the non-MCQ kind
    // for this test (numeric or proof), taken from the contest name prior.
    static decideTestKind(mcqCount, otherCount, otherKind = "numeric") {
        if (Math.abs(mcqCount - otherCount) < 2) {
            return { mixed: true, kind: null };
        }
        return {
            mixed: false,
            kind: mcqCount > otherCount ? "mcq" : otherKind,
        };
    }

    static cleanProblem(str) {
        return str
            .replace(/^\[b\]Problem #\d+:\[\/b\]\s*/i, "")
            .replace(/\[i\][^\[]*?[pP]roposed by [^\[]*?\[\/i\]/gi, "")
            .trim();
    }

    static toAsyLinks(normal, rendered) {
        let matches = rendered
            .match(CleanupText.imgAsyRegex)
            ?.map((e) => "https:" + e.match(/src=["']([^"']*)["']/i)?.[1]);
        let count = 0;
        return normal.replace(/\[asy\](.*?)\[\/asy\]/gis, (_, content) => {
            count++;
            return `[asy=${matches[count - 1]}]${content}[/asy]`;
        });
    }

    // Decodes the small set of HTML entities MediaWiki uses when escaping
    // Asymptote source into an <img alt="…"> attribute (quotes from label()
    // strings, angle brackets from for-loop comparisons).
    static _decodeHtmlEntities(str) {
        return str
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;|&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
    }

    // MediaWiki analog of toAsyLinks: pairs each <asy>…</asy> block in the raw
    // wikitext with its rendered image from the page's rendered HTML, rewriting
    // to the same [asy=URL]…[/asy] BBCode form the forum path produces (so
    // downstream — inferACGN stripping, production — treats both sources
    // uniformly). The wiki has no native Asymptote renderer: it typesets the
    // diagram as a LaTeX image whose `alt` is the raw "[asy] … [/asy]" source
    // (whitespace-collapsed, HTML-entity-escaped) — there is no "asy" class/src
    // marker on the <img> itself (that was tried and never matched in practice;
    // the rendered class is just the ordinary block-LaTeX "latexcenter"). So we
    // match each <asy> block to its image by comparing normalized content
    // rather than by position/count, which also survives unrelated images
    // (logos, inline LaTeX) interleaved in the rendered HTML.
    static toWikiAsyLinks(wikitext, rendered) {
        const asyRegex = /<asy\b[^>]*>([\s\S]*?)<\/asy>/gi;
        if (!asyRegex.test(wikitext)) return wikitext;

        const byContent = new Map();
        for (const tag of rendered?.match(/<img\b[^>]*>/gi) ?? []) {
            const alt = tag.match(
                /\balt\s*=\s*["'](\[asy\][\s\S]*?\[\/asy\])["']/i,
            )?.[1];
            if (!alt) continue;
            const src = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1];
            if (!src) continue;
            const content = CleanupText._decodeHtmlEntities(alt)
                .replace(/^\[asy\]\s*/i, "")
                .replace(/\s*\[\/asy\]$/i, "")
                .replace(/\s+/g, " ")
                .trim();
            if (!byContent.has(content)) {
                byContent.set(
                    content,
                    src.startsWith("http") ? src : "https:" + src,
                );
            }
        }

        return wikitext.replace(asyRegex, (_, content) => {
            const normalized = content.replace(/\s+/g, " ").trim();
            const url = byContent.get(normalized);
            return url
                ? `[asy=${url}]${content}[/asy]`
                : `[asy]${content}[/asy]`;
        });
    }

    // AoPS wiki wraps LaTeX in <math>/<imath> (inline) and <cmath> (display)
    // tags, whereas the forum uses $…$/$$…$$. Normalize wiki math to the dollar
    // form so the forum-oriented helpers (extractChoices, cleanChoices, getBoxed)
    // work unchanged. `<cmath>` -> `$$`, inline `<math>`/`<imath>` -> `$`.
    static normalizeWikiMath(str) {
        return str
            .replace(/<\s*cmath\b[^>]*>/gi, "$$$$")
            .replace(/<\s*\/\s*cmath\s*>/gi, "$$$$")
            .replace(/<\s*i?math\b[^>]*>/gi, "$")
            .replace(/<\s*\/\s*i?math\s*>/gi, "$");
    }

    // MediaWiki analog of cleanProblem: strips wiki markup that isn't part of the
    // problem statement — {{templates}}, [[Category:…]] tags, wikilinks (kept as
    // their label/target text), stray ==headers==, and the trailing
    // ==See Also==/==Video Solution==/==Solution== sections (defensive; the
    // statement is usually fetched as section 0). Converts <asy> diagrams first
    // when the rendered HTML is available. Returns the trimmed statement.
    static cleanWikiProblem(str, rendered = null) {
        let s = CleanupText.normalizeWikiMath(str);

        // Convert Asymptote diagrams before we strip anything else.
        if (/<asy\b/i.test(s)) {
            s = CleanupText.toWikiAsyLinks(s, rendered);
        }

        // Cut off everything from the first solution/see-also/video header on.
        s = s.replace(
            /\n=+\s*(?:Solution|See\s*Also|Video\s*Solution|Notes?)\b[\s\S]*$/i,
            "",
        );

        s = s
            // {{AMC10 box}}, {{duplicate|…}}, {{stub}}, etc. (single level).
            .replace(/\{\{[^{}]*\}\}/g, "")
            // [[Category:…]] tags.
            .replace(/\[\[Category:[^\]]*\]\]/gi, "")
            // [[target|label]] -> label ; [[target]] -> target.
            .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
            .replace(/\[\[([^\]]*)\]\]/g, "$1")
            // Any remaining wiki section headers.
            .replace(/^\s*=+[^=\n]*=+\s*$/gm, "")
            // MediaWiki magic words.
            .replace(/__[A-Z]+__/g, "")
            .trim();

        return s;
    }

    static checkContainsMultiple(str, startN = 1, loose = false) {
        if (loose) {
            str = str.replace(/^\[i\].*?\[\/i\]/i, "");
        }
        let theRegex = null;
        for (let i = 0; i < this.multiLineRegexes.length; i++) {
            if (this.multiLineRegexes[i].regex.test(str)) {
                theRegex = this.multiLineRegexes[i];
                break;
            }
        }
        if (theRegex === null) return [];

        let lines = str
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "");
        let statements = [];
        let n = 0;
        let text = "";
        for (let i = 0; i < lines.length; ++i) {
            let match = lines[i].match(theRegex.line(startN + n));
            if (!match) {
                text += "\n" + lines[i];
            } else {
                if (statements.length > 0) {
                    statements[statements.length - 1] += text;
                }
                statements.push(match[theRegex.index]);
                text = "";
                n++;
            }
        }
        if (statements.length > 0) {
            statements[statements.length - 1] += this.removePSHideAns(text);
        }
        return statements;
    }

    // Locate one ordered answer-choice block (at least A-C). AMC uses A-E, but
    // the shared helper also supports contests with three or four options.
    // AoPS's current markup uses
    // `\textbf{(A)}`, but older wiki/forum pages commonly use `\text{(A)}`,
    // `\mathrm{(A)}`, `\textrm{(A)}`, or `(\mathrm{A})`. Match the structure
    // rather than one spelling. Asymptote bodies are masked first so diagram
    // labels such as `label("(A)", ...)` are not mistaken for textual choices.
    static _choiceBlock(input) {
        if (!input) return null;
        const masked = input
            .replace(/\[asy(?:=[^\]]*)?\][\s\S]*?\[\/asy\]/gi, (s) =>
                " ".repeat(s.length),
            )
            .replace(/<asy\b[^>]*>[\s\S]*?<\/asy>/gi, (s) =>
                " ".repeat(s.length),
            );
        const wrapper = String.raw`(?:textbf|text|textrm|mathrm)`;
        const innerSpace = String.raw`(?:\s|\\[ ,;:!]|\\q?quad\b)*`;
        const marker = new RegExp(
            String.raw`\\${wrapper}\s*\{\s*\(\s*([A-E])\s*\)${innerSpace}\}|\\${wrapper}\s*\{\s*\(\s*([A-E])\s*\)|\(\s*\\${wrapper}\s*\{\s*([A-E])${innerSpace}\}\s*\)|\\textbf\s*\{\s*([A-E])\s*\}|\{?\s*\(\s*([A-E])\s*\)\s*\}?`,
            "g",
        );
        const matches = [...masked.matchAll(marker)].map((m) => ({
            label: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5],
            index: m.index,
            end: m.index + m[0].length,
            // Some old pages put both the label and value inside one style
            // wrapper: `\mathrm{(A) 4}`. Its closing brace belongs to the
            // wrapper, not to the choice value.
            closesAfterValue: m[2] != null,
        }));

        for (let start = 0; start < matches.length; start++) {
            if (matches[start].label !== "A") continue;
            const block = [matches[start]];
            for (let i = start + 1; i < matches.length; i++) {
                if (matches[i].label !== "ABCDE"[block.length]) break;
                block.push(matches[i]);
                if (block.length === 5) break;
            }
            if (block.length >= 3) return block;
        }
        return null;
    }

    static extractChoices(input) {
        const block = CleanupText._choiceBlock(input);
        if (!block) return [];

        return block.map((match, i) => {
            const end = i + 1 < block.length ? block[i + 1].index : input.length;
            let value = input
                .slice(match.end, end)
                .replace(/\n[\s\S]*$/, "")
                // Strip the LaTeX spacing macros AoPS puts after a label. A real
                // value like `\frac{3}{10}` is deliberately kept.
                .replace(
                    /^(?:\s|\\[ ,;:!]|\\q?quad\b|\\qqua\b|\\hspace\*?\s*\{[^{}]*\})+/,
                    "",
                )
                .replace(/^\\(\d+)/, "$1");
            if (match.closesAfterValue) {
                value = value.replace(
                    /\}(?=(?:\s|\\q?quad\b|\\\\|\${1,2})*$)/,
                    "",
                );
            }
            return value
                // Strip separators and closing math delimiters from the value.
                .replace(
                    /(?:\s|\\q?quad\b|\\qqua\b|\\hspace\*?\s*\{[^{}]*\}|\\\\|\${1,2})+$/,
                    "",
                )
                .trim();
        });
    }

    // Once a choice block is found, remove presentation tokens that opened the
    // block immediately before its (A) marker. Slicing at the marker alone
    // strands prefixes such as `\[`, `${{`, `$\displaystyle`, or
    // `$\hspace*{5mm}` at the end of the problem statement.
    static _stripUnmatchedTrailingDollar(str) {
        const clean = str.trimEnd();
        const run = /(?<!\\)(\$+)$/.exec(clean)?.[1] ?? "";
        if (!run) return clean;

        let singleCount = 0;
        let doubleCount = 0;
        for (let i = 0; i < clean.length; i++) {
            if (clean[i] !== "$" || (i > 0 && clean[i - 1] === "\\")) continue;
            if (clean[i + 1] === "$") {
                doubleCount++;
                i++;
            } else {
                singleCount++;
            }
        }

        // An odd trailing run ends in a single-dollar delimiter; an even run
        // ends in a display delimiter. Remove it only when that delimiter is
        // unmatched in the prefix, meaning it opened the choice block. A
        // balanced closing `$` belonging to the question is preserved.
        if (run.length % 2 === 1 && singleCount % 2 === 1) {
            return clean.slice(0, -1).trimEnd();
        }
        if (run.length % 2 === 0 && doubleCount % 2 === 1) {
            return clean.slice(0, -2).trimEnd();
        }
        return clean;
    }

    static _stripChoiceBlockPrefix(prefix) {
        let clean = prefix.trimEnd();
        let previous;
        do {
            previous = clean;
            clean = clean
                .replace(/\\hspace\*?\s*\{[^{}]*\}\s*$/, "")
                .replace(/\\q?quad\b\s*$/, "")
                .replace(/\\(?:displaystyle|mathbf)\b\s*$/, "")
                .replace(/\[b\]\s*$/i, "")
                .replace(/<center>\s*$/i, "")
                .replace(/\\begin\s*\{center\}\s*$/i, "")
                .replace(/\{\s*$/, "")
                .replace(/\\\[\s*$/, "")
                .trimEnd();
            clean = CleanupText._stripUnmatchedTrailingDollar(clean);
        } while (clean !== previous);
        return clean.trim();
    }

    // Repair a distinctive opening token left by an older cleanup even when
    // the old statement no longer contains choice A. This intentionally omits
    // a bare trailing `$`, which could legitimately close math in the question.
    static _stripOrphanedChoicePrefix(str) {
        const clean = str.trimEnd();
        const orphan =
            /(?:\\\[|\$\s*\{+|\$\s*\\(?:displaystyle|mathbf)\b|\$?\s*\\hspace\*?\s*\{[^{}]*\}|\$?\s*\\q?quad\b|\[b\])\s*$/i;
        return orphan.test(clean)
            ? CleanupText._stripChoiceBlockPrefix(clean)
            : clean.trim();
    }

    // Some rows were partially cleaned by an older parser: the complete choice
    // array survived, but the statement was truncated after choice A. Only use
    // this recovery when the remaining suffix normalizes to the stored first
    // choice; ordinary mentions of `(A)` are therefore left untouched.
    static _danglingFirstChoiceStart(str, choices) {
        if (!Array.isArray(choices) || choices.length < 3) return -1;
        const masked = str
            .replace(/\[asy(?:=[^\]]*)?\][\s\S]*?\[\/asy\]/gi, (s) =>
                " ".repeat(s.length),
            )
            .replace(/<asy\b[^>]*>[\s\S]*?<\/asy>/gi, (s) =>
                " ".repeat(s.length),
            );
        const marker =
            /\\(?:textbf|text|textrm|mathrm)\s*\{\s*\(\s*A\s*\)(?:\s|\\[ ,;:!]|\\q?quad\b)*\}|\\(?:textbf|text|textrm|mathrm)\s*\{\s*\(\s*A\s*\)|\(\s*\\(?:textbf|text|textrm|mathrm)\s*\{\s*A\s*\}\s*\)/g;
        const matches = [...masked.matchAll(marker)];
        if (!matches.length) return -1;
        const match = matches[matches.length - 1];
        const tail = str
            .slice(match.index + match[0].length)
            .replace(/^(?:\s|\\[ ,;:!]|\\q?quad\b)+/, "")
            // Historical cache entries sometimes end midway through `\qquad`.
            .replace(/(?:\s|\\q(?:quad|qua|qu|q)?\b|\${1,2})+$/, "")
            .trim();
        return CleanupText.normalizeAnswer(tail) ===
            CleanupText.normalizeAnswer(choices[0])
            ? match.index
            : -1;
    }

    static cleanChoices(str, knownChoices = null) {
        const block = CleanupText._choiceBlock(str);
        if (block) {
            return CleanupText._stripChoiceBlockPrefix(
                str.slice(0, block[0].index),
            );
        }
        const danglingStart = CleanupText._danglingFirstChoiceStart(
            str,
            knownChoices,
        );
        if (danglingStart >= 0) {
            return CleanupText._stripChoiceBlockPrefix(
                str.slice(0, danglingStart),
            );
        }
        return Array.isArray(knownChoices) && knownChoices.length >= 3
            ? CleanupText._stripOrphanedChoicePrefix(str)
            : str.trim();
    }

    static parseMCQAns(input) {
        if (!input) return null;
        let text = input.replace(/\\textbf\{([^}]+)\}/g, "$1").trim();
        let letterMatch = text.match(/\b\(?([A-E])\)?[\.\)]?\b/i);
        if (letterMatch) {
            return { type: "letter", value: letterMatch[1].toUpperCase() };
        }
        return { type: "text", value: text };
    }

    static extractYear(s) {
        let match = s.match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    // Identifying section headers we fold into the test name when a category
    // has a single section (see ForumSession._normalizeSections). AoPS often
    // labels a one-section test only by its header ("High School", "Middle
    // School", "... A"/"... B") — that header carries identity we want in the
    // name. Other single-section headers (e.g. "30 problems, 90 minutes") are
    // noise and return null so the section is simply dropped. Returns the
    // canonical label to append, or null.
    static extractSectionLabel(sectionName) {
        if (!sectionName) return null;
        const s = sectionName.trim();
        if (/middle\s*school/i.test(s)) return "Middle School";
        if (/high\s*school/i.test(s)) return "High School";
        // "A"/"B" test/version identifiers (e.g. an AMC 10 A vs. B split that
        // AoPS files as a single-section category). Kept conservative: the
        // header must be essentially just the letter, optionally prefixed by
        // Test/Version/Round/Paper/Contest.
        const ab = s.match(
            /^(?:(?:test|version|round|paper|contest)\s+)?\(?([AB])\)?$/i,
        );
        if (ab) return ab[1].toUpperCase();
        return null;
    }

    static MONTHS = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    ];

    // Parses an AoPS administration-date section header ("February 3rd",
    // "November 16, 2022", "December 2nd") into a month/day-sortable number,
    // or null if the header is not a date. The year is deliberately ignored:
    // these headers only ever order sections within one year's category, and a
    // category's sections are always the same season.
    static parseAdministrationDate(label) {
        const m = String(label ?? "")
            .trim()
            .match(
                /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*\d{4})?$/i,
            );
        if (!m) return null;
        return (this.MONTHS.indexOf(m[1].toLowerCase()) + 1) * 100 + Number(m[2]);
    }

    // A/B (and, in 2002, P) are versions of one contest, not rounds of it.
    static VERSION_LETTERS = ["A", "B", "P"];

    // Resolves a category's section headers to canonical version letters, or
    // null if they are not a version split at all (a mock AIME's named rounds,
    // a shortlist appendix — those must keep their own labels).
    //
    // Resolution is scoped to the whole category rather than applied to each
    // header on its own, because neither position nor the label alone is
    // sufficient. An explicit letter is authoritative wherever it appears —
    // AoPS does not always list the versions in order (2011 AMC 12 files B
    // first). Date headers then take the letters no explicit label claimed, in
    // administration order. A fixed calendar cutoff cannot substitute for that
    // ordering: the A/B split date moves year to year (2021's A was February
    // 4th and its B February 10th, but 2015's A was February 3rd).
    static resolveVersionSections(sections) {
        const labels = (sections ?? []).map((s) => String(s ?? "").trim());
        if (labels.length < 2 || labels.length > this.VERSION_LETTERS.length) {
            return null;
        }

        const resolved = new Array(labels.length).fill(null);
        const taken = new Set();
        const dated = [];

        labels.forEach((label, i) => {
            const letter = label
                .match(/^\(?([ABP])\)?$/i)?.[1]
                ?.toUpperCase();
            if (letter) {
                // A repeated letter means these are not clean version labels.
                if (taken.has(letter)) return;
                resolved[i] = letter;
                taken.add(letter);
                return;
            }
            const date = this.parseAdministrationDate(label);
            if (date != null) dated.push({ i, date });
        });

        // Every section must have resolved to a letter or parsed as a date.
        const letterCount = resolved.filter((r) => r !== null).length;
        if (letterCount + dated.length !== labels.length) return null;

        const free = this.VERSION_LETTERS.filter((l) => !taken.has(l));
        if (dated.length > free.length) return null;

        dated.sort((a, b) => a.date - b.date);
        dated.forEach(({ i }, k) => {
            resolved[i] = free[k];
        });

        return resolved;
    }

    // Joins a test name to its section label to form the section test's name.
    // Normally a space, but a version letter on an AMC is spelled closed up
    // ("2015 AMC 10" + "A" -> "2015 AMC 10A"). That is the wiki's spelling, and
    // therefore the one both sources have to produce for a scraped test and its
    // wiki twin to merge on the (series, name, year) natural key rather than
    // landing as two rows.
    static sectionTestName(testName, sectionLabel) {
        const base = String(testName ?? "").trim();
        const label = String(sectionLabel ?? "").trim();
        if (!label) return base;
        if (/^[ABP]$/.test(label) && /\bAMC\s+\d+$/.test(base)) {
            return `${base}${label}`;
        }
        return `${base} ${label}`;
    }

    // A header stating the test's logistics rather than naming a part of it:
    // "10 problems for 75 minutes", "15 (14) problems for 2.5 hours",
    // "12 problems for 2 hours, integer answers 0-999". These head the test
    // itself, so the section they open is the test's own problems and carries
    // no name (see ForumSession._normalizeSections). Deliberately narrow: it
    // must lead with a problem count and state a duration, so round names
    // ("Team Round", "2021-22 Set 1", "High School") never match.
    static isLogisticsHeader(sectionName) {
        if (!sectionName) return false;
        return /^\d+\s*(?:\(\d+\)\s*)?problems?\b.*\b(?:minutes?|hours?|hrs?)\b/i.test(
            sectionName.trim(),
        );
    }

    // Canonicalizes AoPS category/folder names before they become series/test
    // names. Trims redundant "Problems" suffixes so names match the curated
    // registry / wiki spelling ("Purple Comet" not "Purple Comet Problems",
    // "AIME"/"2010 AIME I" not "AIME Problems"/"2010 AIME I Problems"). This is
    // what merges the forum "AIME Problems" folder onto the wiki "AIME" series.
    // Idempotent.
    static CONTEST_NAME_RENAMES = [
        [/Purple Comet Problems/gi, "Purple Comet"],
        [/(AIME(?:\s+I{1,3})?)\s+Problems/gi, "$1"],
        // Math Prize for Girls: AoPS spells "For" inconsistently and appends
        // "Problems", and the two categories scrape as descriptive folder names.
        // Fold both onto the registry spelling so PDF-imported rows (series
        // "MPFG"/"MPFG Olympiad"; tests "YYYY Math Prize for Girls[ Olympiad]")
        // merge on the (series, name, year) key. Order matters: the casing +
        // suffix fixes run first so the anchored folder rules below see "for"
        // and no "Problems". The ^…$ folder rules only fire on the bare category
        // name — the year-prefixed per-test names never match them.
        [/Math Prize For Girls/g, "Math Prize for Girls"],
        [/(Math Prize for Girls)\s+Problems\b/gi, "$1"],
        [/^\s*Math Prize for Girls Olympiad\s*$/i, "MPFG Olympiad"],
        [/^\s*Math Prize for Girls\s*$/i, "MPFG"],
    ];
    static normalizeContestName(name) {
        if (!name) return name;
        let out = name.trim();
        for (const [re, rep] of this.CONTEST_NAME_RENAMES) {
            out = out.replace(re, rep);
        }
        // AoPS sometimes leaves a dangling "-" at the end of a category name
        // (e.g. "2022 AMC 8 -"), likely a truncated leftover from a category
        // rename. It carries no identifying info, so drop it.
        out = out.replace(/\s+-+\s*$/, "");

        // Normalize space in "AMC 10 A" -> "AMC 10A", "AMC 12 A" -> "AMC 12A"
        out = out.replace(/\b(AMC\s*(?:10|12))\s+([AB])\b/gi, "$1$2");
        out = out.replace(/\bAMC\s*12\/AHSME\b/gi, "AMC 12");
        out = out.replace(/\bAMC\s*12-AHSME\b/gi, "AMC 12");

        // AMC 10/12 seasons: 2021 ran two full administrations, which AoPS
        // suffixes onto the category ("2021 AMC 12/AHSME Fall") while the wiki
        // prefixes the season and drops it for spring ("2021 Fall AMC 12A" vs
        // "2021 AMC 12A"). Fold onto the wiki spelling — without it both
        // seasons' A administrations normalize to the same name and collide on
        // the (series, name, year) natural key.
        //
        // This MUST run after the AMC 12/AHSME rewrite above, not as a
        // CONTEST_NAME_RENAMES entry: those run first, while the category is
        // still spelled "2021 AMC 12/AHSME Fall", and these anchored patterns
        // would silently miss every AMC 12 while matching every AMC 10.
        out = out.replace(/^(\d{4})\s+(AMC\s+1[02])\s+Fall\s*$/i, "$1 Fall $2");
        out = out.replace(/^(\d{4})\s+(AMC\s+1[02])\s+Spring\s*$/i, "$1 $2");

        // A date-labeled AMC 10/12 section ("February 3rd") is resolved to its
        // version letter by resolveVersionSections, not here: the label alone
        // does not carry the answer, since the A/B split date moves year to
        // year. This function only ever sees the bare category name.

        return out.replace(/\s{2,}/g, " ").trim();
    }

    static inferACGN(text) {
        const lowerCase = text
            .replace(/\[asy=.*?]\s*.*?\[\/asy]/gs, "")
            .toLowerCase()
            .trim();
        const scores = {};
        for (const mathType of this.INFER_WORDS) {
            let score = 0;
            for (const word of mathType.keywords) {
                if (lowerCase.includes(word)) score++;
            }
            scores[mathType.name] = score;
        }
        // Find highest scoring; ties go to first (K→A→C→G→N)
        let best = null;
        let bestScore = 0;
        for (const mathType of this.INFER_WORDS) {
            if (scores[mathType.name] > bestScore) {
                bestScore = scores[mathType.name];
                best = mathType.name;
            }
        }
        return best ?? TOPIC.OTHER;
    }

    static removePSHideAns(text) {
        return text.replace(/P\.?S\.?.*hide for answers.*$/i, "").trim();
    }

    // Picks the block of a multi-key post that belongs to `name`, scoring each
    // block's label by how many of its words the test name also uses. Shared by
    // both multi-key layouts ([hide=label] blocks and plain heading lines).
    // When nothing matches the name, a label that calls itself the answers wins
    // over one that doesn't (a "Scores" leaderboard is numbered from 1 too).
    static _bestLabeledBlock(blocks, name) {
        const nameWords = new Set(name?.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        const score = (label) => {
            const words = (label.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
                (w) => !["answer", "answers", "key", "for"].includes(w),
            );
            return words.filter((w) => nameWords.has(w)).length;
        };
        const namesAnswers = (label) => /\banswers?\b|\bkey\b/i.test(label);

        let best = blocks[0];
        let bestScore = -1;
        for (const block of blocks) {
            const s = score(block.label);
            const better =
                s > bestScore ||
                (s === bestScore &&
                    bestScore === 0 &&
                    namesAnswers(block.label) &&
                    !namesAnswers(best.label));
            if (better) {
                bestScore = s;
                best = block;
            }
        }
        return best;
    }

    // The labeled blocks of a post that carries several *competing* answer
    // keys — one per subtest, each restarting at 1 — in either layout AoPS
    // posters use: [hide=label] blocks, or plain heading lines. Returns [] for
    // anything else, including a key split across blocks by range
    // ("[hide=1-5]…[hide=6-10]…"), where only one block starts at 1 and the
    // blocks complete each other rather than compete.
    static _competingAnswerBlocks(content) {
        const startsAtOne = (text) => /^\s*1[.)]\s*\S/m.test(text);
        const hideRe =
            /\[hide(?:\s*=\s*"?([^\]"]*)"?)?\]([\s\S]*?)\[\/hide\]/gi;
        const hideBlocks = [...content.matchAll(hideRe)].map((m) => ({
            label: (m[1] ?? "").trim(),
            body: m[2],
        }));
        if (hideBlocks.length > 0) {
            const competing = hideBlocks.filter((b) => startsAtOne(b.body));
            return competing.length > 1 ? competing : [];
        }
        return CleanupText._labeledAnswerSections(content);
    }

    // Splits a post that stacks several numbered answer lists under plain
    // heading lines ("Algebra\n1. 3\n…\nGeometry\n1. 49\n…") into one block per
    // heading. Each list restarts at 1, so parsing the post as a single list
    // interleaves them — whichever block's entry is matched first wins for that
    // number. Returns [] unless at least two headed lists are found.
    static _labeledAnswerSections(content) {
        const lines = content.split("\n");
        const isListStart = (l) => /^\s*1[.)]\s*\S/.test(l);
        const isListItem = (l) => /^\s*\d+[.)]\s*\S/.test(l);

        const sections = [];
        for (let i = 0; i < lines.length; i++) {
            if (!isListStart(lines[i])) continue;
            // The heading is the nearest non-empty line above the list, with
            // its BBCode stripped ("[b] Answers [/b]" → "Answers").
            let h = i - 1;
            while (h >= 0 && lines[h].trim() === "") h--;
            if (h < 0 || isListItem(lines[h])) return [];
            const label = lines[h].replace(/\[\/?[a-z]+[^\]]*\]/gi, "").trim();
            if (!label) return [];
            sections.push({ label, start: i, headingLine: h });
        }
        if (sections.length < 2) return [];

        return sections.map((s, i) => ({
            label: s.label,
            body: lines
                .slice(
                    s.start,
                    i + 1 < sections.length
                        ? sections[i + 1].headingLine
                        : lines.length,
                )
                .join("\n"),
        }));
    }

    static parseAnswerKey(content, name = null) {
        // Narrow a multi-key post to the one key that belongs to `name` before
        // parsing anything: the format cascade below scans the whole post and
        // keeps the first entry it finds per number, so competing keys would
        // otherwise interleave. Falls back to the whole post whenever the
        // chosen block yields nothing, so a mis-split can only lose the
        // improvement, never an existing key.
        const blocks = CleanupText._competingAnswerBlocks(content);
        if (blocks.length > 1) {
            const chosen = CleanupText._bestLabeledBlock(blocks, name);
            const scoped = CleanupText._parseOneAnswerKey(chosen.body, name);
            if (scoped) return scoped;
        }
        return CleanupText._parseOneAnswerKey(content, name);
    }

    static _parseOneAnswerKey(content, name = null) {
        const result = {};

        // Extract hide tag contents, keeping the [hide=label] label so that a
        // post carrying several answer keys can be disambiguated by `name`.
        const hideRe =
            /\[hide(?:\s*=\s*"?([^\]"]*)"?)?\]([\s\S]*?)\[\/hide\]/gi;
        const hideBlocks = [...content.matchAll(hideRe)].map((m) => ({
            label: (m[1] ?? "").trim(),
            body: m[2],
        }));
        const hideSegments = hideBlocks.map((b) => b.body);

        // A real answer key is numbered 1..N with no gaps. Requiring that before
        // short-circuiting keeps a partial match (e.g. only the lines whose
        // values are short enough for Format A, or a stray trailing "4. 8")
        // from pre-empting the more general formats below.
        const isContiguousFrom1 = (m) => {
            const n = Object.keys(m).length;
            if (n === 0) return false;
            for (let i = 1; i <= n; i++) if (!m[String(i)]) return false;
            return true;
        };

        // Format A: numbered list on full content + inside hide tags
        const numberedRe = /^\s*(\d+)[.)]\s+([A-Ea-e]|\d{1,3})\s*$/gm;
        for (const text of [content, ...hideSegments]) {
            for (const m of text.matchAll(numberedRe)) {
                if (!result[m[1]]) result[m[1]] = m[2].toUpperCase();
            }
        }
        if (isContiguousFrom1(result)) return result;

        // Format A2: numbered list with $...$ math answers, e.g.
        //   "4. $\frac{17}{6}$" or "5. $310-320$". Keeps the LaTeX verbatim
        //   (no uppercasing) and stops at the first non-matching line.
        const numberedMathRe = /^\s*(\d+)[.)]\s*\$([\s\S]+?)\$\s*[.;]?\s*$/gm;
        for (const text of [content, ...hideSegments]) {
            for (const m of text.matchAll(numberedMathRe)) {
                if (!result[m[1]]) result[m[1]] = m[2].trim();
            }
        }
        if (isContiguousFrom1(result)) return result;

        // Format C: general numbered list with free-form answers that may carry
        // a " | author" annotation, e.g. "3. 1018081 | james4l", "9. 11/18 | …".
        // When the post holds several [hide=label] answer keys (e.g. one per
        // subtest), pick the block whose label best matches `name`.
        const cleanAns = (s) => {
            let v = s
                .replace(/\s+\|\s+.*$/, "") // drop " | author" annotations
                .trim()
                .replace(/^\$(.+)\$$/, "$1") // unwrap $…$
                .trim();
            if (/^[a-e]$/i.test(v)) v = v.toUpperCase();
            return v;
        };
        const parseBlock = (text) => {
            const map = {};
            for (const m of text.matchAll(/^\s*(\d+)[.)]\s+(\S.*?)\s*$/gm)) {
                if (!map[m[1]]) map[m[1]] = cleanAns(m[2]);
            }
            // Only treat as an answer list when it starts at 1 with a few
            // entries, so stray "1. …" prose lines don't masquerade as a key.
            return map["1"] && Object.keys(map).length >= 3 ? map : {};
        };

        const blockMaps = hideBlocks
            .map((b) => ({ label: b.label, map: parseBlock(b.body) }))
            .filter((b) => Object.keys(b.map).length > 0);

        if (blockMaps.length > 0) {
            const chosen =
                blockMaps.length > 1
                    ? CleanupText._bestLabeledBlock(blockMaps, name)
                    : blockMaps[0];
            return chosen.map;
        }

        // No hide block held a list — try the full content as one block.
        const fullMap = parseBlock(content);
        if (Object.keys(fullMap).length > 0) return fullMap;

        // Format B: A-E letter block — packed ("DBBBC") or spaced ("D B B B C")
        // Try hide segments first; fall back to full content only if no hide tags present
        const formatBTargets =
            hideSegments.length > 0 ? hideSegments : [content];
        for (const text of formatBTargets) {
            const letterSeq = [];
            let started = false;
            for (const line of text.split("\n")) {
                const t = line.trim();
                if (/^[A-Ea-e]+(\s+[A-Ea-e]+)*$/.test(t)) {
                    for (const token of t.split(/\s+/)) {
                        for (const ch of token)
                            letterSeq.push(ch.toUpperCase());
                    }
                    started = true;
                } else if (started && t === "") {
                    // blank line between groups — keep going
                } else if (started) {
                    break;
                }
            }
            if (letterSeq.length >= 5) {
                for (let i = 0; i < letterSeq.length; i++) {
                    result[String(i + 1)] = letterSeq[i];
                }
                break;
            }
        }

        return Object.keys(result).length > 0 ? result : null;
    }

    static makeBBCodeRegex(tag) {
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const item = `\\[${escapedTag}\\](p?\\d+\\.?)\\[/${escapedTag}\\]\\s+.+`;
        const sep = `(\\n\\s*\\n|\\n)`;
        const pattern = `^\\s*(${item})${sep}(${item})(?:${sep}(${item}))*$`;
        return new RegExp(pattern, "s");
    }

    static allBBCodeRegex(tag) {
        return {
            regex: this.makeBBCodeRegex(tag),
            line: function (number) {
                const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const pattern = `^\\[${escapedTag}\\](p?${number}\\.?)\\[/${escapedTag}\\]\\s*(.+)$`;
                return new RegExp(pattern);
            },
            index: 2,
        };
    }

    static {
        this.multiLineRegexes.push(this.allBBCodeRegex("b"));
    }
}
