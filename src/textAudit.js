import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CleanupText } from "./CleanupText.js";

export const TEXT_AUDIT_VERSION = "text-audit-v1";

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

function auditBbcode(text, original, findings, mathRegions = []) {
    const tag = /\[(\/?)\s*([a-z][a-z0-9]*)(?:=[^\]]*)?\]/gi;
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
        if (trailing) {
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

    const masked = maskAsymptote(text, findings);
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
        .replace(/\s+/g, "")
        .toLowerCase();
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
            /^\s*(?:\\(?:textbf|text|textrm|mathrm)\s*\{\s*\(?[A-E]\)?\s*\}|\(\s*[A-E]\s*\)|[A-E]\s*[.):])\s*/i,
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
