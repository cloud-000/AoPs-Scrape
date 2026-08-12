export function chatCompletionsURL(modelURL) {
    const url = new URL(modelURL);
    const withoutTrailingSlash = url.pathname.replace(/\/+$/, "");
    if (!withoutTrailingSlash.endsWith("/v1")) {
        url.pathname = `${withoutTrailingSlash}/v1`;
    } else {
        url.pathname = withoutTrailingSlash;
    }
    url.pathname = `${url.pathname}/chat/completions`;
    return url.toString();
}

export class OpenAICompatibleClient {
    constructor({ modelURL, modelId, apiKey = null, timeoutMs = 120_000, fetchImpl = fetch }) {
        if (!modelURL) throw new Error("MODEL_URL is required");
        if (!modelId) throw new Error("MODEL_ID is required");
        this.endpoint = chatCompletionsURL(modelURL);
        this.modelId = modelId;
        this.apiKey = apiKey;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
    }

    async complete({ systemPrompt, userPrompt, inferenceParameters }) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const started = performance.now();
        try {
            const headers = { "content-type": "application/json" };
            if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
            const response = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.modelId,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                    ],
                    ...inferenceParameters,
                }),
            });
            const rawText = await response.text();
            let rawResponse;
            try {
                rawResponse = JSON.parse(rawText);
            } catch {
                throw Object.assign(new Error(`Model returned non-JSON HTTP response (${response.status})`), {
                    errorType: "invalid_http_response",
                    providerBody: rawText.slice(0, 2000),
                    transient: response.status >= 500,
                });
            }
            if (!response.ok) {
                throw Object.assign(
                    new Error(rawResponse?.error?.message ?? `Model request failed with HTTP ${response.status}`),
                    {
                        errorType: `http_${response.status}`,
                        providerBody: rawResponse,
                        transient: response.status === 429 || response.status >= 500,
                    },
                );
            }
            const choice = rawResponse?.choices?.[0];
            const content = choice?.message?.content;
            if (typeof content !== "string") {
                throw Object.assign(new Error("Model response has no choices[0].message.content"), {
                    errorType: "missing_content",
                    providerBody: rawResponse,
                    transient: false,
                });
            }
            return {
                status: "success",
                rawResponse,
                responseText: content,
                providerModelId: rawResponse.model ?? null,
                providerResponseId: rawResponse.id ?? null,
                serverFingerprint: rawResponse.system_fingerprint ?? null,
                usage: rawResponse.usage ?? null,
                finishReason: choice.finish_reason ?? null,
                latencyMs: Math.round(performance.now() - started),
            };
        } catch (error) {
            const aborted = error?.name === "AbortError";
            return {
                status: aborted || error?.transient ? "transient_error" : "provider_error",
                rawResponse: error?.providerBody ?? null,
                errorType: aborted ? "timeout" : (error?.errorType ?? error?.name ?? "error"),
                errorMessage: aborted
                    ? `Model request timed out after ${this.timeoutMs}ms`
                    : String(error?.message ?? error),
                latencyMs: Math.round(performance.now() - started),
            };
        } finally {
            clearTimeout(timeout);
        }
    }
}
