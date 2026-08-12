import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    buildRequestIdentity,
    canonicalJSON,
    inspectCachedRequest,
    openLLMCache,
    storeAttempt,
    storeInterpretation,
    storeRequest,
} from "../src/llm/cache.js";
import { chatCompletionsURL } from "../src/llm/client.js";

const temporaryPaths = [];
afterEach(() => {
    for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spec(input = { source: "exact  $x$" }) {
    return {
        operation: "extract_solution_from_post",
        operationVersion: "1",
        responseContractVersion: "1",
        input,
        systemPrompt: "system",
        userPrompt: "user",
        responseSchema: { type: "object" },
        modelId: "local-model",
        modelRevision: "r1",
        inferenceParameters: { temperature: 0, max_tokens: 100 },
    };
}

test("canonical identity is stable, exact, and endpoint-independent", () => {
    expect(canonicalJSON({ z: 1, a: { y: 2, x: 3 } })).toBe(
        '{"a":{"x":3,"y":2},"z":1}',
    );
    const first = buildRequestIdentity(spec());
    const reordered = buildRequestIdentity({ ...spec(), modelURL: "http://device-a:8000" });
    expect(first.requestKey).toBe(reordered.requestKey);
    expect(buildRequestIdentity(spec({ source: "exact $x$" })).requestKey).not.toBe(
        first.requestKey,
    );
});

test("raw attempts and versioned interpretations are stored separately", () => {
    const directory = mkdtempSync(join(tmpdir(), "aops-llm-cache-"));
    temporaryPaths.push(directory);
    const cache = openLLMCache(join(directory, "cache.sqlite"));
    const request = spec();
    Object.assign(request, buildRequestIdentity(request));
    storeRequest(cache, request, request);
    const attempt = storeAttempt(cache, request.requestKey, {
        status: "success",
        rawResponse: { id: "response-1", model: "served-model" },
        responseText: '{"classification":"discussion","confidence":1,"artifacts":[]}',
    });
    expect(
        inspectCachedRequest(cache, request.requestKey, {
            parserVersion: "1",
            validatorVersion: "1",
        }).disposition,
    ).toBe("reparse");
    storeInterpretation(
        cache,
        request.requestKey,
        attempt.id,
        { parserVersion: "1", validatorVersion: "1" },
        { valid: true, parsed: {}, validated: {}, errors: [], usableCount: 0 },
    );
    expect(
        inspectCachedRequest(cache, request.requestKey, {
            parserVersion: "1",
            validatorVersion: "1",
        }).disposition,
    ).toBe("valid_empty");
    expect(
        inspectCachedRequest(cache, request.requestKey, {
            parserVersion: "2",
            validatorVersion: "1",
        }).disposition,
    ).toBe("reparse");
    const stored = cache.query("SELECT * FROM llm_requests").get();
    expect(stored.identity_json).not.toContain("http://");
    cache.close();
});

test("OpenAI-compatible path appending preserves mounted base paths", () => {
    expect(chatCompletionsURL("http://localhost:8000")).toBe(
        "http://localhost:8000/v1/chat/completions",
    );
    expect(chatCompletionsURL("https://host/service/openai/v1/")).toBe(
        "https://host/service/openai/v1/chat/completions",
    );
    expect(chatCompletionsURL("https://host/service/openai")).toBe(
        "https://host/service/openai/v1/chat/completions",
    );
});
