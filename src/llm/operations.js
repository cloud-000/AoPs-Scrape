// The operation registry. Everything about the LLM lifecycle that is *not*
// operation-specific — dispositions, the --limit slice, the plan summary, the
// cache/attempt/interpretation/proposal loop — lives in service.js and reads
// operations only through the handler interface below. Adding an operation is
// adding one module and one entry here, never another branch in the runner.
//
// Handler interface:
//   operation, operationVersion          identity written onto proposals
//   versions()                           { parserVersion, validatorVersion }
//   defaultMaxTokens                     inference budget the operation needs
//   defaultMaxInputChars                 deterministic oversize gate
//   collect(db, options)                 -> { entries, skips, scanned }
//   interpret(responseText, entry)       -> interpretation
//   buildProposal(entry, interpretation) -> { proposal, validation }
//
// `collect` returns two kinds of entry: terminal ones that already carry a
// `disposition` (the operation's own deterministic gates), and candidate ones
// carrying `request`/`requestKey` whose disposition service.js resolves.

import { handler as extractSolutionFromPost } from "./extractSolutionFromPost.js";
import { handler as repairSolutionFormat } from "./repairSolutionFormat.js";

export const OPERATIONS = new Map(
    [extractSolutionFromPost, repairSolutionFormat].map((handler) => [handler.operation, handler]),
);

export const DEFAULT_OPERATION = extractSolutionFromPost.operation;

export function operationNames() {
    return [...OPERATIONS.keys()];
}

export function getOperation(name) {
    const handler = OPERATIONS.get(name ?? DEFAULT_OPERATION);
    if (!handler) {
        throw new Error(
            `Unknown LLM operation: ${name}. Known operations: ${operationNames().join(", ")}`,
        );
    }
    return handler;
}
