import { existsSync } from "node:fs";
import { join } from "node:path";

import { createLLMProposal, hashText } from "../db.js";
import {
    buildExtractionRequest,
    EXTRACT_OPERATION,
    extractionVersions,
    interpretExtractionResponse,
    OPERATION_VERSION,
} from "./extractSolutionFromPost.js";
import {
    inspectCachedRequest,
    openLLMCache,
    storeAttempt,
    storeInterpretation,
    storeRequest,
} from "./cache.js";

const ADMINISTRATIVE = /^(?:\[?deleted\]?|\[?removed\]?|post deleted|reserved|bump)\.?$/i;

function parseChoices(row) {
    const raw = row.wiki_choices ?? row.aops_choices;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function readTopicArchive(cacheDir, topicId) {
    const path = join(cacheDir, `topic_${topicId}.json`);
    if (!existsSync(path)) return null;
    return await Bun.file(path).json();
}

function estimateTokens(request) {
    return Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
}

function increment(object, key) {
    object[key] = (object[key] ?? 0) + 1;
}

export async function planLLMExtraction(
    db,
    {
        cachePath = process.env.LLM_CACHE_PATH ?? "./llm_cache.sqlite",
        responseCacheDir = "./response_cache",
        modelId,
        modelRevision = null,
        maxTokens = 32,
        seed = null,
        maxInputChars = 30_000,
        limit = null,
    },
) {
    if (!modelId) throw new Error("MODEL_ID is required to compute LLM request identity");
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("LLM limit must be a positive integer");
    }
    const cache = openLLMCache(cachePath, { readOnly: true });
    const versions = extractionVersions();
    const rows = db
        .query(
            `SELECT p.id, p.n, p.statement, p.answer_value, p.aops_topic_id,
                    p.aops_post_id, p.aops_choices, p.wiki_choices,
                    COALESCE(p.coverage_response_kind, t.response_kind) AS response_kind,
                    t.name AS test_name
             FROM problems p JOIN tests t ON t.id = p.test_id
             WHERE p.aops_topic_id IS NOT NULL
             ORDER BY p.id`,
        )
        .all();
    const topicCounts = new Map();
    for (const row of rows) {
        topicCounts.set(row.aops_topic_id, (topicCounts.get(row.aops_topic_id) ?? 0) + 1);
    }

    const entries = [];
    const skips = {};
    try {
        for (const row of rows) {
            let archive;
            try {
                archive = await readTopicArchive(responseCacheDir, row.aops_topic_id);
            } catch (error) {
                entries.push({
                    disposition: "blocked",
                    reason: `invalid_topic_archive: ${error.message}`,
                    problemId: row.id,
                    topicId: row.aops_topic_id,
                });
                increment(skips, "invalid_topic_archive");
                continue;
            }
            if (!archive) {
                entries.push({
                    disposition: "missing_source",
                    reason: "missing_source",
                    problemId: row.id,
                    topicId: row.aops_topic_id,
                });
                increment(skips, "missing_source");
                continue;
            }
            if ((topicCounts.get(row.aops_topic_id) ?? 0) !== 1) {
                entries.push({
                    disposition: "blocked",
                    reason: "ambiguous_problem_mapping",
                    problemId: row.id,
                    topicId: row.aops_topic_id,
                });
                increment(skips, "ambiguous_problem_mapping");
                continue;
            }

            const posts = archive?.response?.topic?.posts_data;
            if (!Array.isArray(posts)) {
                entries.push({
                    disposition: "blocked",
                    reason: "invalid_topic_archive",
                    problemId: row.id,
                    topicId: row.aops_topic_id,
                });
                increment(skips, "invalid_topic_archive");
                continue;
            }
            const ingestedPostIds = new Set(
                db
                    .query(
                        `SELECT aops_post_id FROM solution_sources
                         WHERE problem_id = ? AND aops_post_id IS NOT NULL`,
                    )
                    .all(row.id)
                    .map((source) => source.aops_post_id),
            );
            const problem = {
                statement: row.statement,
                choices: parseChoices(row),
                responseKind: row.response_kind,
                answerValue: row.answer_value,
                testName: row.test_name,
                problemNumber: row.n + 1,
            };

            for (const post of posts) {
                const base = {
                    problemId: row.id,
                    topicId: row.aops_topic_id,
                    postId: post.post_id,
                    problemNumber: row.n + 1,
                };
                let skipReason = null;
                const rawPost = typeof post.post_canonical === "string" ? post.post_canonical : "";
                const sourceContentHash = hashText(rawPost);
                const priorMaterialization = db
                    .query(
                        `SELECT p.request_key, m.materialized_value_hash, s.content
                         FROM llm_materializations m
                         JOIN llm_proposals p ON p.id = m.proposal_id
                         LEFT JOIN solutions s
                           ON m.entity_type = 'solution' AND s.id = m.entity_id
                         WHERE p.problem_id = ? AND p.operation = ?
                           AND p.source_kind = 'aops_post' AND p.source_key = ?
                           AND p.source_content_hash = ?
                         LIMIT 1`,
                    )
                    .get(
                        row.id,
                        EXTRACT_OPERATION,
                        `post:${post.post_id}`,
                        sourceContentHash,
                    );
                if (priorMaterialization) {
                    entries.push({
                        ...base,
                        disposition: "materialized",
                        requestKey: priorMaterialization.request_key,
                        materializationDrift:
                            priorMaterialization.content != null &&
                            hashText(priorMaterialization.content) !==
                                priorMaterialization.materialized_value_hash,
                    });
                    continue;
                }
                if (post.post_type === "view_posts_text" || post.post_id === row.aops_post_id) {
                    skipReason = "statement_post";
                } else if (!rawPost.trim()) {
                    skipReason = "empty";
                } else if (post.deleted || ADMINISTRATIVE.test(rawPost.trim())) {
                    skipReason = "administrative";
                } else if (ingestedPostIds.has(post.post_id)) {
                    skipReason = "already_ingested";
                }
                if (!skipReason) {
                    const rejection = db
                        .query(
                            `SELECT id FROM llm_proposals
                             WHERE problem_id = ? AND operation = ?
                               AND source_kind = 'aops_post' AND source_key = ?
                               AND source_content_hash = ?
                               AND review_status = 'rejected' AND status_source = 'manual'
                             LIMIT 1`,
                        )
                        .get(row.id, EXTRACT_OPERATION, `post:${post.post_id}`, sourceContentHash);
                    if (rejection) skipReason = "manual_rejection";
                }
                if (skipReason) {
                    entries.push({ ...base, disposition: "blocked", reason: skipReason });
                    increment(skips, skipReason);
                    continue;
                }

                const request = buildExtractionRequest(problem, post, {
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
                const inputTokens = estimateTokens(request);
                const materialized = db
                    .query(
                        `SELECT m.id FROM llm_materializations m
                         JOIN llm_proposals p ON p.id = m.proposal_id
                         WHERE p.problem_id = ? AND p.operation = ? AND p.request_key = ?
                         LIMIT 1`,
                    )
                    .get(row.id, EXTRACT_OPERATION, request.requestKey);
                let disposition;
                let cached = null;
                if (materialized) {
                    disposition = "materialized";
                } else {
                    const proposal = db
                        .query(
                            `SELECT id FROM llm_proposals
                             WHERE problem_id = ? AND operation = ? AND operation_version = ?
                               AND request_key = ? LIMIT 1`,
                        )
                        .get(row.id, EXTRACT_OPERATION, OPERATION_VERSION, request.requestKey);
                    if (proposal) disposition = "proposal_exists";
                    else {
                        cached = inspectCachedRequest(cache, request.requestKey, versions);
                        disposition = cached.disposition;
                    }
                }
                entries.push({
                    ...base,
                    disposition,
                    requestKey: request.requestKey,
                    request,
                    cached,
                    inputTokens,
                    sourceContentHash,
                    rawPost,
                    post,
                    problem,
                });
            }
        }
    } finally {
        cache?.close();
    }

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
        operation: EXTRACT_OPERATION,
        entries: limitedEntries,
        summary: {
            problems: rows.length,
            candidates: selectedCandidateEntries.length,
            totalCandidates: allCandidateEntries.length,
            omittedCandidates,
            limit,
            dispositions,
            skips,
            trueCallsRequired: dispositions.miss ?? 0,
            estimatedInputTokens: selectedCandidateEntries.reduce(
                (sum, entry) => sum + (entry.inputTokens ?? 0),
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

function createProposalForEntry(db, entry, interpretation) {
    if (!interpretation?.valid || !interpretation.usableCount) return null;
    const proposal = {
        ...interpretation.validated,
        source: {
            topic_id: entry.topicId,
            post_id: entry.postId,
            user_id: entry.post.poster_id ?? null,
            username: entry.post.username ?? null,
            posted_at: entry.post.post_time ?? null,
            raw_content: entry.rawPost,
            source_url: `https://artofproblemsolving.com/community/c${entry.topicId}p${entry.postId}`,
        },
    };
    return createLLMProposal(db, {
        problemId: entry.problemId,
        operation: EXTRACT_OPERATION,
        operationVersion: OPERATION_VERSION,
        requestKey: entry.requestKey,
        sourceKind: "aops_post",
        sourceKey: `post:${entry.postId}`,
        sourceContentHash: entry.sourceContentHash,
        resultIndex: 0,
        proposal,
        validation: {
            ...extractionVersions(),
            exact_span_grounded: true,
        },
        reviewStatus: "needs_review",
    });
}

export async function runLLMExtraction(db, options) {
    const plan = await planLLMExtraction(db, options);
    const cache = openLLMCache(options.cachePath ?? process.env.LLM_CACHE_PATH ?? "./llm_cache.sqlite");
    const versions = extractionVersions();
    const results = [];
    try {
        for (const entry of plan.entries) {
            if (!["cache_hit", "reparse", "miss"].includes(entry.disposition)) continue;
            let interpretation;
            let attempt;
            if (entry.disposition === "cache_hit") {
                interpretation = interpretationFromRow(entry.cached.interpretation);
            } else if (entry.disposition === "reparse") {
                attempt = entry.cached.attempt;
                interpretation = interpretExtractionResponse(attempt.response_text, {
                    problemNumber: entry.problemNumber,
                    choices: entry.problem.choices,
                    rawPost: entry.rawPost,
                });
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
                interpretation = interpretExtractionResponse(response.responseText, {
                    problemNumber: entry.problemNumber,
                    choices: entry.problem.choices,
                    rawPost: entry.rawPost,
                });
                storeInterpretation(cache, entry.requestKey, attempt.id, versions, interpretation);
            }
            const proposal = createProposalForEntry(db, entry, interpretation);
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
    return { plan, results };
}

export function listLLMProposals(db, { status = null } = {}) {
    const where = status ? `WHERE p.review_status = ?` : "";
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
        .all(...(status ? [status] : []));
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
