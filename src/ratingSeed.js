// Pure evaluator for the rating seed policy (see rating_policy.js).
// No DB, no SQL — just rule matching + per-test curve so the logic is easy to
// reason about and reuse. Consumed by exportRatingSeedsSQL in src/export.js.

// True if `pattern` (a substring or an array of substrings, all required)
// appears case-insensitively in `name`.
function nameMatches(pattern, name) {
    const hay = (name ?? "").toLowerCase();
    const tokens = Array.isArray(pattern) ? pattern : [pattern];
    return tokens.every((tok) => hay.includes(String(tok).toLowerCase()));
}

// A rule matches a test when EVERY field it specifies matches.
function ruleMatches(rule, test) {
    if (rule.series != null && rule.series !== test.series_name) return false;
    if (rule.test_type != null && rule.test_type !== test.type) return false;
    if (
        rule.test_name_pattern != null &&
        !nameMatches(rule.test_name_pattern, test.name)
    ) {
        return false;
    }
    return true;
}

// Returns the winning rule for a test, or null. test = { series_name, type, name }.
// Among matches, highest `priority` (default 0) wins; ties break by array order
// (first declared wins). Falls back to policy.fallback (as a synthetic rule) if
// no explicit rule matches and a fallback is configured, else null.
export function matchRule(test, policy) {
    let best = null;
    let bestPriority = -Infinity;
    for (const rule of policy.rules ?? []) {
        if (!ruleMatches(rule, test)) continue;
        const priority = rule.priority ?? 0;
        if (priority > bestPriority) {
            best = rule;
            bestPriority = priority;
        }
    }
    if (best) return best;
    if (policy.fallback) {
        return { id: "fallback", ...policy.fallback };
    }
    return null;
}

// Spread rule.range [lower, upper] across ONE test by n, normalized to that
// test's own [minN, maxN]. Returns a rounded integer seed rating.
export function computeSeed(rule, n, minN, maxN) {
    const [lower, upper] = rule.range;
    if (maxN === minN) return Math.round(lower); // one-problem test
    const t = (n - minN) / (maxN - minN);
    const raw =
        rule.curve === "exp"
            ? lower * Math.pow(upper / lower, t) // geometric interpolation
            : lower + (upper - lower) * t; // linear
    return Math.round(raw);
}
