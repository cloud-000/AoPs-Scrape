# LLM processing and cache design

This document records the proposed design for adding cached LLM processing to
AoPs-Scrape. It is a design note only; none of the described commands or tables
are implemented yet.

## Responsibility

LLM processing belongs in AoPs-Scrape, after AoPS, wiki, and comp-OCR/PDF data
have been imported and merged. comp-OCR remains a source producer. The LLM is a
transformer, extractor, auditor, or generator over the merged data; it is not a
fourth source tier alongside `aops_*`, `wiki_*`, and `pdf_*`.

The intended pipeline is:

```text
scrape/import -> deterministic preprocess/audit -> LLM plan/run
              -> review/materialize proposals -> build -> sync-export
```

## Separate cache, proposals, and canonical data

These are deliberately separate concepts:

- The **LLM cache** answers whether an identical inference has already run.
- An **LLM proposal** records what that inference suggests for this project.
- **Materialization** applies an accepted proposal through the normal domain
  tables and merge rules.

The cache should live in a separate SQLite database, defaulting to
`./llm_cache.sqlite` and overridable with `LLM_CACHE_PATH`. Clearing or rebuilding
`aops_problems.sqlite` must not destroy expensive model responses.

The main database should store reviewable proposals and the cache `request_key`.
Once accepted, ordinary production data must be self-contained: `build` and
`sync-export` should not require `llm_cache.sqlite` or `response_cache`.

## Model configuration

Use the OpenAI-compatible endpoint configured in `.env.js`:

- `MODEL_URL`
- `MODEL_ID`
- optional `MODEL_REVISION`, manually bumped when weights, quantization,
  templates, or other output-affecting deployment details change

Assume the chat-completions protocol initially, use temperature zero, and accept
JSON-in-text when the local server does not support strict JSON-schema
responses. Start with concurrency one and configurable timeout/token limits.
When constructing the base URL, append `/v1` only when the URL pathname does
not already end in `/v1`; do not strip or replace other path components because
an endpoint may be mounted below a path such as `/service/openai/v1`.

`MODEL_URL` is not part of cache identity: moving the same deployment between
devices should not invalidate results. `MODEL_ID` and `MODEL_REVISION` are part
of the identity. Record the model id returned by the server, response id, and
server fingerprint when available. Never persist authorization headers, API
keys, or other endpoint secrets in either cache database.

## Exact cache identity

Use SHA-256 over canonical JSON containing only inputs that can affect the
operation:

```text
cache protocol version
operation name and version
exact operation-specific input snapshot
system/user prompt hashes
response schema hash
model id and revision
temperature, token limit, seed, and other inference parameters
sample index (when intentionally sampling)
```

Do not hash entire database rows. For example, changing difficulty should not
invalidate solution extraction. Exact source strings should initially be hashed
without whitespace normalization so meaningful LaTeX edits cannot accidentally
reuse an old result.

Store the raw provider response separately from its parsed interpretation. A
change to a local result parser or validator should create a new interpretation
of the cached raw response without calling the model again. A change to the
prompt, input, schema sent to the model, model revision, or inference parameters
should produce a new request key.

Keep four version concepts distinct:

```text
operation_version
  semantic task or prompt contract

response_contract_version
  JSON shape requested from the model; part of request identity

parser_version
  local parsing/repair of a raw response; reuses the inference

validator_version
  local acceptance checks over a parsed artifact; reuses the inference
```

Suggested cache concepts:

```text
llm_requests       deterministic request identity and complete request
llm_attempts       raw responses, errors, usage, latency, and finish reason
llm_interpretations parsed artifacts keyed by parser/schema version
```

Validated negative results such as `not_a_solution`, `discussion`, `question`,
or `unknown` are cacheable successes. Transient endpoint failures should not be
cached indefinitely. A timeout or transport error is a transient failed attempt,
not `valid_empty`. A forced refresh should append another attempt rather than
overwrite history.

## AoPS posts remain in the response cache

Do not add an `aops_posts` table merely to duplicate every discussion reply.
Use the existing raw topic response cache as the corpus:

```text
problems.aops_topic_id
    -> response_cache/topic_<id>.json
    -> response.response.topic.posts_data[]
```

The cached post fields already include `post_id`, `poster_id`, `username`,
`post_canonical`, `post_time`, and `post_type`. Statement posts with
`post_type === "view_posts_text"` are excluded from reply processing.

The response cache is currently an optional performance cache and has no
freshness metadata. Durable topic archival is therefore part of the first LLM
vertical slice, not a later optimization. Separate two behaviors:

- **Read-through reuse** controls whether a scrape may use an archived response
  instead of the network.
- **Write-through archival** always records every successful topic network
  response, even when reads are disabled to force fresh data.

This permits a fresh scrape without discarding the LLM corpus. Topic archive
entries should record at least a content hash and fetch time, and refreshes
should be explicit. `llm plan` must not silently fetch missing topics; it should
report them as `missing_source`.

Only selected posts need to enter the main database. When an extracted solution
is accepted, `solution_sources.raw_content` keeps the complete original post,
while the canonical `solutions.content` may hold the grounded extracted portion.

## First operation: solution extraction from posts

The first vertical slice is `extract_solution_from_post`. It should discover
solution material missed by the current deterministic post heuristic. A later,
separate operation can refine posts already represented in `solution_sources`.

The input should contain only relevant context:

```text
resolved problem statement
choices and response kind
known answer, when present
exact AoPS post content and identity
minimal test/problem-number context needed for packed topics
```

The first implementation deliberately asks the model to **classify only**. It
must return exactly one of these labels, with no JSON, prose, Markdown, quoted
source text, confidence score, or other fields:

```text
full_solution, solution_sketch, answer_only, discussion, question,
correction, not_a_solution, uncertain
```

For `full_solution` and `solution_sketch`, local code constructs the proposal
from the complete exact `post_canonical` string: problem number and source
identity come from the database/archive, the single span is the whole post with
`occurrence = 0`, `start = 0`, and `end = post length`, evidence is empty, and
claimed answer is omitted. All structured proposal JSON is therefore
deterministic; the model never generates it. Other classifications are validated
cacheable empty results.

Using the whole post may retain surrounding discussion, but it guarantees that
the proposed solution is documentary source text rather than model-written
content. Reviewers may accept a faithful edited excerpt through the existing
review flow. Finer model-selected spans belong to a later operation only if
needed. Extraction and generation remain separate operations.

A single post may contain several solution approaches for one problem. The
whole-post policy materializes them together as one canonical solution artifact,
preserving internal labels such as `Solution 1` and `Solution 2`. This fits the
current one-source-key-per-problem constraint. If separate canonical solutions
are needed later, use source-part keys or replace the current source relation
with a many-to-many relation.

Initial eligibility should be broad enough not to recreate the deterministic
solution heuristic's blind spots. Eligible posts are non-empty substantive
replies, not `view_posts_text`, not already represented by
`solution_sources.aops_post_id` for that problem, within the configured context
limit, and unambiguously associated with a problem unless packed-topic mapping
is supported. Obvious administrative/deleted placeholders and sources with a
manual rejection for the same content hash are skipped. Planning should report
skip reasons such as `already_ingested`, `statement_post`, `empty`,
`administrative`, `too_large`, `ambiguous_problem_mapping`, and
`manual_rejection`.

All initial results are proposals requiring review. No first-version LLM result
automatically changes statements, answers, solutions, or production output.

## Planning and execution

`llm plan` is a read-only dry run. For each operation it should:

1. Select eligible problems/posts using deterministic gates.
2. Build the exact input snapshot and request key.
3. Inspect the LLM cache and existing project proposal/materialization.
4. Report a disposition without contacting the model.

Useful dispositions are:

```text
materialized       already applied to domain data
proposal_exists    awaiting review
cache_hit          reusable validated interpretation
reparse            raw response exists; interpretation version changed
valid_empty        cached result found no usable material
miss               requires a model call
missing_source     required topic cache is absent
blocked            oversized/invalid input or protected manual decision
```

The summary should show candidate counts, deterministic skips, cache hits,
true calls required, missing sources, and estimated input tokens. Planning is
recomputed initially rather than persisted.

`llm run` handles those dispositions as follows:

| Plan disposition | Run behavior |
| --- | --- |
| `materialized` | Do nothing |
| `proposal_exists` | Do nothing |
| `cache_hit` | Create the missing proposal from the validated interpretation |
| `reparse` | Reinterpret the raw response, validate it, then create/update the proposal |
| `valid_empty` | Do nothing |
| `miss` | Call the model, cache and validate the response, then create a proposal |
| `missing_source` | Report it; never fetch implicitly |
| `blocked` | Report the reason |

Possible CLI shape:

```bash
bun cli/index.js llm plan [--operation=extract_solution_from_post]
bun cli/index.js llm run [--operation=extract_solution_from_post]
bun cli/index.js llm proposals
bun cli/index.js llm show <proposal-id>
bun cli/index.js llm accept <proposal-id>
bun cli/index.js llm reject <proposal-id>
bun cli/index.js llm stats
bun cli/index.js llm inspect <request-key>
bun cli/index.js llm reparse
```

Both `plan` and `run` accept `--limit=N`. The limit selects the first `N`
eligible post candidates in the planner's deterministic problem/post order after
all eligibility gates. The plan reports the full candidate count and how many
were omitted. Passing the same limit to `plan` and `run` processes the same
bounded batch; it never increases the number of model calls beyond `N`.

## Proposal and provenance model

A generic proposal envelope can support later answer extraction, statement
audits, choice repair, reconciliation, and generation:

```text
llm_proposals
  id
  problem_id
  operation / operation_version
  request_key
  source_kind / source_key / source_content_hash
  result_index (NOT NULL, default 0)
  proposal_json
  review_status: candidate | needs_review | accepted | rejected
  currency_status: current | stale | superseded
  superseded_by_proposal_id
  status_source: auto | manual
  review metadata and timestamps
```

Review state and freshness are deliberately separate. A manually accepted
proposal remains historically accepted when its input later changes; it becomes
stale rather than losing its review decision. The new input produces a new
request key and proposal, while the accepted domain data is preserved and any
contradiction is surfaced for review. Stale unreviewed proposals may be marked
superseded.

Proposal creation must be idempotent. Use an equivalent of:

```text
UNIQUE(problem_id, operation, operation_version, request_key, result_index)
```

and index `request_key`, review/currency status, `(problem_id, operation)`, and
`(source_kind, source_key)`. A cache hit processed repeatedly must not create
duplicate proposals.

An accepted source extraction should reuse `upsertSolutionCandidate`'s
normalization and AoPS provenance conventions, but use the dedicated
materialization transaction described below:

```text
solutions.content                 grounded extracted solution
solution_sources.source          aops
solution_sources.source_key      post:<post_id>
solution_sources.raw_content     complete original post
solution_sources.aops_topic_id   originating topic
solution_sources.aops_post_id    originating post
```

A small derivation record should associate the materialized solution with its
proposal/request key and method (`llm_extract`). The AoPS post remains the source;
the LLM is the extraction method. Make that derivation explicit:

```text
llm_materializations
  id
  proposal_id
  entity_type / entity_id
  materialized_value_hash
  materialization_version
  created_at
```

`llm plan` uses this record, rather than content equality, to determine
`materialized`. Comparing the current entity hash with
`materialized_value_hash` also detects a later manual edit without mistaking it
for a failed or missing materialization.

Accepting a proposal must use a dedicated, idempotent materialization
transaction rather than only calling `upsertSolutionCandidate`. In one
transaction it should:

1. Confirm the proposal is valid, current, and not already materialized.
2. Insert or locate the normalized solution.
3. Set reviewer-approved content and `status = 'accepted'`.
4. Set `status_source = 'manual'` and store review metadata.
5. Attach/update the AoPS source with the complete raw post.
6. Insert the materialization record.
7. Mark the proposal accepted.

This explicit promotion is necessary because `upsertSolutionCandidate` does not
turn an already-existing automatic solution into a manually accepted one. The
transaction must also handle a source already attached to another automatic
solution without silently moving a manually reviewed source.

Generated answers or solutions are different: they have no documentary source,
must use distinct operations/provenance, must never be marked official, and
should require stronger review and verification.

Review may accept an edited value rather than the proposal byte-for-byte. Keep
the immutable model proposal, record the reviewer-approved value separately,
and hash the value actually materialized.

## Existing solution export behavior

Current solution ingestion remains unchanged:

- `solutions` holds normalized canonical content.
- `solution_sources` holds AoPS, wiki, manual, or import provenance.
- `preprocess` classifies and deduplicates automatic solution candidates while
  preserving manual decisions.
- `build` selects accepted, non-duplicate canonical solutions and serializes
  them into `production_problems.official_solutions`.
- `sync-export` carries `official_solutions` into `_import_problems`.

Despite the column name, `official_solutions` currently means accepted canonical
solutions; it is not restricted to rows with `is_official = true`. After any
solution or proposal is materialized, run `preprocess`, `build`, and then
`sync-export` so the exported derived table is current.

## Operation roadmap

The cache, proposal, review, and materialization machinery is intended to
support all of the operation families below. Only
`extract_solution_from_post` belongs to the first implementation slice. The
remaining operations are a capability roadmap, not implemented commands or
finalized prompt contracts.

Every operation should eventually document its purpose, deterministic
eligibility trigger, exact input snapshot, structured response contract,
validator, materialization target, trust policy, and implementation status.
Prompts and detailed schemas should be finalized when the operation is being
implemented, using lessons from the first vertical slice.

### Grounded extraction

Planned operations include:

```text
extract_solution_from_post       first implementation slice
extract_answer_from_post         answer stated in a raw reply
extract_answer_from_solution     answer buried in sourced solution prose
extract_correction_from_post     claimed typo/correction requiring review
extract_problem_mapping_from_post
```

Extraction must remain grounded in exact source material. The originating AoPS
post, wiki section, or imported document remains the documentary source; the
LLM is only the classification/extraction method. Extracted answers and
corrections are proposals and must not overwrite a verified or manually curated
value. Packed topics and multi-problem replies require explicit mappings from
artifacts to problems that validators can check.

### Format repair and restatement

Planned operations include:

```text
repair_problem_statement
repair_problem_choices
repair_solution_format
```

These operations should normally be triggered by deterministic audit findings,
not run indiscriminately over clean content. Examples include malformed LaTeX,
misleading OCR delimiters, choices attached incorrectly to a statement, broken
lists/tables, retained headers or footers, misplaced image references, and
solution-formatting defects that deterministic cleanup cannot repair safely.

Repair is a transformation rather than exact-span extraction. Its response
should contain the proposed replacement plus a structured change summary and a
claim about whether mathematical meaning changed. Validation should compare the
before/after audit findings and enforce operation-specific invariants, such as:

- preserving problem identity and required image references
- preserving choice count and order unless choice repair explicitly permits a
  change
- preserving the known answer-to-choice mapping
- avoiding newly introduced answers, assumptions, or solution text
- improving the targeted deterministic audit findings

Accepted problem and choice repairs should eventually materialize into an
explicit curated tier such as `curated_statement`, `curated_choices`, and
`curated_answer`. They must not pretend to be PDF, wiki, or AoPS source content.
Solution-format repairs should preserve the original `solution_sources`
provenance and materialize only as reviewed canonical content.

### Reconciliation and adjudication

Planned operations include:

```text
reconcile_source_answers
adjudicate_duplicate_candidate
classify_unresolved_coverage
```

These operations compare existing evidence rather than create new documentary
facts. A disagreement should normally produce a review proposal with the
supporting source values, not silently select a winner. Verified/manual data and
structural coverage declarations remain protected. Borderline duplicate
adjudication should feed the existing `problem_links` review model rather than
merge content directly.

### Generation

Planned operations include:

```text
generate_answer_candidate
generate_solution_candidate
```

Generation is eligible only after the source and extraction paths have failed to
produce the needed artifact. An answer-generation candidate should require a
valid computational problem, known response kind, complete choices for MCQ, and
no coverage declaration that makes an answer unavailable or not applicable. A
solution-generation candidate should require a statement that passes audit and
no accepted canonical solution; a trusted known answer is preferred when one
exists.

Generated artifacts have no documentary source. They must use explicit
generated provenance, remain `is_official = false`, never populate `aops_*`,
`wiki_*`, or `pdf_*`, and always require review. Generated answers and solutions
must remain distinct operations from extraction so generated mathematics cannot
masquerade as recovered source content.

### Independent verification

Planned operations include:

```text
verify_extracted_answer
verify_generated_answer
verify_generated_solution
```

Verification is a separate inference with its own input snapshot, prompt,
operation version, and cache identity. For generated work, prefer an independent
solve-and-compare pass before showing the verifier the generator's reasoning;
then inspect the proposed solution for invalid steps, missing cases, and answer
agreement. Deterministic checks such as MCQ mapping, substitution, range checks,
and formatting validation should run alongside model verification. Verification
raises or lowers confidence but does not by itself make an artifact official or
materialize it without the operation's required review.

### Suggested rollout

After the first vertical slice is stable, a reasonable order is:

1. `extract_answer_from_solution`
2. `extract_answer_from_post`
3. `extract_correction_from_post`
4. `repair_solution_format`
5. `repair_problem_statement`
6. `repair_problem_choices`
7. reconciliation and duplicate adjudication
8. `generate_answer_candidate`
9. `generate_solution_candidate`
10. independent verification operations

If repair or generation grows beyond a concise operation contract, create a
focused design document such as `cli/LLM_RESTATEMENT.md` or
`cli/LLM_GENERATION.md` and link it from this roadmap. `cli/LLM.md` remains the
canonical architecture, lifecycle, provenance, and operation index so separate
documents cannot silently redefine those shared rules.

## Open implementation details

Before or during implementation, confirm:

- the model context limit and preferred timeout/concurrency
- whether the endpoint reliably supports JSON schema and deterministic seeds
- the initial review interface and whether accepting an extraction selects a
  faithful excerpt or preserves the whole post as canonical solution content
- handling of oversized posts and packed multi-problem topics

None of these prevents implementing the cache, planner, topic-cache reader, and
review-only first operation with conservative defaults.

## First vertical slice completion criteria

The first operation is complete when it includes:

1. Durable topic write-through archival with independently controlled cache
   reads.
2. The LLM cache schema and canonical SHA-256 request identity.
3. An OpenAI-compatible client with conservative timeout and concurrency.
4. The versioned `extract_solution_from_post` prompt and response contract.
5. Broad deterministic eligibility selection and explicit skip reasons.
6. Read-only `llm plan` with hit/miss/reparse/token estimates.
7. `llm run` with cached raw responses and validated interpretations.
8. Read-only proposal listing and inspection.
9. Idempotent accept/reject and transactional materialization.
10. Tests for cache, proposal, review, and materialization idempotency.

Answer mutation, generation, restatement, duplicate adjudication, automatic
acceptance, multimodal input, and a sophisticated interactive review UI remain
outside this first slice.
