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

    static parseAnswerKey(content) {
        const result = {};

        // Extract hide tag contents
        const hideRe = /\[hide[^\]]*\]([\s\S]*?)\[\/hide\]/gi;
        const hideSegments = [...content.matchAll(hideRe)].map((m) => m[1]);

        // Format A: numbered list on full content + inside hide tags
        const numberedRe = /^\s*(\d+)[.)]\s+([A-Ea-e]|\d{1,3})\s*$/gm;
        for (const text of [content, ...hideSegments]) {
            for (const m of text.matchAll(numberedRe)) {
                if (!result[m[1]]) result[m[1]] = m[2].toUpperCase();
            }
        }
        if (Object.keys(result).length > 0) return result;

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
