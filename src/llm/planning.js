// Small helpers and defaults shared by every LLM operation's deterministic
// planner. They are intentionally trivial: anything operation-specific belongs
// in the operation module, and anything lifecycle-related (dispositions, limit,
// summary) belongs in service.js, so a new operation only has to describe its
// own candidates.

/**
 * Completion ceiling for every operation. It caps the *completion*, not the
 * context window, so a high value costs nothing when the model stops on its own.
 *
 * It is deliberately not sized to the visible answer. A reasoning model spends
 * this budget on thinking that the server then strips from the returned text, so
 * even a one-word classification has been measured at 75-1940 completion tokens
 * against this project's endpoint. Sizing the budget to the answer truncates the
 * model mid-thought and returns nothing usable; the shape of the answer is
 * enforced by the prompt and the operation's parser, never by starving it.
 *
 * It is part of `inference_parameters`, so it is part of the request key: moving
 * it orphans every cached result. Pick it once, and use `--max-tokens` /
 * `LLM_MAX_TOKENS` for one-off experiments.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

export function estimateTokens(request) {
    return Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
}

export function increment(object, key) {
    object[key] = (object[key] ?? 0) + 1;
}

/**
 * Resolve a problem row's choice list, preferring the wiki tier over AoPS the
 * same way the resolved columns do. Malformed JSON degrades to "no choices"
 * rather than failing the whole plan.
 */
export function parseChoices(row) {
    const raw = row.wiki_choices ?? row.aops_choices;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
