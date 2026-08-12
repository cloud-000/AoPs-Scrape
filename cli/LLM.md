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

Assume the chat-completions protocol initially, normalize whether `MODEL_URL`
already includes `/v1`, use temperature zero, and accept JSON-in-text when the
local server does not support strict JSON-schema responses. Start with
concurrency one and configurable timeout/token limits.

`MODEL_URL` is not part of cache identity: moving the same deployment between
devices should not invalidate results. `MODEL_ID` and `MODEL_REVISION` are part
of the identity.

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

Suggested cache concepts:

```text
llm_requests       deterministic request identity and complete request
llm_attempts       raw responses, errors, usage, latency, and finish reason
llm_interpretations parsed artifacts keyed by parser/schema version
```

Validated negative results such as `not_a_solution`, `discussion`, `question`,
or `unknown` are cacheable successes. Transient endpoint failures should not be
cached indefinitely. A forced refresh should append another attempt rather than
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
freshness metadata. If it becomes a durable LLM input corpus, it should
eventually be strengthened so every successful topic network request writes
through to it, refreshes are explicit, and entries record at least a content
hash and fetch time. `llm plan` must not silently fetch missing topics; it should
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

The model should classify and extract, not improve or complete the mathematics.
Suggested classifications include:

```text
full_solution, solution_sketch, answer_only, discussion, question,
correction, multiple_solutions, multiple_problems, not_a_solution, uncertain
```

The structured result should include extracted content, confidence, any claimed
answer, the associated problem number when needed, and short evidence excerpts.
Validation should confirm that evidence occurs in the supplied post, mappings
refer to valid problems, and MCQ claims map to available choices. Extraction and
generation must remain separate operations.

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
  proposal_json
  status: candidate | needs_review | accepted | rejected | superseded
  status_source: auto | manual
  review metadata and timestamps
```

Manual review decisions must survive re-planning and reprocessing. If a source
post or relevant merged context changes, the new input produces a new request
key; stale unreviewed proposals may be superseded, while manually accepted data
is preserved and any contradiction is surfaced for review.

An accepted source extraction should be materialized through
`upsertSolutionCandidate` with AoPS provenance:

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
the LLM is the extraction method.

Generated answers or solutions are different: they have no documentary source,
must use distinct operations/provenance, must never be marked official, and
should require stronger review and verification.

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

## Later operations

The same cache/proposal mechanism can support:

- extracting answers from existing solutions or raw posts
- reconciling conflicting PDF, wiki, and AoPS answers
- auditing malformed statements and choices
- proposing restatements without overwriting source tiers
- adjudicating borderline duplicate links
- generating answer or solution candidates with explicit generated provenance
- independently verifying generated or extracted candidates

Restatements should eventually materialize into an explicit curated tier (for
example `curated_statement`/`curated_choices`/`curated_answer`) rather than
pretending to be PDF, wiki, or AoPS source content.

## Open implementation details

Before or during implementation, confirm:

- whether `MODEL_URL` includes `/v1`
- the model context limit and preferred timeout/concurrency
- whether the endpoint reliably supports JSON schema and deterministic seeds
- the initial review interface and whether accepting an extraction selects a
  faithful excerpt or preserves the whole post as canonical solution content
- handling of oversized posts and packed multi-problem topics

None of these prevents implementing the cache, planner, topic-cache reader, and
review-only first operation with conservative defaults.
