// How a problem's `acgn` topic is decided.
//
// The default is CleanupText.inferACGN's keyword guess at the statement. That
// guess is least reliable exactly where the contest has already told us the
// subject: an Integration Bee item is a bare integral with no prose to key off
// (any polynomial inside it scores as Algebra), and a Calculus round is calculus
// by construction. So a round that IS a subject declaration overrides it.
//
// The declaration is not stored on `problems` or `tests` — it is a pure function
// of `tests.format`, which the importers already persist. The declaring rounds
// are marked with a `subject` in the format registries in src/testMetadata.js
// (the vocabulary lives next to the label it describes); this module owns only
// the policy of which source wins.

import { CleanupText } from "./CleanupText.js";
import { subjectForFormat } from "./testMetadata.js";

/**
 * The topic a test declares for every problem in it, or null when it declares
 * none — the common case, covering both mixed rounds (Team, Guts, General, an
 * AMC or AIME) and any test whose importer never populated `format`.
 *
 * @param {{ format?: string|null }|null|undefined} test a `tests` row
 * @returns {string|null} a TOPIC code, or null
 */
export function declaredTopic(test) {
    return subjectForFormat(test?.format);
}

/**
 * The `acgn` value to store for a problem: its test's declared topic if it has
 * one, else the keyword inference over the statement. Every write path to
 * `problems.acgn` goes through this — the insert paths in db.js (via
 * `topicForTest`) and preprocess's reclassify step, which would otherwise undo
 * the declaration on its next run.
 *
 * @param {string|null|undefined} statement
 * @param {{ format?: string|null }|null|undefined} test a `tests` row
 * @returns {string} a TOPIC code
 */
export function resolveTopic(statement, test) {
    return declaredTopic(test) ?? CleanupText.inferACGN(statement ?? "");
}
