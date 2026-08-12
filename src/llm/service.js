// Operation-agnostic LLM lifecycle: plan (read-only), run, and proposal
// listing/inspection. Operation-specific candidate selection, parsing, and
// proposal shaping live behind the handler interface in operations.js.

import { createLLMProposal } from "../db.js";
import { getOperation } from "./operations.js";
import { increment } from "./planning.js";
import {
    inspectCachedRequest,
    openLLMCache,
    storeAttempt,
    storeInterpretation,
    storeRequest,
} from "./cache.js";

function defaultCachePath(options) {
    return options.cachePath ?? process.env.LLM_CACHE_PATH ?? "./llm_cache.sqlite";
}

/**
 * Read-only dry run. Selects candidates deterministically, computes their
 * request identity, inspects the cache and existing project state, and reports
 * a disposition per candidate without contacting the model.
 */
export async function planLLMOperation(db, options = {}) {
    const handler = getOperation(options.operation);
    if (!options.modelId) {
        throw new Error("MODEL_ID is required to compute LLM request identity");
    }
    const limit = options.limit ?? null;
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("LLM limit must be a positive integer");
    }

    const versions = handler.versions();
    const collected = await handler.collect(db, {
        maxTokens: handler.defaultMaxTokens,
        maxInputChars: handler.defaultMaxInputChars,
        ...options,
    });
    const entries = collected.entries;

    const cache = openLLMCache(defaultCachePath(options), { readOnly: true });
    try {
        for (const entry of entries) {
            if (entry.disposition || !entry.requestKey) continue;
            const materialized = db
                .query(
                    `SELECT m.id FROM llm_materializations m
                     JOIN llm_proposals p ON p.id = m.proposal_id
                     WHERE p.problem_id = ? AND p.operation = ? AND p.request_key = ?
                     LIMIT 1`,
                )
                .get(entry.problemId, handler.operation, entry.requestKey);
            if (materialized) {
                entry.disposition = "materialized";
                continue;
            }
            const proposal = db
                .query(
                    `SELECT id FROM llm_proposals
                     WHERE problem_id = ? AND operation = ? AND operation_version = ?
                       AND request_key = ? LIMIT 1`,
                )
                .get(entry.problemId, handler.operation, handler.operationVersion, entry.requestKey);
            if (proposal) {
                entry.disposition = "proposal_exists";
                continue;
            }
            entry.cached = inspectCachedRequest(cache, entry.requestKey, versions);
            entry.disposition = entry.cached.disposition;
        }
    } finally {
        cache?.close();
    }

    // The limit applies to candidates only, after every eligibility gate, in the
    // planner's deterministic order. Terminal entries stay in the report.
    const allCandidateEntries = entries.filter((entry) => entry.requestKey);
    const selectedCandidateEntries =
        limit == null ? allCandidateEntries : allCandidateEntries.slice(0, limit);
    const selectedCandidateSet = new Set(selectedCandidateEntries);
    const limitedEntries = entries.filter(
        (entry) => !entry.requestKey || selectedCandidateSet.has(entry),
    );
    const omittedCandidates = allCandidateEntries.length - selectedCandidateEntries.length;
    const dispositions = {};
    for (const entry of limitedEntries) increment(dispositions, entry.disposition);
    return {
        operation: handler.operation,
        scanUnit: handler.scanUnit,
        entries: limitedEntries,
        summary: {
            // `problems` is the historical name for "units the planner scanned";
            // `scanUnit` says what they actually are for this operation.
            problems: collected.scanned,
            scanned: collected.scanned,
            candidates: selectedCandidateEntries.length,
            totalCandidates: allCandidateEntries.length,
            omittedCandidates,
            limit,
            dispositions,
            skips: collected.skips,
            trueCallsRequired: dispositions.miss ?? 0,
            estimatedInputTokens: selectedCandidateEntries.reduce(
                (sum, entry) => sum + (entry.inputTokens ?? 0),
                0,
            ),
            // Only the `miss` entries are actually sent, so this is the figure to
            // quote next to the call count; estimatedInputTokens above covers
            // every selected candidate including the ones already answered.
            estimatedCallTokens: selectedCandidateEntries.reduce(
                (sum, entry) =>
                    entry.disposition === "miss" ? sum + (entry.inputTokens ?? 0) : sum,
                0,
            ),
        },
    };
}

function interpretationFromRow(row) {
    if (!row) return null;
    return {
        valid: row.status === "valid",
        parsed: row.parsed_json ? JSON.parse(row.parsed_json) : null,
        validated: row.validated_json ? JSON.parse(row.validated_json) : null,
        errors: row.validation_errors_json ? JSON.parse(row.validation_errors_json) : [],
        usableCount: row.usable_count,
    };
}

function createProposalForEntry(db, handler, entry, interpretation) {
    if (!interpretation?.valid || !interpretation.usableCount) return null;
    const { proposal, validation } = handler.buildProposal(entry, interpretation);
    return createLLMProposal(db, {
        problemId: entry.problemId,
        operation: handler.operation,
        operationVersion: handler.operationVersion,
        requestKey: entry.requestKey,
        sourceKind: entry.sourceKind,
        sourceKey: entry.sourceKey,
        sourceContentHash: entry.sourceContentHash,
        resultIndex: 0,
        proposal,
        validation,
        reviewStatus: "needs_review",
    });
}

export async function runLLMOperation(db, options = {}) {
    const handler = getOperation(options.operation);
    const plan = await planLLMOperation(db, options);
    const cache = openLLMCache(defaultCachePath(options));
    const versions = handler.versions();
    const results = [];
    // A run that creates nothing is the normal steady state: every candidate
    // already had a proposal, a materialization, or a cached empty result. Those
    // entries are counted here so the caller can say *why* nothing happened
    // instead of reporting an empty object.
    const noops = {};
    let modelCalls = 0;
    let cacheReuse = 0;
    try {
        for (const entry of plan.entries) {
            if (!["cache_hit", "reparse", "miss"].includes(entry.disposition)) {
                increment(noops, entry.disposition);
                continue;
            }
            if (entry.disposition === "miss") modelCalls++;
            else cacheReuse++;
            let interpretation;
            let attempt;
            if (entry.disposition === "cache_hit") {
                interpretation = interpretationFromRow(entry.cached.interpretation);
            } else if (entry.disposition === "reparse") {
                attempt = entry.cached.attempt;
                interpretation = handler.interpret(attempt.response_text, entry);
                storeInterpretation(cache, entry.requestKey, attempt.id, versions, interpretation);
            } else {
                storeRequest(cache, entry.request, entry.request);
                const response = await options.client.complete({
                    systemPrompt: entry.request.systemPrompt,
                    userPrompt: entry.request.userPrompt,
                    inferenceParameters: entry.request.inferenceParameters,
                });
                attempt = storeAttempt(cache, entry.requestKey, response);
                if (response.status !== "success") {
                    results.push({ entry, status: response.status, error: response.errorMessage });
                    continue;
                }
                interpretation = handler.interpret(response.responseText, entry);
                storeInterpretation(cache, entry.requestKey, attempt.id, versions, interpretation);
            }
            const proposal = createProposalForEntry(db, handler, entry, interpretation);
            results.push({
                entry,
                status: interpretation.valid
                    ? interpretation.usableCount
                        ? "proposal"
                        : "valid_empty"
                    : "invalid",
                proposalId: proposal?.id ?? null,
                errors: interpretation.errors,
            });
        }
    } finally {
        cache.close();
    }
    const statuses = {};
    for (const row of results) increment(statuses, row.status);
    return {
        plan,
        results,
        summary: { statuses, noops, modelCalls, cacheReuse, acted: results.length },
    };
}

// Backwards-compatible names for the first vertical slice.
export function planLLMExtraction(db, options = {}) {
    return planLLMOperation(db, { ...options, operation: options.operation ?? undefined });
}

export function runLLMExtraction(db, options = {}) {
    return runLLMOperation(db, { ...options, operation: options.operation ?? undefined });
}

export function listLLMProposals(db, { status = null, operation = null } = {}) {
    const conditions = [];
    const parameters = [];
    if (status) {
        conditions.push("p.review_status = ?");
        parameters.push(status);
    }
    if (operation) {
        conditions.push("p.operation = ?");
        parameters.push(operation);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return db
        .query(
            `SELECT p.id, p.problem_id, p.operation, p.operation_version,
                    p.request_key, p.source_kind, p.source_key,
                    p.review_status, p.currency_status, p.status_source,
                    p.reviewed_by, p.reviewed_at, p.created_at,
                    t.name AS test_name, pr.n
             FROM llm_proposals p
             JOIN problems pr ON pr.id = p.problem_id
             JOIN tests t ON t.id = pr.test_id
             ${where}
             ORDER BY p.id DESC`,
        )
        .all(...parameters);
}

export function showLLMProposal(db, id) {
    const row = db
        .query(
            `SELECT p.*, t.name AS test_name, pr.n, pr.statement,
                    m.entity_type, m.entity_id, m.materialized_value_hash
             FROM llm_proposals p
             JOIN problems pr ON pr.id = p.problem_id
             JOIN tests t ON t.id = pr.test_id
             LEFT JOIN llm_materializations m ON m.proposal_id = p.id
             WHERE p.id = ?`,
        )
        .get(id);
    if (!row) return null;
    return {
        ...row,
        proposal: JSON.parse(row.proposal_json),
        validation: JSON.parse(row.validation_json),
    };
}
