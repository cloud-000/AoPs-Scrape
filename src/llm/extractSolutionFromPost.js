import { existsSync } from "node:fs";
import { join } from "node:path";

import { hashText } from "../db.js";
import { buildRequestIdentity, canonicalJSON } from "./cache.js";
import {
    DEFAULT_MAX_OUTPUT_TOKENS,
    estimateTokens,
    increment,
    parseChoices,
} from "./planning.js";

export const EXTRACT_OPERATION = "extract_solution_from_post";
export const OPERATION_VERSION = "2";
export const RESPONSE_CONTRACT_VERSION = "2";
export const PARSER_VERSION = "2";
export const VALIDATOR_VERSION = "2";

export const CLASSIFICATIONS = [
    "full_solution",
    "solution_sketch",
    "answer_only",
    "discussion",
    "question",
    "correction",
    "not_a_solution",
    "uncertain",
];

export const RESPONSE_SCHEMA = {
    type: "string",
    enum: CLASSIFICATIONS,
};

export const SYSTEM_PROMPT = `Classify the AoPS discussion reply using exactly one label from this list:
full_solution
solution_sketch
answer_only
discussion
question
correction
not_a_solution
uncertain

Return only the label. Do not return JSON, Markdown, punctuation, explanation, quoted source text, or any other words.
Use full_solution when the reply contains a substantially complete mathematical solution. Use solution_sketch when it contains meaningful solution reasoning but omits important details. Use answer_only when it gives an answer without meaningful reasoning. Do not solve, improve, repair, paraphrase, restate, or complete the mathematics.`;

export function buildInputSnapshot(problem, post) {
    return {
        problem: {
            statement: problem.statement,
            choices: problem.choices,
            response_kind: problem.responseKind,
            known_answer: problem.answerValue,
            test_name: problem.testName,
            problem_number: problem.problemNumber,
        },
        post: {
            topic_id: post.topic_id,
            post_id: post.post_id,
            user_id: post.poster_id ?? null,
            username: post.username ?? null,
            posted_at: post.post_time ?? null,
            content: post.post_canonical,
        },
    };
}

export function buildExtractionRequest(problem, post, modelConfig = {}) {
    const input = buildInputSnapshot(problem, post);
    const userPrompt = `Classify this input:\n${canonicalJSON(input)}`;
    const inferenceParameters = {
        temperature: modelConfig.temperature ?? 0,
        max_tokens: modelConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(modelConfig.seed == null ? {} : { seed: modelConfig.seed }),
    };
    const spec = {
        operation: EXTRACT_OPERATION,
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

export function parseExtractionResponse(text) {
    const classification = String(text ?? "").trim();
    if (!CLASSIFICATIONS.includes(classification)) {
        throw new Error(
            `Model output must be exactly one classification label; received ${JSON.stringify(classification)}`,
        );
    }
    return classification;
}

export function interpretExtractionResponse(text, context) {
    let parsed;
    try {
        parsed = parseExtractionResponse(text);
    } catch (error) {
        return { valid: false, parsed: null, validated: null, errors: [error.message], usableCount: 0 };
    }

    const solutionClass = parsed === "full_solution" || parsed === "solution_sketch";
    const rawPost = String(context.rawPost ?? "");
    if (solutionClass && !rawPost.trim()) {
        return {
            valid: false,
            parsed,
            validated: null,
            errors: ["solution classification has no source post content"],
            usableCount: 0,
        };
    }
    const validatedArtifacts = solutionClass
        ? [
              {
                  problem_number: context.problemNumber,
                  solution_spans: [
                      {
                          text: rawPost,
                          occurrence: 0,
                          start: 0,
                          end: rawPost.length,
                      },
                  ],
                  claimed_answer: null,
                  evidence: [],
              },
          ]
        : [];
    const validated = {
        classification: parsed,
        artifacts: validatedArtifacts,
        extracted_content: solutionClass ? rawPost : null,
    };
    return {
        valid: true,
        parsed,
        validated,
        errors: [],
        usableCount: solutionClass ? 1 : 0,
    };
}

export function extractionVersions() {
    return { parserVersion: PARSER_VERSION, validatorVersion: VALIDATOR_VERSION };
}

const ADMINISTRATIVE = /^(?:\[?deleted\]?|\[?removed\]?|post deleted|reserved|bump)\.?$/i;

async function readTopicArchive(cacheDir, topicId) {
    const path = join(cacheDir, `topic_${topicId}.json`);
    if (!existsSync(path)) return null;
    return await Bun.file(path).json();
}

/**
 * Enumerate the deterministic post candidates for this operation. Terminal
 * entries carry their own `disposition`; candidate entries carry a request and
 * let service.js resolve materialized/proposal/cache state.
 */
async function collect(db, options) {
    const {
        responseCacheDir = "./response_cache",
        modelId,
        modelRevision = null,
        maxTokens = DEFAULT_MAX_TOKENS,
        seed = null,
        maxInputChars = DEFAULT_MAX_INPUT_CHARS,
    } = options;
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
                .get(row.id, EXTRACT_OPERATION, `post:${post.post_id}`, sourceContentHash);
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
            entries.push({
                ...base,
                requestKey: request.requestKey,
                request,
                inputTokens: estimateTokens(request),
                sourceKind: "aops_post",
                sourceKey: `post:${post.post_id}`,
                sourceContentHash,
                rawPost,
                post,
                problem,
            });
        }
    }

    return { entries, skips, scanned: rows.length };
}

function interpret(responseText, entry) {
    return interpretExtractionResponse(responseText, {
        problemNumber: entry.problemNumber,
        choices: entry.problem.choices,
        rawPost: entry.rawPost,
    });
}

function buildProposal(entry, interpretation) {
    return {
        proposal: {
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
        },
        validation: {
            ...extractionVersions(),
            exact_span_grounded: true,
        },
    };
}

// The visible answer is one word, but a reasoning model pays for its thinking
// out of the same completion budget and the server strips that thinking from the
// returned text. Observed cost of emitting a single label against this endpoint:
// 75-471 tokens typical, 1940 at the top of the range. So the budget is sized for
// the reasoning, not for the label, and gets the shared ceiling.
//
// The one-label contract is enforced where it belongs — in the prompt and in
// parseExtractionResponse, which rejects anything that is not exactly a label.
// A short budget only truncates the model mid-thought; it never made the output
// shorter.
export const DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;
export const DEFAULT_MAX_INPUT_CHARS = 30_000;

export const handler = {
    operation: EXTRACT_OPERATION,
    operationVersion: OPERATION_VERSION,
    versions: extractionVersions,
    scanUnit: "problems",
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultMaxInputChars: DEFAULT_MAX_INPUT_CHARS,
    collect,
    interpret,
    buildProposal,
};
