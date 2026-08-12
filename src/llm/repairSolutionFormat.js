// repair_solution_format
//
// Cleans the *presentation* of a solution we already ingested, without touching
// its mathematics. The unit of work is an existing canonical `solutions` row
// that has `solution_sources` provenance; raw unclassified discussion replies
// are the extraction operation's business, not this one's.
//
// Eligibility is deterministic and comes from one place: the text audit. Forum
// noise is part of that audit (`content.quote_block`, `content.greeting_or_signoff`,
// and friends in textAudit.js), and whatever the audit's own normalizer can strip
// with certainty is already gone by the time a row is planned. So the model only
// ever sees defects that determinism refused to touch. Clean solutions are never
// spent on a model call.
//
// The model may delete non-solution material and improve prose/LaTeX. It may not
// add mathematics. Validation therefore re-runs the audit and refuses any result
// that claims a meaning change, drops a required image or boxed answer, or fails
// to improve the findings that made the row eligible.

import { CleanupText } from "../CleanupText.js";
import { hashText } from "../db.js";
import { auditText } from "../textAudit.js";
import { buildRequestIdentity, canonicalJSON } from "./cache.js";
import {
    DEFAULT_MAX_OUTPUT_TOKENS,
    estimateTokens,
    increment,
    parseChoices,
} from "./planning.js";

export const REPAIR_OPERATION = "repair_solution_format";
export const OPERATION_VERSION = "1";
export const RESPONSE_CONTRACT_VERSION = "1";
export const PARSER_VERSION = "1";
export const VALIDATOR_VERSION = "1";

// The reply is a whole rewritten solution, so it gets the shared free-text
// ceiling rather than a guessed one; a repair truncated mid-proof would fail
// validation and waste the call.
export const DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;
export const DEFAULT_MAX_INPUT_CHARS = 60_000;

export const AUDIT_CONTEXT = { entityType: "solution", source: "canonical" };

export const RESPONSE_SCHEMA = {
    type: "object",
    required: [
        "replacement",
        "change_summary",
        "removed_non_solution_content",
        "mathematical_meaning_changed",
        "confidence",
    ],
    additionalProperties: false,
    properties: {
        replacement: { type: "string" },
        change_summary: { type: "array", items: { type: "string" } },
        removed_non_solution_content: { type: "array", items: { type: "string" } },
        mathematical_meaning_changed: { type: "boolean" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
    },
};

export const SYSTEM_PROMPT = `You clean up the formatting of a mathematical solution that was already collected from a source. You are a copy editor, not a mathematician.

You MAY:
- remove unrelated conversation, forum chatter, greetings, sign-offs, and signatures
- remove quoted text that is not part of the solution
- remove formatting residue such as stray tags, broken markup, and duplicated whitespace
- fix paragraphing, grammar, spelling, and LaTeX formatting
- improve the flow of explanation that is already present

You MUST NOT:
- add any mathematical argument, step, justification, case, or computation
- fill in a gap, complete an incomplete proof, or solve the problem yourself
- change any claim, value, variable, expression, or final answer
- invent content that is not in the source material
- remove any image, [asy] block, or diagram reference

If the solution is incomplete, leave it incomplete. If cleaning it would require changing what it says, set mathematical_meaning_changed to true and return the original text unchanged.

Reply with a single JSON object and nothing else:
{"replacement": "<the cleaned solution text>", "change_summary": ["<short description of each change>"], "removed_non_solution_content": ["<each removed fragment, verbatim>"], "mathematical_meaning_changed": false, "confidence": 0.0}`;

/**
 * Every deterministic reason this solution's presentation looks damaged.
 * `eligible` is exactly "the text audit complains about it".
 */
export function repairSignals(content) {
    const findings = auditText(String(content ?? ""), AUDIT_CONTEXT).map((item) => ({
        rule_id: item.ruleId,
        severity: item.severity,
        message: item.message,
        offset: item.offset,
    }));
    return { findings, eligible: findings.length > 0 };
}

function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * References that must survive a format repair verbatim. An [asy] block *is* the
 * figure, so it is compared whole; [img] and Markdown images are compared by URL.
 */
export function requiredImageReferences(content) {
    const text = String(content ?? "");
    const references = [];
    for (const match of text.matchAll(/\[asy\][\s\S]*?\[\/asy\]/gi)) {
        references.push({ kind: "asy", value: normalizeWhitespace(match[0]) });
    }
    for (const match of text.matchAll(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi)) {
        references.push({ kind: "img", value: normalizeWhitespace(match[1]) });
    }
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
        references.push({ kind: "markdown_image", value: normalizeWhitespace(match[1]) });
    }
    return references;
}

function boxedAnswers(content) {
    return CleanupText.getAllBoxed(String(content ?? "")).map((value) =>
        CleanupText.normalizeAnswer(value),
    );
}

export function buildInputSnapshot(candidate) {
    return {
        problem: {
            statement: candidate.problem.statement,
            choices: candidate.problem.choices,
            response_kind: candidate.problem.responseKind,
            known_answer: candidate.problem.answerValue,
            test_name: candidate.problem.testName,
            problem_number: candidate.problem.problemNumber,
        },
        solution: {
            solution_id: candidate.solutionId,
            content_format: candidate.contentFormat,
            content: candidate.content,
        },
        sources: candidate.sources.map((source) => ({
            source: source.source,
            source_key: source.source_key,
            source_url: source.source_url ?? null,
            aops_topic_id: source.aops_topic_id ?? null,
            aops_post_id: source.aops_post_id ?? null,
            aops_username: source.aops_username ?? null,
            wiki_page: source.wiki_page ?? null,
            wiki_section: source.wiki_section ?? null,
            posted_at: source.posted_at ?? null,
            // The documentary source is only worth sending when it still holds
            // material the canonical content lost.
            raw_content: source.raw_content === candidate.content ? null : source.raw_content,
            raw_identical_to_canonical: source.raw_content === candidate.content,
        })),
        audit_findings: candidate.signals.findings,
    };
}

export function buildRepairRequest(candidate, modelConfig = {}) {
    const input = buildInputSnapshot(candidate);
    const userPrompt = `Clean the formatting of this solution:\n${canonicalJSON(input)}`;
    const inferenceParameters = {
        temperature: modelConfig.temperature ?? 0,
        max_tokens: modelConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(modelConfig.seed == null ? {} : { seed: modelConfig.seed }),
    };
    const spec = {
        operation: REPAIR_OPERATION,
        operationVersion: OPERATION_VERSION,
        responseContractVersion: RESPONSE_CONTRACT_VERSION,
        input,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        responseSchema: RESPONSE_SCHEMA,
        modelId: modelConfig.modelId,
        modelRevision: modelConfig.modelRevision ?? null,
        inferenceParameters,
        sampleIndex: 0,
    };
    return { ...spec, ...buildRequestIdentity(spec) };
}

/** First balanced `{...}` run, so a JSON object wrapped in prose or a fenced code block still parses. */
function firstJSONObject(text) {
    const source = String(text ?? "");
    const start = source.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") depth++;
        else if (character === "}") {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    return null;
}

function stringArray(value, field) {
    if (value == null) throw new Error(`Response field ${field} is required`);
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => {
        if (typeof item !== "string") {
            throw new Error(`Response field ${field} must contain only strings`);
        }
        return item;
    });
}

export function parseRepairResponse(text) {
    const json = firstJSONObject(text);
    if (!json) throw new Error("Model output contains no JSON object");
    let raw;
    try {
        raw = JSON.parse(json);
    } catch (error) {
        throw new Error(`Model output is not valid JSON: ${error.message}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Model output is not a JSON object");
    }
    if (typeof raw.replacement !== "string") {
        throw new Error("Response field replacement must be a string");
    }
    if (typeof raw.mathematical_meaning_changed !== "boolean") {
        throw new Error("Response field mathematical_meaning_changed must be a boolean");
    }
    const confidence = typeof raw.confidence === "string" ? Number(raw.confidence) : raw.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error("Response field confidence must be a number between 0 and 1");
    }
    return {
        replacement: raw.replacement,
        change_summary: stringArray(raw.change_summary, "change_summary"),
        removed_non_solution_content: stringArray(
            raw.removed_non_solution_content ?? [],
            "removed_non_solution_content",
        ),
        mathematical_meaning_changed: raw.mathematical_meaning_changed,
        confidence,
    };
}

function countByRule(findings) {
    const counts = new Map();
    for (const item of findings) counts.set(item.rule_id, (counts.get(item.rule_id) ?? 0) + 1);
    return counts;
}

/**
 * Deterministic acceptance checks over a parsed repair. Returns the errors plus
 * the before/after detail that is recorded on the interpretation and proposal.
 */
export function validateRepair(parsed, context) {
    const original = String(context.content ?? "");
    const replacement = parsed.replacement;
    const errors = [];

    const before = context.signals ?? repairSignals(original);
    const after = repairSignals(replacement);

    if (!replacement.trim()) errors.push("replacement is empty");
    if (parsed.mathematical_meaning_changed) {
        errors.push("model reported that the mathematical meaning changed");
    }

    const normalizedReplacement = normalizeWhitespace(replacement);
    const missingImages = requiredImageReferences(original)
        .filter((reference) => !normalizedReplacement.includes(reference.value))
        .map((reference) => `${reference.kind}:${reference.value.slice(0, 80)}`);
    if (missingImages.length) {
        errors.push(`replacement drops required image references: ${missingImages.join(", ")}`);
    }

    const beforeBoxed = boxedAnswers(original);
    const afterBoxed = new Set(boxedAnswers(replacement));
    const droppedBoxed = [...new Set(beforeBoxed)].filter((value) => !afterBoxed.has(value));
    if (droppedBoxed.length) {
        errors.push(`replacement drops boxed answer(s): ${droppedBoxed.join(", ")}`);
    }
    const knownAnswer = CleanupText.normalizeAnswer(context.problem?.answerValue ?? "");
    const knownAnswerWasPresent = Boolean(knownAnswer) && beforeBoxed.includes(knownAnswer);
    if (knownAnswerWasPresent && !afterBoxed.has(knownAnswer)) {
        errors.push(`replacement no longer states the known answer ${knownAnswer}`);
    }

    const beforeErrors = countByRule(before.findings.filter((item) => item.severity === "error"));
    const afterErrors = countByRule(after.findings.filter((item) => item.severity === "error"));
    const newErrorRules = [...afterErrors.entries()]
        .filter(([rule, count]) => count > (beforeErrors.get(rule) ?? 0))
        .map(([rule]) => rule);
    if (newErrorRules.length) {
        errors.push(`replacement introduces error-level findings: ${newErrorRules.join(", ")}`);
    }

    if (after.findings.length >= before.findings.length) {
        errors.push("replacement does not improve the deterministic findings that made it eligible");
    }

    return {
        errors,
        details: {
            parser_version: PARSER_VERSION,
            validator_version: VALIDATOR_VERSION,
            findings_before: before.findings.length,
            findings_after: after.findings.length,
            rules_before: [...new Set(before.findings.map((item) => item.rule_id))],
            rules_after: [...new Set(after.findings.map((item) => item.rule_id))],
            new_error_rules: newErrorRules,
            dropped_image_references: missingImages,
            dropped_boxed_answers: droppedBoxed,
            known_answer_checked: knownAnswerWasPresent,
            known_answer: knownAnswerWasPresent ? knownAnswer : null,
            // Removals the model claimed that we could not confirm against the
            // original text. Recorded for the reviewer; never fatal on its own.
            unverified_removals: parsed.removed_non_solution_content.filter(
                (fragment) => fragment.trim() && !original.includes(fragment),
            ),
            content_hash_before: hashText(original),
            content_hash_after: hashText(replacement),
        },
    };
}

/**
 * A malformed response is `invalid` and may be retried. A well-formed response
 * that fails validation is a validated negative: it caches as `valid_empty`, so
 * an identical request is never re-sent, and a validator bump reparses it.
 */
export function interpretRepairResponse(text, context) {
    let parsed;
    try {
        parsed = parseRepairResponse(text);
    } catch (error) {
        return { valid: false, parsed: null, validated: null, errors: [error.message], usableCount: 0 };
    }

    const { errors, details } = validateRepair(parsed, context);
    if (errors.length) {
        return {
            valid: true,
            parsed,
            validated: { rejected: true, rejection_reasons: errors, validation: details },
            errors,
            usableCount: 0,
        };
    }
    return {
        valid: true,
        parsed,
        validated: { ...parsed, rejected: false, validation: details },
        errors: [],
        usableCount: 1,
    };
}

export function repairVersions() {
    return { parserVersion: PARSER_VERSION, validatorVersion: VALIDATOR_VERSION };
}

const ELIGIBLE_STATUSES = new Set(["candidate", "needs_review", "accepted"]);

async function collect(db, options) {
    const {
        modelId,
        modelRevision = null,
        maxTokens = DEFAULT_MAX_TOKENS,
        seed = null,
        maxInputChars = DEFAULT_MAX_INPUT_CHARS,
    } = options;

    const rows = db
        .query(
            `SELECT sol.id AS solution_id, sol.problem_id, sol.content, sol.content_format,
                    sol.status, sol.status_source, sol.duplicate_of_solution_id,
                    p.n, p.statement, p.answer_value, p.aops_choices, p.wiki_choices,
                    COALESCE(p.coverage_response_kind, t.response_kind) AS response_kind,
                    t.name AS test_name
             FROM solutions sol
             JOIN problems p ON p.id = sol.problem_id
             JOIN tests t ON t.id = p.test_id
             ORDER BY sol.id`,
        )
        .all();

    const entries = [];
    const skips = {};
    for (const row of rows) {
        const sourceKey = `solution:${row.solution_id}`;
        const content = typeof row.content === "string" ? row.content : "";
        const sourceContentHash = hashText(content);
        const base = {
            problemId: row.problem_id,
            solutionId: row.solution_id,
            problemNumber: row.n + 1,
        };

        // Checked before the skip gates: materialization sets status_source to
        // 'manual', and a later hand edit must read as drift rather than as an
        // ordinary manual solution we never touched.
        const priorMaterialization = db
            .query(
                `SELECT p.request_key, m.materialized_value_hash
                 FROM llm_materializations m
                 JOIN llm_proposals p ON p.id = m.proposal_id
                 WHERE p.operation = ? AND m.entity_type = 'solution' AND m.entity_id = ?
                 ORDER BY m.id DESC LIMIT 1`,
            )
            .get(REPAIR_OPERATION, row.solution_id);
        if (priorMaterialization) {
            entries.push({
                ...base,
                disposition: "materialized",
                requestKey: priorMaterialization.request_key,
                materializationDrift:
                    hashText(content) !== priorMaterialization.materialized_value_hash,
            });
            continue;
        }

        const sources = db
            .query(
                `SELECT source, source_key, source_url, raw_content, aops_topic_id,
                        aops_post_id, aops_username, wiki_page, wiki_section, posted_at
                 FROM solution_sources WHERE solution_id = ? ORDER BY id`,
            )
            .all(row.solution_id);

        let skipReason = null;
        let signals = null;
        if (!content.trim()) skipReason = "empty";
        else if (row.duplicate_of_solution_id != null || row.status === "duplicate") {
            skipReason = "duplicate";
        } else if (!ELIGIBLE_STATUSES.has(row.status)) skipReason = "inactive_status";
        else if (!sources.length) skipReason = "no_source_provenance";
        else if (row.status_source === "manual") skipReason = "manual_decision";
        else {
            signals = repairSignals(content);
            if (!signals.eligible) skipReason = "no_repair_signal";
        }
        if (!skipReason) {
            const rejection = db
                .query(
                    `SELECT id FROM llm_proposals
                     WHERE problem_id = ? AND operation = ?
                       AND source_kind = 'solution' AND source_key = ?
                       AND source_content_hash = ?
                       AND review_status = 'rejected' AND status_source = 'manual'
                     LIMIT 1`,
                )
                .get(row.problem_id, REPAIR_OPERATION, sourceKey, sourceContentHash);
            if (rejection) skipReason = "manual_rejection";
        }
        if (skipReason) {
            entries.push({ ...base, disposition: "blocked", reason: skipReason });
            increment(skips, skipReason);
            continue;
        }

        const problem = {
            statement: row.statement,
            choices: parseChoices(row),
            responseKind: row.response_kind,
            answerValue: row.answer_value,
            testName: row.test_name,
            problemNumber: row.n + 1,
        };
        const candidate = {
            solutionId: row.solution_id,
            problemId: row.problem_id,
            content,
            contentFormat: row.content_format,
            sources,
            signals,
            problem,
        };
        const request = buildRepairRequest(candidate, {
            modelId,
            modelRevision,
            maxTokens,
            seed,
        });
        if (request.userPrompt.length + request.systemPrompt.length > maxInputChars) {
            entries.push({ ...base, disposition: "blocked", reason: "too_large" });
            increment(skips, "too_large");
            continue;
        }
        entries.push({
            ...base,
            requestKey: request.requestKey,
            request,
            inputTokens: estimateTokens(request),
            sourceKind: "solution",
            sourceKey,
            sourceContentHash,
            candidate,
            problem,
        });
    }

    return { entries, skips, scanned: rows.length };
}

function interpret(responseText, entry) {
    return interpretRepairResponse(responseText, {
        content: entry.candidate.content,
        signals: entry.candidate.signals,
        problem: entry.problem,
    });
}

function buildProposal(entry, interpretation) {
    const { candidate } = entry;
    return {
        proposal: {
            ...interpretation.validated,
            target: {
                solution_id: candidate.solutionId,
                problem_id: candidate.problemId,
                content_format: candidate.contentFormat,
                current_content: candidate.content,
            },
            provenance: candidate.sources.map((source) => ({
                source: source.source,
                source_key: source.source_key,
                source_url: source.source_url ?? null,
            })),
        },
        validation: {
            ...repairVersions(),
            ...interpretation.validated.validation,
            replacement_is_model_written: true,
        },
    };
}

export const handler = {
    operation: REPAIR_OPERATION,
    operationVersion: OPERATION_VERSION,
    versions: repairVersions,
    scanUnit: "solutions",
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultMaxInputChars: DEFAULT_MAX_INPUT_CHARS,
    collect,
    interpret,
    buildProposal,
};
