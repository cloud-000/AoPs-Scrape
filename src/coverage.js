// Response-format and answer-coverage semantics for contest problems.
//
// comp-OCR emits two optional files per test folder:
//
//   test_profile.json     { response_kind, answer_status, practice_mode }
//   problem_coverage.json { "<1-based num>": { reason, answer_status, ... } }
//
// `test_profile.json` DECLARES a whole test's shape and is written for source-
// profiled families (proof families today). Contest registries can also make a
// structural declaration when the response format is intrinsic to the series:
// every AMC administration is MCQ even when a damaged source loses its choices.
// `problem_coverage.json` is a sparse per-problem EXCEPTION map for otherwise
// ordinary tests (a Guts item whose official key is blank, a tiebreaker).
//
// Test declarations and problem exceptions are different kinds of claim, and
// the schema keeps them apart:
//
//   tests.response_kind / answer_status              -- the declaration
//   problems.coverage_response_kind / coverage_...   -- the sparse override
//
// Nothing inherits: a problem's override column stays NULL unless a source
// named that problem specifically. The resolved value each consumer actually
// filters on is derived in buildProductionProblems (see db.js), the same way
// answer_value is derived from the aops_/wiki_/pdf_ tiers rather than stored
// per importer. That keeps one source of truth per fact, lets `build` self-heal
// after any re-scrape, and preserves the override/default distinction that
// tells a verified per-problem exception from an inherited test default.
//
// Only two fields are persisted. `practice_mode` from the handoff is a pure
// function of the other two in every case it enumerates, and `solution_status`
// only matters to a curation UI that does not exist yet.
//
// Operating principle: absence is not semantics. NULL means neither a source
// profile nor a structural registry has declared the field, which is different
// from an affirmative `not_applicable`. Statement parsing never guesses a
// response_kind, and `known` is deliberately NOT storable here -- it is the
// absence of a claim plus a fact about our own data, so it is derived at build
// time rather than written by whichever importer happened to touch the row.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RESPONSE_KINDS = Object.freeze([
    "mcq",
    "short_answer",
    "proof",
    "construction",
    "estimation",
    "interactive",
    "unknown",
]);

// Series-level facts, not name guesses. These labels are the canonical series
// names persisted by the importers. Keep the declaration centralized so every
// upsert path and the existing-row backfill apply exactly the same policy.
export const SERIES_RESPONSE_KIND_DECLARATIONS = Object.freeze({
    "AMC 8": "mcq",
    "AMC 10": "mcq",
    "AMC 12": "mcq",
});

export function responseKindForSeries(seriesName) {
    return Object.prototype.hasOwnProperty.call(
        SERIES_RESPONSE_KIND_DECLARATIONS,
        seriesName,
    )
        ? SERIES_RESPONSE_KIND_DECLARATIONS[seriesName]
        : null;
}

// `known` is intentionally absent: see the header note. It is a valid resolved
// value (and appears in production_problems), but never a stored claim.
export const ANSWER_STATUS_CLAIMS = Object.freeze([
    "source_missing",
    "not_applicable",
    "needs_review",
]);

// Production adds `known`, which is derived from the final answer shape rather
// than accepted from an importer. Keep the resolved vocabulary beside the
// source vocabulary so schemas and consumers never grow separate lists.
export const RESOLVED_ANSWER_STATUSES = Object.freeze([
    ...ANSWER_STATUS_CLAIMS,
    "known",
]);

const RESPONSE_KIND_SET = new Set(RESPONSE_KINDS);
const ANSWER_STATUS_SET = new Set(ANSWER_STATUS_CLAIMS);

function readJsonFile(path) {
    if (!existsSync(path)) return { state: "absent", value: null };
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            console.warn(`  expected JSON object, ignoring: ${path}`);
            return { state: "invalid", value: null };
        }
        return { state: "present", value };
    } catch {
        console.warn(`  bad JSON, ignoring: ${path}`);
        return { state: "invalid", value: null };
    }
}

// Drops values outside the known vocabulary rather than writing them through,
// so a typo upstream can't quietly become a response_kind nothing filters on.
// (The DB CHECK constraints are the backstop; this is the friendly warning.)
function validate(value, allowed, label, where) {
    if (value == null) return null;
    if (!allowed.has(value)) {
        console.warn(`  unknown ${label} "${value}" in ${where}, ignoring`);
        // `undefined` means preserve the stored field. It is deliberately
        // different from null, which is an explicit clear in a present file.
        return undefined;
    }
    return value;
}

function coverageFields(raw, where) {
    return {
        response_kind: validate(
            raw.response_kind,
            RESPONSE_KIND_SET,
            "response_kind",
            where,
        ),
        answer_status: validate(
            raw.answer_status,
            ANSWER_STATUS_SET,
            "answer_status",
            where,
        ),
    };
}

// Tagged file states keep absence or invalid JSON separate from an authoritative
// snapshot. A present empty object explicitly clears both declaration fields;
// an invalid vocabulary value is `undefined` and preserves only that field.
export function readTestProfile(testPath, where = testPath) {
    const result = readJsonFile(join(testPath, "test_profile.json"));
    if (result.state !== "present") return result;
    return { state: "present", value: coverageFields(result.value, where) };
}

// Reads the sparse per-problem exception snapshot, keyed by the OCR's 1-based
// problem number. A present map is authoritative: omitted problem keys clear
// prior overrides, while absent/invalid files preserve the stored snapshot.
export function readProblemCoverage(testPath, where = testPath) {
    const result = readJsonFile(join(testPath, "problem_coverage.json"));
    if (result.state !== "present") return result;
    const out = {};
    for (const [key, entry] of Object.entries(result.value)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            console.warn(
                `  invalid coverage entry in ${where} #${key}, ignoring`,
            );
            out[key] = {
                response_kind: undefined,
                answer_status: undefined,
            };
            continue;
        }
        const fields = coverageFields(entry, `${where} #${key}`);
        out[key] = fields;
    }
    return { state: "present", value: out };
}

// The single definition of how coverage semantics feed the coarse trainer
// filter. `is_computational` stays the broad audience filter; response_kind
// just makes it tell the truth where a source actually spoke. Only `proof`
// flips it -- an `interactive`/`estimation` item is still a computational
// contest problem and is excluded from grading by answer_status, not by this
// flag. A NULL response_kind leaves the raw value untouched.
//
// This lives here rather than in either read path because there are two: the
// problem-level derivation in buildProductionProblems and the test-level one in
// exportStagingSQL (tests are exported straight from `tests`, with no derived
// table in between). Both must agree.
export function isComputationalFor(rawIsComputational, responseKind) {
    const raw = rawIsComputational ? 1 : 0;
    if (responseKind == null) return raw;
    return responseKind === "proof" ? 0 : raw;
}

// Pure coverage resolution used by derived read models. Importers persist only
// declarations and sparse overrides; this function applies their precedence
// and derives facts that must never be stored on either source tier.
//
// Inputs deliberately use explicit field names instead of source-shaped
// objects. That makes the precedence visible at every call site and prevents a
// caller from accidentally treating an already-resolved object as an override.
export function resolveCoverage({
    overrideResponseKind = null,
    declarationResponseKind = null,
    overrideAnswerStatus = null,
    declarationAnswerStatus = null,
    hasAnswer = false,
    rawIsComputational = false,
} = {}) {
    const responseKind = overrideResponseKind ?? declarationResponseKind;
    const claimedAnswerStatus = overrideAnswerStatus ?? declarationAnswerStatus;

    return {
        responseKind,
        answerStatus: claimedAnswerStatus ?? (hasAnswer ? "known" : null),
        isComputational: isComputationalFor(rawIsComputational, responseKind),
    };
}
