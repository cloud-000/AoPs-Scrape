import {ForumSession} from "./ForumSession.js";

export class CleanupText {
    static multiLineRegexes = [
        {
            regex:
                /^\s*(\d+\.\s+.+)(\n\s*\n|\n)(\d+\.\s+.+)(?:\n\s*\n|\n(\d+\.\s+.+))*$/s,
            line: (n) => {
                return new RegExp(`^(?:p${n}|${n})\\.\\s*(.+)$`)
            },
            index: 1,
        }
    ]
    static imgAsyRegex = /<img\b[^>]*\bclass\s*=\s*["']asy-image["'][^>]*>/gi
    static INFER_WORDS = [
        {
            "name": "A",
            "keywords": [
                "real number",
                "complex number",
                "coefficient",
                "expansion",
                "y =",
                "y=",
                "x^2",
                "polynomial"
            ]
        },
        {
            "name": "C",
            "keywords": [
                // but then AIME extraction
                "probability",
                "number of ways",
                "how many",
                "rearranged",
                "expected value",
                "expected sum",
                "identical",
                "permutation",
                "palindrome"
            ]
        },
        {
            "name": "G",
            "keywords": [
                "circle",
                "radius",
                "ellipse",
                "triangle",
                "rectangle",
                "polygon",
                "intersects",
                "plane",
                "points",
                "area",
                "equilateral",
                "isosceles",
                "scalene",
                "vertex",
                "vertice",
                "diagonal",
                "congruent",
                "vertical",
                "horizontal",
                "parallel",
                "concurrent",
                "co-centric",
                "collinear",
                "\\circ",
                "midpoint",
                "\\angle",
                "convex",
                "concave"
            ]
        },
        {
            "name": "N",
            "keywords": [
                "integer",
                "divisor",
                "whole number",
                "lcm",
                "gcd",
                "digits",
                "integers",
                "factor",
                "perfect square"
            ]
        },
    ]
    static formatLatex (string) {
        return string
            .replace(/&#160;/g, " ")
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/^\$|\$$|\\\[|\\\]/g, "")
            .replace(/&lt;/g, "\\lt ")
            .replace(/&gt;/g, "\\gt ")
            .replace(/\$/g, "\\$$")
            .replace(/align\*/g, "aligned")
            .replace(/eqnarray\*/g, "aligned")
            .replace(/{tabular}(\[\w\])*/g, "{array}")
            .replace(/\\bold{/g, "\\mathbf{")
            .replace(/\\congruent/g, "\\cong")
            .replace(/\\overarc/g, "\\overgroup")
            .replace(/\\overparen/g, "\\overgroup")
            .replace(/\\underarc/g, "\\undergroup")
            .replace(/\\underparen/g, "\\undergroup")
            .replace(/\\mathdollar/g, "\\$")
            .replace(/\\textdollar/g, "\\$")
    }
    static sanitize(string) {
        return string
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
    }
    static buildNestedPattern(depth) {
        let pattern = "[^{}]*"

        for (let i = 0; i < depth; i++) {
            pattern = `(?:[^{}]|\\{${pattern}\\})*` // still needs \{ and \} in regex
        }

        // Use String.raw so backslashes are literal
        return String.raw`\\boxed{(${pattern})}`
    }

    static getBoxed(str, depth = 3) {
        let regex = new RegExp(CleanupText.buildNestedPattern(depth))
        let match = str.match(regex)
        return match ? match[1] : null
    }
    static cleanProblem(str) {
        return str
                .replace(/^\[b\]Problem #\d+:\[\/b\]\s*/i, "")
                .replace(/\[i\][^\[]*?[pP]roposed by [^\[]*?\[\/i\]/gi, "")
                .trim()
    }
    /*
    Let $\theta$ be a real number in the open interval $(0, \pi)$ such that $\cot(3\theta)=2/11$. Then $\sin(\theta)+\cos(\theta)=\frac{a\sqrt b}{c}$ for integers $a, b,$ and $c$, with $\gcd(a,c)=1$ and $b$ not divisible by the square of any prime. Compute $a+b+c$.

$
\textbf{(A) }8 \qquad
\textbf{(B) }10 \qquad
\textbf{(C) }13 \qquad
\textbf{(D) }17  \qquad
\textbf{(E) }22 \qquad
$

[i]Proposed by [b]AOPS12142015[/b][/i]
     */
    static toAsyLinks(normal, rendered) {
        let matches = rendered.match(CleanupText.imgAsyRegex)?.map(e => "https:" + e.match(/src=["']([^"']*)["']/i)?.[1])
        let count = 0
        return normal.replace(/\[asy\](.*?)\[\/asy\]/gis, (_, content) => {
            count++;
            return `[asy=${matches[count - 1]}]${content}[/asy]`;
        })
    }
    static checkContainsMultiple(str, startN=1, loose=false) {
        if (loose) {
            str = str.replace(/^\[i\].*?\[\/i\]/i, ''); // replace any [i] tag the beginning
        }
        let theRegex = null
        for (let i = 0; i < this.multiLineRegexes.length; i++) {
            if (this.multiLineRegexes[i].regex.test(str)) {
                theRegex = this.multiLineRegexes[i]
                break;
            }
        }
        if (theRegex !== null) {
            let lines = str.split("\n").map(l => l.trim()).filter(l => l !== "")
            let statements = []
            let n = 0
            let text = ""
            for (let i = 0; i < lines.length; ++i) {
                let match = lines[i].match(theRegex.line(startN + n))
                if (!match) {
                    text += "\n" + lines[i]
                } else {
                    if (statements.length > 0) {
                        statements[statements.length - 1] += text
                    }
                    statements.push(match[theRegex.index])
                    text = ""
                    n++
                }
            }
            if (statements.length > 0) {
                statements[statements.length - 1] += this.removePSHideAns(text);
            }
            return statements
        }
        return []
    }
    static extractChoices(input) {
        // Regex to match \textbf{(A)} ... \textbf{(E)}
        // \\dfrac{799}{2}\\qquad
        const choiceRegex = /\\textbf\s*\{\s*\(([A-E])\s*\)\s*\}/
        let parts = input.split(choiceRegex).slice(1);
        let choices =  []
        for (let i = 0; i < parts.length; ++i) {
            if (i%2 == 1) {
                choices.push(parts[i]
                    .replace(/\\qquad\s*$/, "")
                    .replace(/^\\(\d+)/, "$1")
                    .replace(/\n[\s\S]*$/, "")
                    .replace(/\${1,2}$/, "")
                    .trim()
                )
            }
        }
        return choices;
    }
    static cleanChoices(str) {
        let clean = str
            // .replace(/\\textbf\{\([A-E]\)\}[\s\S]*/, "")
            // .replaceAll(/\\textbf{\s*\(\s*[A-E]\s*\)\s}[\s\S]*?/g, "")
            .trim()
        let matches = [...str.matchAll(/\\textbf\s*{\s*\(\s*[A-E]\s*\)\s}[\s\S]*?/g)]
        if (matches.length > 3) {
            // let lastMatch = matches[matches.length - 1]
            clean = clean.slice(0, matches[0].index - 1).replace(/\${1,2}\s*$/, "")
        }
        return clean//.replaceAll(/\\textbf{\s*\(\s*[A-E]\s*\)\s}[\s\S]*?/g, "").trim()
    }
    static parseMCQAns(input) {
        if (!input) return null;

        // 1. Normalize (remove LaTeX bold, trim)
        let text = input
            .replace(/\\textbf\{([^}]+)\}/g, '$1')
            .trim();
        // 2. Try to extract letter (A-E)
        let letterMatch = text.match(/\b\(?([A-E])\)?[\.\)]?\b/i);

        if (letterMatch) {
            return {
                type: "letter",
                value: letterMatch[1].toUpperCase()
            };
        }

        // 3. Otherwise return full answer text
        return {
            type: "text",
            value: text
        };
    }
    static unescape(str) {
        return str
            .replace(/\\n/g, '\n') // Newlines
            .replace(/\\t/g, '\t') // Tabs
            .replace(/\\"/g, '"')  // Double quotes
            .replace(/\\'/g, "'")  // Single quotes
            .replace(/\\\\/g, '\\'); // Backslashes
    }
    static extractYear(s) {
        let match = s.match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    // TODO
    static async parseForum(posts, rules, f, type=null) {
        if (posts.length === 0) { return {}}
        let tests = {}
        let currentRule
        if (type === null) {
            type = ForumSession.inferType(posts[0]["category_name"]);
        }
        let checkPosters = Object.hasOwn(rules, "posters")
        for (let i = 0; i < posts.length; i++) {
            let post = posts[i];
            currentRule = null
            if (checkPosters && !rules.posters.includes(post["first_poster_name"])) {
                continue; // Not a valid first poster
            }
            let metadata
            for (let rule of rules.names) {
                if (rule.regex.test(post["topic_title"])) {
                    metadata = rule.metadata(post["topic_title"].match(rule.regex))
                    metadata.year = parseInt(metadata["year"], 10);
                    metadata.n = parseInt(metadata["n"], 10);
                    currentRule = rule
                    break
                }
            }
            if (currentRule == null) {
                console.log(`Unable to classify ${post["topic_title"]}`)
                continue;
            }
            if (!Object.hasOwn(tests, metadata.name)) {
                tests[metadata.name] = {
                    problems: [],
                    year: metadata.year,
                    name: metadata.name,
                }
            }
            let problem = await f.getProblem(
                CleanupText.toAsyLinks(post["posts_data"][0]["post_canonical"], post["posts_data"][0]["post_rendered"]),
                type,
                post["topic_id"]
            )
            problem.topic_id = post["topic_id"]
            problem.post_id = post["posts_data"][0]["post_id"]
            tests[metadata.name].problems.push(problem)
        }
        return {
            tests: Object.keys(tests).map(testName => {
                return {
                    name: testName,
                    tests: tests[testName].problems,
                    year: tests[testName].year,
                    computational: type.computational,
                    type: type.name,
                    id: parseInt(posts[0]["category_id"])
                }
            })
        }
    }
    // AI generated (dynamic regex):
    // Dynamic regex for any BBCode style [tag]N[/tag] numbered list
    static makeBBCodeRegex(tag) {
        // Escape special regex characters
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Pattern for a single item: [tag]Number[/tag] + text
        const item = `\\[${escapedTag}\\](p?\\d+\\.?)\\[/${escapedTag}\\]\\s+.+`;

        // Separator: newline or blank line
        const sep = `(\\n\\s*\\n|\\n)`;

        // Require at least two items, allow additional optional items
        const pattern = `^\\s*(${item})${sep}(${item})(?:${sep}(${item}))*$`;

        return new RegExp(pattern, 's'); // 's' = dotAll mode
    }
    static allBBCodeRegex(tag) {
        return {
            regex: this.makeBBCodeRegex(tag),
            line: function (number) {
                const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // Matches either N or pN, optional dot, then text
                const pattern = `^\\[${escapedTag}\\](p?${number}\\.?)\\[/${escapedTag}\\]\\s*(.+)$`;

                return new RegExp(pattern);
            },
            index: 2
        }
    }
    static {
        this.multiLineRegexes.push(this.allBBCodeRegex("b"))
    }
    static inferACGN(text) {
        let lowerCase = text.replace(/\[asy=.*?].*?\[\/asy]/gs, "").toLowerCase().trim();
        for (let mathType of this.INFER_WORDS) {
            // this.INFER_WORDS[mathType]
            for (let word of mathType.keywords) {
                if (lowerCase.includes(word)) {
                    return mathType.name
                }
            }
        }
        return "O"
    }
    static removePSHideAns(text) {
        return text.replace(/P\.?S\.?.*hide for answers.*$/i, "").trim()
    }
}