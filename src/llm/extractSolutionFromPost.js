import { buildRequestIdentity, canonicalJSON } from "./cache.js";

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
        max_tokens: modelConfig.maxTokens ?? 32,
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
