import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CleanupText } from "./CleanupText.js";

export const TEXT_AUDIT_VERSION = "text-audit-v2";

const PAIRED_BBCODE = new Set([
    "b",
    "i",
    "u",
    "s",
    "center",
    "color",
    "font",
    "hide",
    "quote",
    "size",
    "spoiler",
    "url",
]);

const COMMON_FRACTION_COMMANDS = new Set(["frac", "dfrac", "tfrac"]);

function isEscaped(text, index) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
}

function lineAndColumn(text, offset) {
    const prefix = text.slice(0, Math.max(0, offset));
    const lines = prefix.split("\n");
    return { line: lines.length, column: lines.at(-1).length + 1 };
}

function snippetAt(text, offset, end = offset + 1) {
    const radius = 45;
    const start = Math.max(0, offset - radius);
    const finish = Math.min(text.length, Math.max(end, offset + 1) + radius);
    return text
        .slice(start, finish)
        .replace(/\s+/g, " ")
        .trim();
}

function finding(text, ruleId, severity, offset, message, end = offset + 1) {
    const position = lineAndColumn(text, offset);
    return {
        ruleId,
        severity,
        confidence: severity === "error" ? "certain" : "suspicious",
        offset,
        end,
        ...position,
        snippet: snippetAt(text, offset, end),
        message,
    };
}

function maskRange(text, start, end) {
    return (
        text.slice(0, start) +
        text
            .slice(start, end)
            .replace(/[^\n]/g, " ") +
        text.slice(end)
    );
}

// Asymptote is a different language whose braces, dollar signs, and bracketed
// array syntax are not LaTeX/BBCode. Validate its wrapper, then mask only its
// body so all later offsets still point into the original string.
function maskAsymptote(text, findings) {
    const token = /\[(\/?)asy(?:=[^\]]*)?\]/gi;
    const stack = [];
    const spans = [];
    for (const match of text.matchAll(token)) {
        const closing = match[1] === "/";
        if (!closing) {
            stack.push({
                index: match.index,
                bodyStart: match.index + match[0].length,
            });
            continue;
        }
        const open = stack.pop();
        if (!open) {
            findings.push(
                finding(
                    text,
                    "asy.unmatched_close",
                    "error",
                    match.index,
                    "Closing [/asy] has no matching opening tag.",
                    match.index + match[0].length,
                ),
            );
            continue;
        }
        if (stack.length === 0) {
            spans.push([open.index, match.index + match[0].length]);
        }
    }
    for (const open of stack) {
        findings.push(
            finding(
                text,
                "asy.unclosed_block",
                "error",
                open.index,
                "Opening [asy] has no matching [/asy].",
                open.bodyStart,
            ),
        );
        spans.push([open.index, text.length]);
    }
    let masked = text;
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
        masked = maskRange(masked, start, end);
    }
    return masked;
}

function inRegion(offset, regions) {
    return regions.some((region) => offset >= region.start && offset < region.end);
}

// A literal price such as `$4.20` is valid prose but an unescaped dollar sign
// is also a TeX math opener. Classify the unambiguous currency-shaped cases
// before pairing math delimiters, then mask only their `$` so they cannot make
// a later, otherwise-balanced math span look malformed. This deliberately does
// not rewrite the stored text; the audit remains read-only.
function maskUnescapedCurrency(text, original, findings, context = {}) {
    const currencyOffsets = [];
    let openInlineDollar = null;

    const nextSingleDollar = (start) => {
        for (let cursor = start; cursor < text.length; cursor++) {
            if (text[cursor] !== "$" || isEscaped(text, cursor)) continue;
            if (text[cursor - 1] === "$" || text[cursor + 1] === "$") continue;
            return cursor;
        }
        return -1;
    };

    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "$" || isEscaped(text, i)) continue;

        let run = 1;
        while (text[i + run] === "$" && !isEscaped(text, i + run)) run++;
        if (run >= 2) {
            // Match mathTokenAt's adjacent-delimiter behavior. With inline
            // math open, the first dollar closes it; any remaining pair is a
            // display delimiter and one odd remainder opens inline math again.
            // Without an inline opener, pairs are display delimiters and an
            // odd remainder opens inline math.
            const leavesInlineOpen =
                openInlineDollar == null ? run % 2 === 1 : run % 2 === 0;
            openInlineDollar = leavesInlineOpen ? i + run - 1 : null;
            i += run - 1;
            continue;
        }

        // A parenthesized standalone symbol, as in "value in dollars ($)", is
        // currency even though no amount follows it.
        const standaloneSymbol = text[i - 1] === "(" && text[i + 1] === ")";
        const amount = /^\$(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/.exec(
            text.slice(i),
        );
        if (!standaloneSymbol && !amount) {
            openInlineDollar = openInlineDollar == null ? i : null;
            continue;
        }

        // A currency-shaped dollar can actually be the closer for a preceding
        // span: `\times$12`, `$n$37`, and even malformed `$more than $4` all
        // have an unmatched inline opener before this dollar. Closing that span
        // takes precedence over interpreting the following digits as money.
        if (openInlineDollar != null) {
            const possibleMathBody = text.slice(openInlineDollar + 1, i);
            const withoutCommands = possibleMathBody.replace(/\\[A-Za-z]+/g, "");
            // Do not let an actually-unclosed formula swallow a later price.
            // A legitimate close has no prose-sized bare words once TeX
            // commands are removed (`n`, `\times`, `7^c = 8` all qualify).
            if (
                (possibleMathBody.trim() !== "" &&
                    !/[A-Za-z]{2,}/.test(withoutCommands)) ||
                (context.entityType === "answer_choice" &&
                    openInlineDollar === 0)
            ) {
                openInlineDollar = null;
                continue;
            }
            openInlineDollar = null;
        }

        if (amount) {
            const amountEnd = i + amount[0].length;
            // `$5$` is a balanced numeric math span, not currency.
            if (
                text[amountEnd] === "$" ||
                /^[.,;:!?]\$/.test(text.slice(amountEnd))
            ) {
                openInlineDollar = i;
                continue;
            }

            const remainder = text.slice(amountEnd);
            const next = /^\s*(.)/s.exec(remainder)?.[1] ?? "";
            const obscuredPrice =
                amount[1].startsWith("-") &&
                /^-\s*(?:[,.;:!?)]|$)/.test(remainder);
            // No whitespace between the leading number and a letter is TeX
            // implicit multiplication/variable syntax (`$3x+2$`, `$10p$`).
            const immediate = text[amountEnd] ?? "";
            const magnitudeSuffix = /^[KMB]\b/.test(text.slice(amountEnd));
            if (magnitudeSuffix && text[amountEnd + 1] === "$") {
                openInlineDollar = i;
                continue;
            }
            if (/[A-Za-z(@:|!]/.test(immediate) && !magnitudeSuffix) {
                openInlineDollar = i;
                continue;
            }
            if (
                immediate === "." &&
                /[A-Za-z0-9]/.test(text[amountEnd + 1] ?? "")
            ) {
                openInlineDollar = i;
                continue;
            }
            // A number followed by a mathematical operator/command is likely
            // the start of an expression such as `$100 + x$`. The obscured
            // price form `$-99.9-` observed in OCR is the intentional exception.
            const htmlAfterAmount = /^\s*<(?:\/|br\b|td\b|tr\b|table\b)/i.test(
                remainder,
            );
            if (
                !obscuredPrice &&
                /[+\-*/=^_\\{<>@:|!]/.test(next) &&
                !(next === "<" && htmlAfterAmount)
            ) {
                openInlineDollar = i;
                continue;
            }

            const possibleClose = nextSingleDollar(amountEnd);
            if (possibleClose >= 0) {
                const possibleBody = text.slice(amountEnd, possibleClose);
                const nextStartsAmount = /^\$-?\d/.test(
                    text.slice(possibleClose),
                );
                const numericListBody = /^(?:\s*,\s*[A-Za-z0-9]+)+\s*$/.test(
                    possibleBody,
                );
                const spacedOperatorBody = /^\s*[A-Za-z]\s+\d+\s*$/.test(
                    possibleBody,
                );
                const bodyWithoutCommands = possibleBody.replace(
                    /\\[A-Za-z]+/g,
                    "",
                );
                const mathExpressionBody =
                    !/<\/?[A-Za-z]/.test(possibleBody) &&
                    !/[A-Za-z]{3,}/.test(bodyWithoutCommands) &&
                    /[+\-*=^_\\{}<>|!@]/.test(possibleBody);
                // Numeric math can start with a bare number and continue with
                // punctuation, operators, or TeX (`$2,4,\ldots,50$`). Plain
                // alphabetic prose before the next dollar instead means that
                // the two dollars are separate prices (`$5 and $10`). A next
                // dollar that itself starts an amount is likewise a new price,
                // not the closer for this one (`$5, $10`).
                if (
                    !nextStartsAmount &&
                    (/[\\{}]/.test(possibleBody) ||
                        !/[A-Za-z]/.test(possibleBody) ||
                        numericListBody ||
                        spacedOperatorBody ||
                        mathExpressionBody ||
                        (next === "," && !/[A-Za-z]{2,}/.test(possibleBody)))
                ) {
                    openInlineDollar = i;
                    continue;
                }
            }
        }

        currencyOffsets.push(i);
        findings.push(
            finding(
                original,
                "currency.unescaped_dollar",
                "warning",
                i,
                "Unescaped currency dollar may be parsed as a math delimiter; use \\$ for a literal dollar sign.",
            ),
        );
    }

    let masked = text;
    for (const offset of currencyOffsets) {
        masked = masked.slice(0, offset) + " " + masked.slice(offset + 1);
    }
    return masked;
}

export function escapeLiteralCurrency(value, context = {}) {
    let text = String(value ?? "");
    const findings = [];
    const maskedAsy = maskAsymptote(text, findings);
    maskUnescapedCurrency(maskedAsy, text, findings, {
        entityType: "problem_statement",
        source: "pdf",
        ...context,
    });
    const offsets = findings
        .filter((item) => item.ruleId === "currency.unescaped_dollar")
        .map((item) => item.offset)
        .sort((a, b) => b - a);
    for (const offset of offsets) {
        text = text.slice(0, offset) + "\\$" + text.slice(offset + 1);
    }
    return text;
}

// Proven OCR presentation residue only. General delimiter balancing is not
// safe: an orphan can also signal truncated content or a missing expression.
export function cleanPdfDelimiterResidue(value) {
    return String(value ?? "")
        .replace(
            /^\${1,2}[ \t]+(?=(?:(?:A|I)\s+[a-z]|[A-Z][a-z]+\b))/,
            "",
        )
        .replace(
            /(\b\d+\.[ \t]*)\${1,2}[ \t]*(\n[ \t\n]*)?(?=!\[)/g,
            "$1$2",
        );
}

export function normalizePdfStatement(value) {
    return escapeLiteralCurrency(cleanPdfDelimiterResidue(value));
}

function auditBbcode(text, original, findings, mathRegions = []) {
    const tag = /\[(\/?)\s*([a-z][a-z0-9]*)(?:\s*=[^\]]*)?\]/gi;
    const stack = [];
    for (const match of text.matchAll(tag)) {
        // A LaTeX display opener such as `\[b=...` is not a `[b=...]`
        // BBCode tag. Likewise, an explicitly escaped literal bracket is text.
        if (isEscaped(text, match.index) || inRegion(match.index, mathRegions)) continue;
        const name = match[2].toLowerCase();
        if (!PAIRED_BBCODE.has(name)) continue;
        if (match[1] !== "/") {
            stack.push({ name, index: match.index, end: match.index + match[0].length });
            continue;
        }
        const open = stack.at(-1);
        if (!open) {
            findings.push(
                finding(
                    original,
                    "bbcode.unmatched_close",
                    "error",
                    match.index,
                    `Closing [/${name}] has no opening tag.`,
                    match.index + match[0].length,
                ),
            );
        } else if (open.name !== name) {
            findings.push(
                finding(
                    original,
                    "bbcode.mismatched_close",
                    "error",
                    match.index,
                    `Closing [/${name}] does not match [${open.name}].`,
                    match.index + match[0].length,
                ),
            );
            stack.pop();
        } else {
            stack.pop();
        }
    }
    for (const open of stack) {
        findings.push(
            finding(
                original,
                "bbcode.unclosed_tag",
                "error",
                open.index,
                `Opening [${open.name}] has no matching closing tag.`,
                open.end,
            ),
        );
    }
}

function mathTokenAt(text, index, expected = null) {
    if (text[index] === "$" && !isEscaped(text, index)) {
        let run = 1;
        while (text[index + run] === "$") run++;
        // Adjacent close/open delimiters legitimately form `$$` or `$$$`:
        // `$x$$y$` is two inline spans, while `$x$$$y$$` closes inline then
        // opens display. When inside math, consume the expected closer first.
        if (expected === "$") return "$";
        if (expected === "$$") return run >= 2 ? "$$" : "$";
        return run >= 2 ? "$$" : "$";
    }
    const next = text[index + 1];
    if (
        text[index] === "\\" &&
        !isEscaped(text, index) &&
        next != null &&
        "()[]".includes(next)
    ) {
        return text.slice(index, index + 2);
    }
    return null;
}

function auditMathDelimiters(text, original, findings) {
    const pairs = new Map([
        ["$", "$"],
        ["$$", "$$"],
        ["\\(", "\\)"],
        ["\\[", "\\]"],
    ]);
    const closers = new Set(pairs.values());
    const regions = [];
    let open = null;

    for (let i = 0; i < text.length; i++) {
        const token = mathTokenAt(text, i, open?.expected ?? null);
        if (!token) continue;
        if (!open) {
            if (closers.has(token) && token !== "$" && token !== "$$") {
                findings.push(
                    finding(
                        original,
                        "math.unmatched_close",
                        "error",
                        i,
                        `Closing math delimiter ${token} has no opening delimiter.`,
                        i + token.length,
                    ),
                );
            } else {
                open = { token, expected: pairs.get(token), index: i, bodyStart: i + token.length };
            }
            i += token.length - 1;
            continue;
        }

        if (token === open.expected) {
            regions.push({ start: open.bodyStart, end: i });
            open = null;
        } else {
            regions.push({ start: open.bodyStart, end: i });
            findings.push(
                finding(
                    original,
                    "math.mismatched_delimiter",
                    "error",
                    i,
                    `Math opened with ${open.token} but encountered ${token}; expected ${open.expected}.`,
                    i + token.length,
                ),
            );
            open = null;
        }
        i += token.length - 1;
    }

    if (open) {
        findings.push(
            finding(
                original,
                "math.unclosed_delimiter",
                "error",
                open.index,
                `Math delimiter ${open.token} has no matching ${open.expected}.`,
                open.bodyStart,
            ),
        );
        regions.push({ start: open.bodyStart, end: text.length });
    }
    return regions;
}

function auditBraces(text, original, findings) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        if ((text[i] === "{" || text[i] === "}") && isEscaped(text, i)) continue;
        if (text[i] === "{") stack.push(i);
        if (text[i] === "}") {
            const open = stack.pop();
            if (open == null) {
                findings.push(
                    finding(
                        original,
                        "latex.unmatched_close_brace",
                        "error",
                        i,
                        "Closing brace has no opening brace.",
                    ),
                );
            }
        }
    }
    for (const offset of stack) {
        findings.push(
            finding(
                original,
                "latex.unclosed_brace",
                "error",
                offset,
                "Opening brace has no closing brace.",
            ),
        );
    }
}

function auditEnvironments(text, original, findings) {
    const env = /\\(begin|end)\s*\{([^{}]+)\}/g;
    const stack = [];
    for (const match of text.matchAll(env)) {
        const [, kind, name] = match;
        if (kind === "begin") {
            stack.push({ name, index: match.index, end: match.index + match[0].length });
            continue;
        }
        const open = stack.at(-1);
        if (!open) {
            findings.push(
                finding(
                    original,
                    "latex.environment_unmatched_end",
                    "error",
                    match.index,
                    `\\end{${name}} has no matching \\begin{${name}}.`,
                    match.index + match[0].length,
                ),
            );
        } else if (open.name !== name) {
            findings.push(
                finding(
                    original,
                    "latex.environment_mismatch",
                    "error",
                    match.index,
                    `\\end{${name}} does not match \\begin{${open.name}}.`,
                    match.index + match[0].length,
                ),
            );
            stack.pop();
        } else {
            stack.pop();
        }
    }
    for (const open of stack) {
        findings.push(
            finding(
                original,
                "latex.environment_unclosed",
                "error",
                open.index,
                `\\begin{${open.name}} has no matching \\end{${open.name}}.`,
                open.end,
            ),
        );
    }
}

function auditLeftRight(text, original, findings) {
    const command = /\\(left|right)\b/g;
    const stack = [];
    for (const match of text.matchAll(command)) {
        if (match[1] === "left") {
            stack.push(match.index);
        } else if (stack.length === 0) {
            findings.push(
                finding(
                    original,
                    "latex.right_without_left",
                    "error",
                    match.index,
                    "\\right has no preceding \\left.",
                    match.index + match[0].length,
                ),
            );
        } else {
            stack.pop();
        }
    }
    for (const offset of stack) {
        findings.push(
            finding(
                original,
                "latex.left_without_right",
                "error",
                offset,
                "\\left has no matching \\right.",
                offset + 5,
            ),
        );
    }
}

function matchingBraceEnd(text, start) {
    if (text[start] !== "{") return -1;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (isEscaped(text, i)) continue;
        if (text[i] === "{") depth++;
        if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return -1;
}

// TeX arguments are tokens, not necessarily braced groups: `\frac12` and
// `\dfrac{n}3` are valid. Return the cursor after one argument token, or -1
// when there is no token to consume.
function texArgumentEnd(text, start) {
    let cursor = start;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (cursor >= text.length) return -1;
    if (text[cursor] === "{") {
        const end = matchingBraceEnd(text, cursor);
        // The brace audit owns the malformed-group finding; treating the rest
        // as this argument avoids a redundant "missing argument" warning.
        return end < 0 ? text.length : end;
    }
    if (text[cursor] !== "\\") return cursor + 1;
    const command = /^\\(?:[A-Za-z]+|.)/.exec(text.slice(cursor));
    return command ? cursor + command[0].length : -1;
}

function auditMathSyntax(text, original, regions, findings) {
    for (const region of regions) {
        const body = text.slice(region.start, region.end);
        const add = (ruleId, severity, relativeOffset, message, length = 1) => {
            const offset = region.start + relativeOffset;
            findings.push(finding(original, ruleId, severity, offset, message, offset + length));
        };

        for (const match of body.matchAll(/[_^](?:\s*$|\s*(?=[})]))/g)) {
            add(
                "latex.dangling_script",
                "error",
                match.index,
                `Script operator ${match[0].trim()} has no argument.`,
                match[0].length,
            );
        }
        for (const match of body.matchAll(/[_^]\s*\{\s*\}/g)) {
            add(
                "latex.empty_script",
                "warning",
                match.index,
                `Script operator ${match[0][0]} has an empty group.`,
                match[0].length,
            );
        }
        for (const match of body.matchAll(/(?:=\s*=|\+\s*\+|\*\s*\*|\/\s*\/)/g)) {
            add(
                "latex.repeated_operator",
                "warning",
                match.index,
                `Repeated operator sequence ${JSON.stringify(match[0])} may be accidental.`,
                match[0].length,
            );
        }
        // A trailing `=` is commonly an intentional answer blank after choices
        // are separated from the statement, so it is not itself suspicious.
        const trailing = body.match(/(?:[+*/]|\\(?:div|cdot|pm|mp))\s*$/);
        const beforeTrailing = trailing
            ? body.slice(0, trailing.index).trimEnd()
            : "";
        const operatorOnly = trailing && beforeTrailing === "";
        const scriptValue = trailing && /[_^]\s*$/.test(beforeTrailing);
        if (trailing && !operatorOnly && !scriptValue) {
            add(
                "latex.trailing_operator",
                "warning",
                trailing.index,
                "Math expression ends with a binary operator.",
                trailing[0].trimEnd().length,
            );
        }

        for (const match of body.matchAll(/\\([A-Za-z]+)\b/g)) {
            if (!COMMON_FRACTION_COMMANDS.has(match[1])) continue;
            let cursor = match.index + match[0].length;
            let missing = false;
            for (let argument = 0; argument < 2; argument++) {
                const end = texArgumentEnd(body, cursor);
                if (end < 0) {
                    missing = true;
                    break;
                }
                cursor = end;
            }
            if (missing) {
                add(
                    "latex.command_missing_argument",
                    "warning",
                    match.index,
                    `\\${match[1]} does not have two TeX arguments.`,
                    match[0].length,
                );
            }
        }
    }
}

function firstMatch(text, regex) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    return match ? { index: match.index, length: match[0].length } : null;
}

function auditResidue(text, context, findings) {
    const source = context.source;
    const entityType = context.entityType;
    const checks = [];

    if (entityType === "problem_statement") {
        checks.push([
            "content.solution_or_answer_section",
            "warning",
            /(?:^|\n)\s*(?:={2,}\s*)?(?:solutions?|answers?\s*key|answers?)\b[^\n]*/im,
            "Problem statement contains a solution or answer section heading.",
        ]);
        checks.push([
            "content.problem_number_prefix",
            "warning",
            /^\s*(?:\[b\]\s*)?problem\s*#?\s*\d+\s*[:.]/i,
            "Problem-number boilerplate remains at the start of the statement.",
        ]);
        checks.push([
            "content.forum_post_residue",
            "warning",
            /\[(?:quote|hide)\b[^\]]*\]|(?:^|\n)\s*(?:edited|posted)\s+by\b/i,
            "Problem statement contains forum-post markup or metadata.",
        ]);
    }

    if (source === "wiki") {
        checks.push([
            "content.wiki_markup_residue",
            "warning",
            /\{\{[^\n{}]*\}\}|\[\[Category:|^\s*=+[^=\n]+?=+\s*$|<\/?(?:i?math|cmath)\b/im,
            "Cleaned wiki content still contains MediaWiki markup.",
        ]);
    }

    if (source === "pdf" && entityType === "problem_statement") {
        checks.push([
            "content.pdf_page_residue",
            "warning",
            /(?:^|\n)\s*(?:page\s+\d+(?:\s+of\s+\d+)?|©|copyright\b|all rights reserved\b)/im,
            "PDF statement may contain a page header, footer, or copyright line.",
        ]);
    }

    for (const [ruleId, severity, regex, message] of checks) {
        const match = firstMatch(text, regex);
        if (match) {
            findings.push(
                finding(text, ruleId, severity, match.index, message, match.index + match.length),
            );
        }
    }

    if (entityType === "problem_statement" && text.trim().length < 12) {
        findings.push(
            finding(
                text,
                "content.suspiciously_short",
                "warning",
                0,
                "Problem statement is unusually short.",
                text.length,
            ),
        );
    }
}

/**
 * Audit one stored text value. This function is pure and deterministic.
 */
export function auditText(value, context = {}) {
    const text = typeof value === "string" ? value : String(value ?? "");
    const findings = [];

    if (text.trim() === "") {
        return [
            finding(text, "text.empty", "error", 0, "Stored text is empty.", text.length),
        ];
    }

    for (const match of text.matchAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g)) {
        findings.push(
            finding(
                text,
                "text.control_character",
                "error",
                match.index,
                `Unexpected control character U+${match[0].charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}.`,
            ),
        );
    }

    let masked = maskAsymptote(text, findings);
    masked = maskUnescapedCurrency(masked, text, findings, context);
    const regions = auditMathDelimiters(masked, text, findings);
    auditBbcode(masked, text, findings, regions);
    auditBraces(masked, text, findings);
    auditEnvironments(masked, text, findings);
    auditLeftRight(masked, text, findings);
    auditMathSyntax(masked, text, regions, findings);
    auditResidue(text, context, findings);

    return findings.sort((a, b) => a.offset - b.offset || a.ruleId.localeCompare(b.ruleId));
}

function normalizeChoice(value) {
    return CleanupText.normalizeAnswer(String(value ?? ""))
        .replace(/\s+/g, "");
}

function entityEnabled(options, entity) {
    return !options.entities || options.entities.has("all") || options.entities.has(entity);
}

function sourceEnabled(options, source) {
    return !options.sources || options.sources.has("all") || options.sources.has(source);
}

function metadataForProblem(row) {
    return {
        problemId: row.problem_id,
        seriesId: row.series_id,
        seriesName: row.series_name,
        testId: row.test_id,
        testName: row.test_name,
        year: row.year,
        n: row.n,
        problemNumber: row.n + 1,
    };
}

function addAuditedText(state, key, entityType, source) {
    state.units.set(key, { entityType, source });
}

function addTextFindings(state, value, base, context = {}) {
    addAuditedText(state, base.unitKey, base.entityType, base.source);
    for (const item of auditText(value, { ...context, ...base })) {
        state.findings.push({
            version: TEXT_AUDIT_VERSION,
            ...base,
            ...item,
        });
    }
}

function addDirectFinding(state, text, base, ruleId, severity, message, offset = 0) {
    state.findings.push({
        version: TEXT_AUDIT_VERSION,
        ...base,
        ...finding(String(text ?? ""), ruleId, severity, offset, message),
    });
}

// Some MCQs publish all answer options inside one image or Asymptote program,
// so there is no honest standalone text value to put in each choice cell. Keep
// this deliberately narrower than "statement contains a diagram": a normal
// problem diagram can coexist with genuinely missing textual choices. Require
// visual media plus either explicit A-E presentation labels or a question that
// specifically asks the reader to select a visual object.
function hasVisualOnlyChoices(statement) {
    if (typeof statement !== "string") return false;
    const hasVisualMedia =
        /\[(?:asy(?:=[^\]]*)?|img)\]|<asy\b|\bFile:/i.test(statement);
    if (!hasVisualMedia) return false;

    const labels = new Set();
    const labelPattern =
        /\\(?:textbf|text|textrm|mathrm|mathbf|hbox)\s*\{\s*\(\s*([A-E])\s*\)|label\s*\(\s*["']\$?(?:\\textbf\s*\{)?\s*\(\s*([A-E])\s*\)/gi;
    for (const match of statement.matchAll(labelPattern)) {
        labels.add(match[1] ?? match[2]);
    }
    if (labels.size >= 4) return true;

    return /\bwhich\b[^?\n]{0,160}\b(?:figure|figures|graph|graphs|histogram|histograms|diagram|diagrams|pattern|patterns|image|images|position|positions|sequence|sequences|shape|shapes|view|views|cylinder|cylinders|cone|cones)\b/i.test(
        statement,
    );
}

function auditChoiceTier(state, row, source, statement, choicesJson, answerIndex, answer) {
    const metadata = metadataForProblem(row);
    const collectionBase = {
        entityType: "answer_choices",
        entityId: row.problem_id,
        source,
        field: `${source}_choices`,
        unitKey: `answer_choices:${row.problem_id}:${source}`,
        ...metadata,
    };

    if (choicesJson == null) {
        if (source !== "pdf" && statement) {
            const extracted = CleanupText.extractChoices(statement);
            if (extracted.length >= 3) {
                addAuditedText(
                    state,
                    collectionBase.unitKey,
                    collectionBase.entityType,
                    source,
                );
                addDirectFinding(
                    state,
                    statement,
                    {
                        ...collectionBase,
                        field: `${source}_statement`,
                    },
                    "choice.unextracted_block",
                    "warning",
                    `Statement contains ${extracted.length} extractable choices but ${source}_choices is NULL.`,
                    Math.max(0, statement.indexOf("(A)")),
                );
            }
        }
        return;
    }

    addAuditedText(state, collectionBase.unitKey, collectionBase.entityType, source);
    let choices;
    try {
        choices = JSON.parse(choicesJson);
    } catch {
        addDirectFinding(
            state,
            choicesJson,
            collectionBase,
            "choice.invalid_json",
            "error",
            "Stored choices are not valid JSON.",
        );
        return;
    }
    if (!Array.isArray(choices)) {
        addDirectFinding(
            state,
            choicesJson,
            collectionBase,
            "choice.not_array",
            "error",
            "Stored choices JSON is not an array.",
        );
        return;
    }

    const allChoicesEmpty =
        choices.length >= 3 &&
        choices.every((choice) => String(choice ?? "").trim() === "");
    if (
        (choices.length === 0 || allChoicesEmpty) &&
        hasVisualOnlyChoices(statement)
    ) {
        // Preserve audited-unit counts for an existing all-empty A-E array,
        // while reporting the condition once at the collection level.
        choices.forEach((_, choiceIndex) => {
            addAuditedText(
                state,
                `answer_choice:${row.problem_id}:${source}:${choiceIndex}`,
                "answer_choice",
                source,
            );
        });
        addDirectFinding(
            state,
            statement,
            collectionBase,
            "choice.visual_only",
            "warning",
            "Answer choices are presented only as a composite visual; no deterministic per-choice values were extracted.",
        );
        return;
    }

    if (choices.length < 3 || choices.length > 5) {
        addDirectFinding(
            state,
            choicesJson,
            collectionBase,
            "choice.unexpected_count",
            "error",
            `Stored MCQ has ${choices.length} choices; expected 3 through 5.`,
        );
    }

    const normalized = new Map();
    choices.forEach((choice, choiceIndex) => {
        const field = `${source}_choices[${choiceIndex}]`;
        const base = {
            entityType: "answer_choice",
            entityId: `${row.problem_id}:${source}:${choiceIndex}`,
            source,
            field,
            choiceIndex,
            unitKey: `answer_choice:${row.problem_id}:${source}:${choiceIndex}`,
            ...metadata,
        };
        addTextFindings(state, choice, base, { entityType: "answer_choice", source });
        const value = String(choice ?? "");
        if (value.trim() === "") {
            addDirectFinding(
                state,
                value,
                base,
                "choice.empty_value",
                "error",
                `Choice ${choiceIndex + 1} is empty.`,
            );
        }
        const label = firstMatch(
            value,
            /^\s*(?:\\(?:textbf|text|textrm|mathrm)\s*\{\s*\(\s*[A-E]\s*\)\s*\}|\(\s*[A-E]\s*\)|[A-E]\s*[.):])\s*/,
        );
        if (label) {
            addDirectFinding(
                state,
                value,
                base,
                "choice.embedded_label",
                "warning",
                "Choice value still contains its A–E presentation label.",
                label.index,
            );
        }
        const key = normalizeChoice(value);
        if (key && normalized.has(key)) {
            addDirectFinding(
                state,
                value,
                base,
                "choice.duplicate_value",
                "warning",
                `Choice duplicates choice ${normalized.get(key) + 1} after normalization.`,
            );
        } else if (key) {
            normalized.set(key, choiceIndex);
        }
    });

    const index = answerIndex ?? -1;
    if (!Number.isInteger(index) || index < -1 || index >= choices.length) {
        addDirectFinding(
            state,
            choicesJson,
            collectionBase,
            "choice.answer_index_out_of_range",
            "error",
            `Answer index ${JSON.stringify(answerIndex)} is outside the choice array.`,
        );
    }
    const parsed = CleanupText.parseMCQAns(answer);
    if (parsed?.type === "letter") {
        const expected = parsed.value.charCodeAt(0) - 65;
        if (expected !== index) {
            addDirectFinding(
                state,
                choicesJson,
                collectionBase,
                "choice.answer_letter_index_mismatch",
                "error",
                `Answer letter ${parsed.value} implies index ${expected}, but stored index is ${index}.`,
            );
        }
    }

    if (statement && CleanupText.extractChoices(statement).length >= 3) {
        addDirectFinding(
            state,
            statement,
            {
                ...collectionBase,
                field: `${source}_statement`,
            },
            "choice.residual_block",
            "warning",
            "Statement still contains an extractable choice block despite stored choices.",
            Math.max(0, statement.indexOf("(A)")),
        );
    }
}

function summaryFor(state) {
    const findingsBySeverity = {};
    const findingsByRule = {};
    const sources = {};
    const auditedByEntity = {};
    const flagged = new Set();

    for (const [key, unit] of state.units) {
        auditedByEntity[unit.entityType] = (auditedByEntity[unit.entityType] ?? 0) + 1;
        sources[unit.source] ??= { auditedTexts: 0, flaggedTexts: 0, findings: 0 };
        sources[unit.source].auditedTexts++;
    }
    for (const item of state.findings) {
        findingsBySeverity[item.severity] = (findingsBySeverity[item.severity] ?? 0) + 1;
        findingsByRule[item.ruleId] = (findingsByRule[item.ruleId] ?? 0) + 1;
        sources[item.source] ??= { auditedTexts: 0, flaggedTexts: 0, findings: 0 };
        sources[item.source].findings++;
        if (item.unitKey) flagged.add(item.unitKey);
    }
    for (const key of flagged) {
        const unit = state.units.get(key);
        if (unit) sources[unit.source].flaggedTexts++;
    }

    return {
        totalAuditedTexts: state.units.size,
        flaggedAuditedTexts: flagged.size,
        totalFindings: state.findings.length,
        findingsBySeverity,
        auditedByEntity,
        sources,
        findingsByRule,
    };
}

/**
 * Audit all requested stored source tiers. The supplied database is queried
 * only with SELECT statements.
 */
export function auditDatabase(db, options = {}) {
    const state = { findings: [], units: new Map() };
    const problemRows = db.query(`
        SELECT p.id AS problem_id, p.test_id, p.n,
               p.aops_statement, p.aops_choices, p.aops_answer_index, p.aops_answer,
               p.wiki_statement, p.wiki_choices, p.wiki_answer_index, p.wiki_answer,
               p.pdf_statement, p.pdf_answer,
               t.name AS test_name, t.year, t.series_id,
               s.name AS series_name
          FROM problems p
          JOIN tests t ON t.id = p.test_id
          LEFT JOIN series s ON s.id = t.series_id
         ORDER BY p.id
    `).all();

    for (const row of problemRows) {
        const metadata = metadataForProblem(row);
        for (const source of ["aops", "wiki", "pdf"]) {
            if (!sourceEnabled(options, source)) continue;
            const statement = row[`${source}_statement`];
            if (entityEnabled(options, "statements") && statement != null) {
                addTextFindings(
                    state,
                    statement,
                    {
                        entityType: "problem_statement",
                        entityId: row.problem_id,
                        source,
                        field: `${source}_statement`,
                        unitKey: `problem_statement:${row.problem_id}:${source}`,
                        ...metadata,
                    },
                    { entityType: "problem_statement", source },
                );
            }
            if (entityEnabled(options, "choices")) {
                if (source === "pdf") {
                    if (!statement) continue;
                    const extracted = CleanupText.extractChoices(statement);
                    extracted.forEach((choice, choiceIndex) => {
                        addTextFindings(
                            state,
                            choice,
                            {
                                entityType: "answer_choice",
                                entityId: `${row.problem_id}:pdf:${choiceIndex}`,
                                source: "pdf",
                                field: `pdf_statement.choice[${choiceIndex}]`,
                                choiceIndex,
                                unitKey: `answer_choice:${row.problem_id}:pdf:${choiceIndex}`,
                                ...metadata,
                            },
                            { entityType: "answer_choice", source: "pdf" },
                        );
                    });
                } else {
                    auditChoiceTier(
                        state,
                        row,
                        source,
                        statement,
                        row[`${source}_choices`],
                        row[`${source}_answer_index`],
                        row[`${source}_answer`],
                    );
                }
            }
        }
    }

    if (entityEnabled(options, "solutions") && sourceEnabled(options, "canonical")) {
        const rows = db.query(`
            SELECT sol.id AS solution_id, sol.problem_id, sol.content, sol.content_format,
                   p.test_id, p.n, t.name AS test_name, t.year, t.series_id,
                   s.name AS series_name
              FROM solutions sol
              JOIN problems p ON p.id = sol.problem_id
              JOIN tests t ON t.id = p.test_id
              LEFT JOIN series s ON s.id = t.series_id
             ORDER BY sol.id
        `).all();
        for (const row of rows) {
            addTextFindings(
                state,
                row.content,
                {
                    entityType: "solution",
                    entityId: row.solution_id,
                    solutionId: row.solution_id,
                    source: "canonical",
                    field: "solutions.content",
                    contentFormat: row.content_format,
                    unitKey: `solution:${row.solution_id}`,
                    ...metadataForProblem(row),
                },
                { entityType: "solution", source: "canonical" },
            );
        }
    }

    if (entityEnabled(options, "solution-sources")) {
        const rows = db.query(`
            SELECT ss.id AS solution_source_id, ss.solution_id, ss.problem_id,
                   ss.source, ss.raw_content, sol.content_format,
                   p.test_id, p.n, t.name AS test_name, t.year, t.series_id,
                   s.name AS series_name
              FROM solution_sources ss
              JOIN solutions sol ON sol.id = ss.solution_id
              JOIN problems p ON p.id = ss.problem_id
              JOIN tests t ON t.id = p.test_id
              LEFT JOIN series s ON s.id = t.series_id
             WHERE ss.raw_content IS NOT NULL
             ORDER BY ss.id
        `).all();
        for (const row of rows) {
            if (!sourceEnabled(options, row.source)) continue;
            addTextFindings(
                state,
                row.raw_content,
                {
                    entityType: "solution_source",
                    entityId: row.solution_source_id,
                    solutionSourceId: row.solution_source_id,
                    solutionId: row.solution_id,
                    source: row.source,
                    field: "solution_sources.raw_content",
                    contentFormat: row.content_format,
                    unitKey: `solution_source:${row.solution_source_id}`,
                    ...metadataForProblem(row),
                },
                { entityType: "solution_source", source: row.source },
            );
        }
    }

    state.findings.sort((a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        String(a.entityId).localeCompare(String(b.entityId), undefined, { numeric: true }) ||
        a.source.localeCompare(b.source) ||
        a.field.localeCompare(b.field) ||
        a.offset - b.offset ||
        a.ruleId.localeCompare(b.ruleId),
    );

    const summary = summaryFor(state);
    const publicFindings = state.findings.map(({ unitKey: _unitKey, ...item }) => item);
    return {
        version: TEXT_AUDIT_VERSION,
        summary,
        findings: publicFindings,
    };
}

function csvCell(value) {
    if (value == null) return "";
    const string = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

const CSV_COLUMNS = [
    "version",
    "severity",
    "confidence",
    "ruleId",
    "entityType",
    "entityId",
    "problemId",
    "solutionId",
    "solutionSourceId",
    "source",
    "field",
    "choiceIndex",
    "seriesName",
    "testName",
    "year",
    "n",
    "problemNumber",
    "offset",
    "end",
    "line",
    "column",
    "message",
    "snippet",
];

export function auditFindingsCsv(report) {
    return [
        CSV_COLUMNS.join(","),
        ...report.findings.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")),
    ].join("\n") + "\n";
}

export function writeAuditReports(report, { jsonFile, csvFile } = {}) {
    const written = {};
    if (jsonFile) {
        mkdirSync(dirname(jsonFile), { recursive: true });
        writeFileSync(jsonFile, JSON.stringify(report, null, 2) + "\n");
        written.jsonFile = jsonFile;
    }
    if (csvFile) {
        mkdirSync(dirname(csvFile), { recursive: true });
        writeFileSync(csvFile, auditFindingsCsv(report));
        written.csvFile = csvFile;
    }
    return written;
}

export function auditDatabaseFile(dbPath, options = {}) {
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
        return auditDatabase(db, options);
    } finally {
        db.close();
    }
}
