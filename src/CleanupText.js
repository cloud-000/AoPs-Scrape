export class CleanupText {
    static multiNregex = /^\s*(\d+\.\s+.+)(\n\s*\n|\n)(\d+\.\s+.+)(?:\n\s*\n|\n(\d+\.\s+.+))*$/s
    static imgAsyRegex = /<img\b[^>]*\bclass\s*=\s*["']asy-image["'][^>]*>/gi
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
                .replace(/\[i\][^\[]*?proposed by [^\[]*?\[\/i\]/gi, "")
                .trim()
    }
    static toAsyLinks(normal, rendered) {
        let matches = rendered.match(CleanupText.imgAsyRegex)?.map(e => "https:" + e.match(/src=["']([^"']*)["']/i)?.[1])
        let count = 0
        return normal.replace(/\[asy\](.*?)\[\/asy\]/gis, (_, content) => {
            count++;
            return `[asy=${matches[count - 1]}]${content}[/asy]`;
        })
    }
    static checkContainsMultiple(str, startN=1) {
        if (CleanupText.multiNregex.test(str)) {
            let lines = str.split("\n").map(l => l.trim()).filter(l => l !== "")
            let statements = []
            let n = 0
            let text = ""
            for (let i = 0; i < lines.length; ++i) {
                                                            //                 ^(?:p${num}|${num})\\.\\s*(.+)
                let match = lines[i].match(new RegExp(`^(?:p${startN + n}|${startN + n})\\.\\s*(.+)$`))

                if (!match) {
                    text += "\n" + lines[i]
                } else {
                    if (statements.length > 0) {
                        statements[statements.length - 1] += text
                    }
                    statements.push(match[1])
                    text = ""
                    n++
                }
            }
            if (statements.length > 0) {
                statements[statements.length - 1] += text
            }
            return statements
        }
        return []
    }
    static extractChoices(input) {
        // Regex to match \textbf{(A)} ... \textbf{(E)}
        // \\dfrac{799}{2}\\qquad
        const choiceRegex = /\\textbf\{\(([A-E])\)\s*\}/
        let parts = input.split(choiceRegex).slice(1);
        let choices =  []
        for (let i = 0; i < parts.length; ++i) {
            if (i%2 == 1) {
                choices.push(parts[i]
                    .replace(/\\qquad\s*$/, "")
                    .replace(/^\\/, "")
                    .replace(/\n[\s\S]*$/, "")
                    .replace(/\${1,2}$/, "")
                    .trim()
                )

            }
        }
        return choices;
    }
    static cleanChoices(str) {
        return str
            .replace(/\\textbf\{\([A-E]\)\}[\s\S]*/, "")
            .replace(/\${1,2}\s*$/, "")
            .trim()
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
    static parseForum(posts, rules, f) {
        let tests = {}
        let currentRule
        let n
        let name
        for (let i = 0; i < posts.length; i++) {
            let post = posts[i];
            currentRule = null
            for (let rule of rules) {
                if (rule.regex.test(post.topic_title)) {
                    let matches = rule.regex.match(post.topic_title)
                    matches = rule.matches.map(j => matches[j])
                    n = rule.n ? rule.n.apply(null, [matches]) : matches[0]
                    name = rule.name.apply(null, [matches, CleanupText.extractYear(post["category_name"])])
                    currentRule = rule
                    break
                }
            }
            if (currentRule == null) {
                continue;
            }
            if (!tests[name]) {
                tests[name] = {problems: []}
            }
            if (n == null) {
                // test[name].push(f.getProblem())
            }

        }
        return tests
    }
}