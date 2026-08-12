import { expect, test } from "bun:test";

import { interpretExtractionResponse } from "../src/llm/extractSolutionFromPost.js";

test("solution classification constructs a whole-post grounded artifact locally", () => {
    const rawPost = "Idea. Since x=1, done. Idea. Since x=1, done.";
    const result = interpretExtractionResponse(
        "full_solution\n",
        { problemNumber: 4, choices: ["0", "1", "2"], rawPost },
    );
    expect(result.valid).toBe(true);
    expect(result.usableCount).toBe(1);
    expect(result.parsed).toBe("full_solution");
    expect(result.validated.extracted_content).toBe(rawPost);
    expect(result.validated.artifacts[0].problem_number).toBe(4);
    expect(result.validated.artifacts[0].solution_spans[0]).toEqual({
        text: rawPost,
        occurrence: 0,
        start: 0,
        end: rawPost.length,
    });
});

test("anything other than one exact classification label fails validation", () => {
    const result = interpretExtractionResponse(
        '{"classification":"solution_sketch"}',
        { problemNumber: 1, choices: null, rawPost: "actual source" },
    );
    expect(result.valid).toBe(false);
    expect(result.usableCount).toBe(0);
    expect(result.errors[0]).toContain("exactly one classification label");
});

test("validated negative classifications are reusable empty successes", () => {
    const result = interpretExtractionResponse(
        "question",
        { problemNumber: 1, choices: null, rawPost: "How does this work?" },
    );
    expect(result.valid).toBe(true);
    expect(result.usableCount).toBe(0);
});
