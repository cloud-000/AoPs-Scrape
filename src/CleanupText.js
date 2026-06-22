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
            name: "A",
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
            name: "C",
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
            name: "G",
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
            name: "N",
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

    static extractChoices(input) {
        const choiceRegex = /\\textbf\s*\{\s*\(([A-E])\s*\)\s*\}/;
        let parts = input.split(choiceRegex).slice(1);
        let choices = [];
        for (let i = 0; i < parts.length; ++i) {
            if (i % 2 === 1) {
                choices.push(
                    parts[i]
                        .replace(/\\qquad\s*$/, "")
                        .replace(/^\\(\d+)/, "$1")
                        .replace(/\n[\s\S]*$/, "")
                        .replace(/\${1,2}$/, "")
                        .trim(),
                );
            }
        }
        return choices;
    }

    static cleanChoices(str) {
        let clean = str.trim();
        let matches = [
            ...str.matchAll(/\\textbf\s*{\s*\(\s*[A-E]\s*\)\s}[\s\S]*?/g),
        ];
        if (matches.length > 3) {
            clean = clean
                .slice(0, matches[0].index - 1)
                .replace(/\${1,2}\s*$/, "");
        }
        return clean;
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
        // Find highest scoring; ties go to first (A→C→G→N)
        let best = null;
        let bestScore = 0;
        for (const mathType of this.INFER_WORDS) {
            if (scores[mathType.name] > bestScore) {
                bestScore = scores[mathType.name];
                best = mathType.name;
            }
        }
        return best ?? "O";
    }

    static removePSHideAns(text) {
        return text.replace(/P\.?S\.?.*hide for answers.*$/i, "").trim();
    }

    static parseAnswerKey(content, name = null) {
        const result = {};

        // Extract hide tag contents, keeping the [hide=label] label so that a
        // post carrying several answer keys can be disambiguated by `name`.
        const hideRe = /\[hide(?:\s*=\s*"?([^\]"]*)"?)?\]([\s\S]*?)\[\/hide\]/gi;
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
            let chosen = blockMaps[0];
            if (blockMaps.length > 1 && name) {
                const nameWords = new Set(
                    name.toLowerCase().match(/[a-z0-9]+/g) ?? [],
                );
                let bestScore = -1;
                for (const b of blockMaps) {
                    const labelWords = (
                        b.label.toLowerCase().match(/[a-z0-9]+/g) ?? []
                    ).filter((w) => !["answer", "key", "for"].includes(w));
                    const score = labelWords.filter((w) =>
                        nameWords.has(w),
                    ).length;
                    if (score > bestScore) {
                        bestScore = score;
                        chosen = b;
                    }
                }
            }
            return chosen.map;
        }

        // No hide block held a list — try the full content as one block.
        const fullMap = parseBlock(content);
        if (Object.keys(fullMap).length > 0) return fullMap;

        // Format B: A-E letter block — packed ("DBBBC") or spaced ("D B B B C")
        // Try hide segments first; fall back to full content only if no hide tags present
        const formatBTargets = hideSegments.length > 0 ? hideSegments : [content];
        for (const text of formatBTargets) {
            const letterSeq = [];
            let started = false;
            for (const line of text.split("\n")) {
                const t = line.trim();
                if (/^[A-Ea-e]+(\s+[A-Ea-e]+)*$/.test(t)) {
                    for (const token of t.split(/\s+/)) {
                        for (const ch of token) letterSeq.push(ch.toUpperCase());
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
