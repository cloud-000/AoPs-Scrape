# AoPS AJAX API & ForumSession Reference

## AoPS AJAX Endpoint

All requests are sent as `POST` to:

```
https://artofproblemsolving.com/m/community/ajax.php
```

The body is `application/x-www-form-urlencoded`. Every request includes three authentication fields plus method-specific fields:

| Field | Type | Description |
|---|---|---|
| `aops_logged_in` | `"0"` or `"1"` | Whether the session is logged in |
| `aops_user_id` | string | Numeric AoPS user ID |
| `aops_session_id` | string | Session token from browser cookie |

If full browser headers are available (copied from DevTools), they are merged into the request to avoid Cloudflare blocks.

---

## AJAX Methods

### `fetch_topic`

Fetches a single forum topic (problem thread) and all its reply posts.

**Payload fields:**

| Field | Value |
|---|---|
| `a` | `["fetch_topic"]` |
| `topic_id` | `[id]` — the numeric topic ID as a string |

**Response shape (`.response.topic`):**

```js
{
  topic_id: number,
  posts_data: [
    {
      post_id: number,
      post_canonical: string,  // BBCode/LaTeX source
      post_rendered: string,   // HTML rendered version
      post_type: string,
    },
    // ...
  ]
}
```

**Used for:** Fetching a problem's discussion thread to extract `\boxed{…}` answers from reply posts (`searchTopicForAnswer`).

---

### `fetch_category_data`

Fetches a category's metadata and its first page of child items (problems, sub-folders, or section markers).

**Payload fields:**

| Field | Value |
|---|---|
| `a` | `["fetch_category_data"]` |
| `category_id` | `[id]` — the numeric category ID as a string |

**Response shape (`.response`):**

```js
{
  category: {
    category_id: number,
    category_name: string,
    items: [ /* see item shape below */ ],
  },
  no_more_items: boolean,
}
```

**Used for:** Initial load of any test or folder category. If `no_more_items` is false, additional pages are fetched via `fetch_items_categories`.

---

### `fetch_items_categories`

Paginates through a category's items beyond the initial `fetch_category_data` response.

**Payload fields:**

| Field | Value |
|---|---|
| `a` | `["fetch_items_categories"]` |
| `parent_category_id` | `[id]` — the category to paginate |
| `start_num` | `[n]` — number of items already fetched (offset) |
| `seek_items` | `["1"]` |
| `sought_category_ids` | `"[]"` |
| `log_visit` | `["0"]` |

**Response shape (`.response`):**

```js
{
  new_items: [ /* item objects */ ],
  no_more_items: boolean,
}
```

**Used for:** Continuation of `_fetchCategory` when a category has more items than the initial fetch returns.

---

### `fetch_topics` (forum mode)

Fetches raw forum topics from a forum-type category. Used for contests that are not structured as test categories (e.g., `type: "forum"` entries in `contest_id.js`).

**Payload fields:**

| Field | Value |
|---|---|
| `a` | `["fetch_topics"]` |
| `category_type` | `["forum"]` |
| `category_id` | `[id]` |
| `fetch_before` | `[timestamp]` *(optional, for pagination)* — `last_post_time` of the last topic in the previous response |

**Response shape:**

```js
{
  response: {
    topics: [
      {
        topic_id: number,
        last_post_time: number,  // unix timestamp, used as pagination cursor
        // ...
      }
    ]
  },
  no_more_topics: boolean,
}
```

**Used for:** `getForum()` — fetches all posts from a raw forum category, paginating until `no_more_topics` is true.

---

## Item Shape

Items returned inside `category.items` / `new_items` from `fetch_category_data` / `fetch_items_categories`:

```js
{
  item_id: number,
  item_type: "view_posts" | "folder" | "post" | "forum" | "post_hidden",
  item_text: string,         // display label (e.g. "Problem 1", "Answer Key", "Mixer")
  post_data: {
    post_id: number,
    topic_id: number,
    post_type: "forum" | "view_posts_text" | ...,
    post_canonical: string,  // BBCode/LaTeX source of the post body
    post_rendered: string,   // HTML rendered version
  }
}
```

- `item_type === "view_posts"` → a problem post (scrape it)
- `item_type === "folder"` → a sub-folder containing more tests (recurse)
- `item_type === "post"` or `post_type === "view_posts_text"` → usually a section marker or description post (not a problem). **Two exceptions**, both routed away from the section path by `getTest`:
  - Some contests pack the entire test into one such post as a numbered list ("1. … 2. …" with MCQ choices) and expose no per-problem forum topics. `_isPackedProblemPost` detects this and feeds the post to the multi-problem path.
  - A single problem is sometimes posted as plain text rather than as a forum topic (a redacted problem, a `"Same as A5"` duplicate marker, a joke problem). AoPS labels these with the problem's own number in `item_text` (`"7"`, `"B1"`, `"12a"`), which is what distinguishes them from a header — a header has either no `item_text` or a non-label one (`"2022-23"`). `isProblemSlot` tests that label and `_handleProblemSlot` handles the item.

  Problems from either exception have `topic_id === 0` and therefore no discussion thread to mine for answers (answers stay `-1`/`null` unless an answer key supplies one).
- `item_type === "post_hidden"` → hidden/locked post (skip)

---

## ForumSession.js Reference

### Constructor

```js
new ForumSession(loggedIn, userId, sessionId, headers = null, onProblemAdd = null)
```

| Param | Type | Description |
|---|---|---|
| `loggedIn` | boolean | Whether the session is authenticated |
| `userId` | number | AoPS user ID |
| `sessionId` | string | AoPS session token |
| `headers` | object \| null | Full browser request headers (optional, bypasses Cloudflare) |
| `onProblemAdd` | function \| null | Callback fired each time a problem is added to a test (used for progress display) |

**Notable instance fields:**

- `requestDelay: [min, max]` — random delay range in ms added before each request (default `[100, 250]`). Increase if hitting rate limits.
- `debug: boolean` — logs raw API responses when true. Chatty (it dumps every forum item), so the CLI leaves it off unless `--debug`/`--verbose` is passed.
- `logger: (message) => void` — where `log()` writes (default `console.log`). The CLI points this at its live status region; a bare `console.log` issued while that region is painting is erased by the next repaint, so **all diagnostic output must go through `log()`**, never `console.log` directly.
- `onEvent: (event) => void` — structured progress hook, separate from `logger` (machine-readable, not prose). Consumer exceptions are swallowed so instrumentation can never abort a scrape. Event shapes:

  | `type` | Payload | Emitted when |
  |---|---|---|
  | `request` | `{ page, cached, ms }` | An ajax call completed (`page` is `describePayload`'s label, e.g. `fetch_topic 12345`) |
  | `retry` | `{ page, kind: "cloudflare"\|"json", attempt, delayMs }` | A call is about to be retried after backoff |
  | `warn` | `{ message }` | A non-fatal anomaly the caller wants surfaced |

- `stats` — request accounting for the end-of-run summary: `requests`, `cacheHits`, `networkRequests`, `networkMs`, `slowest`, `missing`, `retries`, `challenges`. `resetStats()` clears it; the `averageNetworkMs` getter derives mean latency (`null` before any uncached request). This is what distinguishes a throttled run from a hung one — see `createScrapeProgress` in `cli/progress.js`.
- `_permissionDenied: boolean` — set to true when `E_NO_PERMISSION` is returned; causes `searchTopicForAnswer` to short-circuit for the rest of the current `getTest` call.
- `enableStickyAnswerKey: boolean` — when true, `getTest` will attempt to find a stickied answer-key post in the parent forum and apply it. Should only be true for unofficial/user-made contests. Default `false`.
- `_currentForumCategoryId: number | null` — cached forum category ID populated during `searchTopicForSolutions`; consumed and reset by `getTest`.

---

### `ForumSession.describePayload(bodyInput)` *(static)*

Returns a short human label for an ajax payload (`"fetch_topic 12345"`), reconstructed from the payload's own `a` / `*_id` fields — the forum API has no page titles. Used in `request`/`retry` events and retry messages so progress output can name what it is waiting on.

---

### `ForumSession.payload(methodType, params)` *(static)*

Builds the method-specific portion of a request body for a given `ApiMethod`.

**Input:**

| Param | Type | Description |
|---|---|---|
| `methodType` | `ApiMethod` enum value | Which AJAX method to call |
| `params` | object | `{ id }` for most methods; `{ id, start_num }` for `ITEMS_CATEGORIES` |

**Output:** A plain object with the method-specific form fields (no auth fields — those are added in `sendRequest`).

**ApiMethod values:**

| Constant | Value | AJAX method |
|---|---|---|
| `ApiMethod.TOPIC` | `0` | `fetch_topic` |
| `ApiMethod.CATEGORY_DATA` | `1` | `fetch_category_data` |
| `ApiMethod.ITEMS_CATEGORIES` | `3` | `fetch_items_categories` |
| `ApiMethod.FORUM` | `2` | `fetch_topics` |

---

### `ForumSession.inferType(name, returnNull = false)` *(static)*

Heuristically maps a category/test name to a contest type from `TYPES`.

**Input:**

| Param | Type | Description |
|---|---|---|
| `name` | string | The category name (e.g. `"2023 AMC 10A"`) |
| `returnNull` | boolean | If true, returns `null` instead of `TYPES.UNKNOWN` when no match is found |

**Output:** A `TYPES` entry object `{ name, computational, choices, answerKind }`, or `null` if `returnNull` is true and nothing matched. `answerKind` (`"mcq" | "numeric" | "proof" | null`) is the format prior a test seeds its resolve pass from (see `_finalizeComputationalAnswers`).

---

### `sendRequest(bodyInput)`

The single low-level fetch call. Adds auth fields, applies the random delay, posts to `ajax.php`, and returns parsed JSON. Retries up to 3 times on Cloudflare challenge pages (with exponential backoff) and on JSON parse failures.

If `session.cache` is set (a `ResponseCache` instance, see `src/ResponseCache.js`), `sendRequest` checks it only when that instance's read-through behavior is enabled: on a hit it returns the archived response immediately, skipping the network call and request delay. Cache keys are derived deterministically from `bodyInput` (the payload, which excludes user-specific auth fields), so archived responses are user-independent. The CLI always installs a response-cache instance for forum scrapes. `--cache` (or the prompt) enables read-through reuse; `--no-cache` forces fresh network reads.

Successful `fetch_topic` network responses are write-through archived under `./response_cache` regardless of the read-through setting, because they are the durable source corpus for LLM review. Each `topic_<id>.json` has a `topic_<id>.meta.json` sidecar containing its SHA-256 content hash and fetch timestamp, and writes use an atomic rename. Other response types are written only when read-through caching is enabled. No authentication fields or headers enter these files.

**Input:**

| Param | Type | Description |
|---|---|---|
| `bodyInput` | object | Method-specific form fields (output of `ForumSession.payload(...)`) |

**Output:** Parsed JSON response object from AoPS. Top-level shape:

```js
{ error_code?: string, response: { ... } }
```

Throws on unrecoverable Cloudflare challenges or repeated JSON parse failures.

---

### `_fetchCategory(id)`

Fetches all items from a category, paginating automatically until `no_more_items`.

**Input:** `id` — numeric category ID.

**Output:** `{ name: string, items: Item[] }` — the category name and the complete flat list of all child items.

Throws if the API returns an `error_code` or if the category is not found.

---

### `getTest(id, testType = null, seenTopicIds = [])`

Fetches and parses a single test category into a structured test object.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the test |
| `testType` | `TYPES` entry \| null | Fallback type if the name heuristic returns null |
| `seenTopicIds` | number[] | List of `topicId`s already processed (prevents duplicates in multi-test scrapes) |

**Output:**

```js
{
  id: number,
  name: string,
  year: number | null,
  division?: string | null,       // structured audience/level when known
  divisionOrder?: number | null,  // stable sibling division order
  format?: string | null,         // structured variant when known
  formatOrder?: number | null,    // stable sibling format order
  type: string,             // e.g. "AMC 10", "AIME", "AMO"
  computational: boolean,
  answerKind: string | null, // "mcq" | "numeric" | "proof" | "mixed" | null — decided from the problems' own evidence
  sections: string[],       // empty array if no sections; a leading "" is the unnamed lead section
  problems: Problem[] | Problem[][],  // flat if no sections; nested array if sectioned
  count: number,            // total number of problems scraped
}
```

**Problem shape:** (built via the `makeProblem()` factory; full typedef in `src/types.js`)

```js
{
  statement: string,        // cleaned LaTeX/BBCode
  n: number,                // 0-based problem index
  section: number,          // section index; -1 if the test has no sections
  topicId: number | null,
  postId: number | null,
  choices: string[] | null, // MCQ options; null for numeric / proof-based
  answerIndex: number,      // index into choices for MCQ; -1 if numeric/unknown
  answerValue: string | null, // literal answer: letter for MCQ, number for numeric; null if unknown
  solutions: Solution[],    // classified solution posts
  posts: ForumPost[],       // all discussion posts (used for OLY solution curation)
}
```

Numeric answers: computational tests without MCQ choices (AIME, ARML, COMP, COLLEGE, …) keep `choices = null` and `answerIndex = -1`; the known answer lives in `answerValue` (set by `_setNumericAnswer`) and may be any string (LaTeX, fraction, word). MCQ problems have `choices` populated, `answerIndex` pointing at the correct option, and `answerValue` holding the option letter. Whether a given problem is treated as MCQ vs. numeric is decided per-test by the resolve pass (`_finalizeComputationalAnswers`), not by the contest name alone — see the answer-resolution note under `searchTopicForAnswer`. A tie/off-by-one MCQ-vs-numeric split leaves the test `answerKind: "mixed"` with each problem keeping its own kind.

`answerKind` is scrape-time parsing state, not a database column. Durable response-format declarations use `tests.response_kind`: `upsertTest` applies the structural series policy from `coverage.js`, so every AMC test persists as `response_kind='mcq'` even when choice extraction fails. Test-level `answer_status` remains unset for AMC; `known` is derived per problem during `build`.

Sections: the item walk never writes `problems` directly. It appends every problem to the current **bucket** — one implicit unnamed bucket up front, one more per section header (`ctx.buckets`) — and `_normalizeSections(test, ctx)` converts the buckets into the published shape once, before any consumer reads it. That is what makes the flat-or-nested union safe to resolve by checking `problems[0]`: the array can never hold a mix of problems and section buckets, which is what a header arriving after already-collected problems used to produce.

Materialization rules, in order: a bucket opened by a logistics header (`CleanupText.isLogisticsHeader` — "10 problems for 75 minutes") is un-named, since that header introduces the test itself rather than a part of it; buckets no problem landed in are dropped (a trailing or duplicated header, or the lead bucket of a test that opens with a header); one surviving bucket publishes flat `problems` with `sections: []`; two or more publish `problems[sectionIndex][problemIndex]` with `sections[sectionIndex]`. `problem.section` is stamped here — the bucket index, or `-1` when flat.

Buckets are never merged, however few problems one holds: a trailing round with a single problem ("Team Round", a one-problem `"shortlisted"` appendix) stays its own section. Merging it would carry its restarted numbering into the previous section, where the DB's `(test_id, n)` key would collapse it onto that section's first problem.

An unnamed bucket that survives alongside named ones (a test whose problems are followed by a `"shortlist"` header or by tiebreaker rounds) is published with the empty name `""`: its problems are the test proper and the named buckets are what the headers introduced. `db.js` names that row after the test alone, so a category previously scraped flat merges onto its existing row rather than duplicating.

When exactly one bucket survives, its header is checked via `CleanupText.extractSectionLabel`: an identifying label ("High School", "Middle School", or an A/B test/version letter) is appended to `name` (e.g. `"2023 Purple Comet"` → `"2023 Purple Comet Middle School"`) and retained as normalized `division` or `format` metadata; noise headers (problem counts, time limits, …) are dropped. Multi-section AIME I/II and `Day N` labels are normalized when their separate test rows are stored. The AIME I/II rename requires both section labels to be administration dates ("March 13th") or roman numerals — AoPS heads each half of an official AIME category with a numeral followed by its date, and the walk keeps the date. A mock AIME split into two named rounds ("Individual Round"/"Team Round") or followed by an appendix keeps its own labels.

Review metadata is nullable presentation data only. It is populated from structured section information at ingestion, never inferred by a generic pass over finished display names, and does not participate in test identity. An omitted property means the source has no classification to contribute; an explicit `null` clears a stale classification during upsert.

Name normalization: the category name is passed through `CleanupText.normalizeContestName` before it becomes the test/series name (currently rewrites `"Purple Comet Problems"` → `"Purple Comet"`).

Non-header `view_posts_text` items: a description item is only routed to `_handleSectionMarker` after two checks. `_isPackedProblemPost(item, ctx)` asks whether it contains multiple numbered problems (`CleanupText.checkContainsMultiple`) and, if so, feeds it to `_handleProblemItem` (multi-problem split); otherwise `isProblemSlot(item)` asks whether AoPS labeled it with a problem number and, if so, feeds it to `_handleProblemSlot`. These two paths are the only ones that produce problems with `topicId === 0`/`null`. Every statement emitted by the packed-post path passes through `CleanupText.cleanProblem`, just like a single-topic statement.

Known non-problem topic bodies are classified before either single- or packed-problem construction. A contest-description topic is skipped without consuming a number; a solution body standing in for a missing official problem reserves that number but produces no row, keeping all later problem numbers and answer-key entries aligned. The predicates are deliberately exact source signatures in `CleanupText.nonProblemPostDisposition`, not a general prose classifier.

Answer keys: before walking the problem list (and only for computational tests), `getTest` calls `_extractInCategoryAnswerKey(items, name)` to look for an answer key shipped inside the category itself (a `post_hidden` item whose `item_text` matches `/answers?\s*key/i`). Every item matching that predicate is excluded from the structural problem/section walk, so a `view_posts_text` answer key cannot become a section marker. The parsed key is retained and applied only **after the resolve pass** via `_applyForumAnswerKey`. `parseAnswerKey` handles several layouts — bare letters/short numbers (`4. D`), `$…$` math (`4. $\frac{17}{6}$`), and free-form lists with optional `| author` annotations (`3. 1018081 | james4l`).

When a post packs several **competing** keys — one per subtest, each numbered from 1 — the right one is chosen **before** any of those formats run (`_competingAnswerBlocks` → `_bestLabeledBlock`). That ordering matters: the format cascade scans the whole post and keeps the first entry it finds per number, so two keys parsed together interleave (the first block's answer wins for one number, a later block's for the next wherever the first block's line didn't match that format). Both layouts posters use are recognized: `[hide=label]` blocks, and plain heading lines above each list (`"Algebra\n1. 3\n…\nGeometry\n1. 49\n…"`, headings BBCode-stripped). Blocks are scored by how many of their label's words `name` also uses, and when nothing matches, a label that calls itself the answers beats one that doesn't (a "Scores" leaderboard is numbered from 1 too). A key merely *split* across blocks by range (`[hide=1-5]…[hide=6-10]…`) has only one block starting at 1, so it is left alone and still merges. If the chosen block parses to nothing, the whole post is parsed as before. Only when no in-category key is present does it fall back to the stickied-forum lookup (`_fetchStickyAnswerKey`, gated by `enableStickyAnswerKey`). The in-category key requires no extra request — it comes from the data already fetched by `_fetchCategory`.

---

### `_extractInCategoryAnswerKey(items, name = null)`

Finds and parses an answer key embedded in a test category's own item list.

**Input:**

| Param | Type | Description |
|---|---|---|
| `items` | object[] | The category items array returned by `_fetchCategory(id)` |
| `name` | string \| null | Test name, forwarded to `parseAnswerKey` to disambiguate multi-key posts |

**Output:** `Record<string, string>` mapping 1-based problem number to answer string, or `null` if no answer-key item is found or it parses to nothing.

Selects the first item with `item_type === "post_hidden"` whose `item_text` matches `/answers?\s*key/i`, then runs `CleanupText.parseAnswerKey(post_canonical, name)`. `getTest` uses the same predicate to exclude every matching item from its structural problem/section walk, then applies the parsed result after answer resolution. No network request.

---

### `getAllTests(id, type = null, shownDepth = 1, seenCategoryIds = new Set(), returnSeen = false)`

Recursively scrapes a folder hierarchy, returning a tree of test results.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the top-level folder |
| `type` | `TYPES` entry \| null | Type override propagated to child tests |
| `shownDepth` | number | Controls tree nesting: at depth > 0 sub-folders are wrapped as `{ name, tests[], count }`; at depth ≤ 0 their children are flattened into the parent's `tests[]` |
| `seenCategoryIds` | Set\<number\> | Set of category IDs already visited (prevents infinite recursion) |
| `returnSeen` | boolean | If true, includes the `seenCategoryIds` set in the return value |

**Output:**

```js
{
  id: number,
  name: string,
  tests: (TestResult | FolderResult)[],  // mix of getTest results and nested getAllTests results
  count: number,
  seenCategoryIds?: Set<number>,  // only present if returnSeen is true
}
```

Items with `item_type === "folder"` are recursed; `item_type === "view_posts"` items are passed to `getTest`. Items in `CONTEST_IDS.IGNORE` or already in `seenCategoryIds` are skipped.

---

### `listTests(id, seenCategoryIds = new Set(), _isRoot = true)`

Metadata-only walk of a series/folder. Mirrors `getAllTests`' traversal (same filtering: skips `forum`/`post` items, `CONTEST_IDS.IGNORE`, and already-seen ids; recurses `folder` items) but fetches **no problems** — it only enumerates the leaf tests. Used by the CLI's "Add single test to series" method so the user can pick one test out of a series to scrape without re-scraping the whole folder.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the top-level folder |
| `seenCategoryIds` | Set\<number\> | Category IDs already visited (prevents infinite recursion across nested folders) |
| `_isRoot` | boolean | Internal recursion flag; callers omit it |

**Output:**

```js
{
  seriesName: string,              // normalized name of the top-level folder
  tests: { id: number, name: string }[],  // flat list of leaf tests (view_posts), names normalized
}
```

The `id` of each returned leaf test is a valid category id that can be passed straight to `getTest`. `seriesName` matches the series name a full `getAllTests` scrape would produce, so a single test wrapped as `{ id, name: seriesName, tests: [test] }` and passed to `upsertScrapeResults` attaches to the same series row.

---

### `getForum(id, checkToStop = null)`

Fetches all topics from a raw forum-type category, paginating via `fetch_before` until exhausted.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the forum |
| `checkToStop` | function \| null | Optional `(posts) => boolean` predicate; if it returns true after a page, pagination stops early |

**Output:** `Post[]` — flat array of raw topic objects from the AoPS response. These are not parsed into the structured problem format; callers handle extraction themselves.

---

### `searchTopicForAnswer(id, searchManyProblems = false)`

Fetches a problem topic's discussion thread and extracts the answer from reply posts.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | Topic ID of the problem |
| `searchManyProblems` | boolean | If true, scans `[hide=S N]…[/hide]` tags for multiple numbered answers (used when a single post contains multiple problems) |

**Output:**
- If `searchManyProblems` is false: `string | null` — the selected `\boxed{…}` content (resolved with a `numeric` validator, i.e. any box accepted), or `null` if none found.
- If `searchManyProblems` is true: `Record<string, string>` — map of problem number string → selected boxed answer.
- Returns `null` (and sets `_permissionDenied = true`) if the API returns `E_NO_PERMISSION`; subsequent calls within the same `getTest` are short-circuited.
- Returns empty results immediately for a falsy `id` (e.g. `0`), since packed-post problems have no backing discussion topic.

**Side effect:** caches `topic.category_id` from the response into `this._currentForumCategoryId` (used by `_fetchStickyAnswerKey`).

`searchTopicForAnswer` is a thin wrapper over `searchTopicForSolutions(id, searchManyProblems, isOly=false, statementPostId=null)`, which returns **raw candidate material**, not a resolved answer: `{ answerPosts, answerPostsByProblem, solutions, posts }` — `answerPosts` (reply post contents in order, for single-problem selection), `answerPostsByProblem` (number → array of `[hide=S N]` block contents, for packed multi-problem posts), `solutions` (classified solution posts), and `posts` (all discussion posts, populated only when `isOly` is true).

**Which posts become `solutions`.** Two exclusions run before `_isSolutionPost`: `post_type === "view_posts_text"` (the API's marker for the statement post) and `statementPostId`, the problem's own `post_id`, passed down by `_handleSingleProblem` / `_handleMultiProblem`. The second exists because the older contest collections (AJHSME-era AMC 8, and others where a moderator pasted the problems in) carry the statement as an *ordinary* reply with no `view_posts_text` marker — and since that moderator is usually in `SOLUTIONS_USERS`, the statement matched `_isSolutionPost` and was stored as a solution of itself. Excluding it by id is structural: a problem's own statement is never its solution, whatever the post looks like. `_isSolutionPost` then accepts a post on a `[hide=…solution…]` tag, a QED marker, a `\boxed{}`, a leading "Proof"/"Solution"/"Sol.", or a `SOLUTIONS_USERS` author **whose post also clears `_hasSolutionSubstance`** (≥25 words, or ≥12 with math, or a `\boxed{}`, measured with `[quote]` blocks stripped). The author condition is qualified because these users also moderate the forums: taking the author alone as proof admitted one-line asides ("This should really be in the AMC forum.") as solutions, which the classifier — which reads a known author as an official hint — then auto-accepted into production. The actual `\boxed{}` pick is deferred to the caller: `getTest`'s resolve pass (`_finalizeComputationalAnswers` → `_resolveProblemAnswer`) runs `CleanupText.selectBoxedAnswer` with the test's decided answer kind and each problem's choices, so a post that boxes intermediate steps can't force the first box to win. `searchTopicForAnswer` itself resolves with a `numeric` validator since it has no test context.

**Answer resolution (`_finalizeComputationalAnswers` / `_resolveProblemAnswer`):** after all problems in a computational test are built (each carries stashed raw `_answerPosts`), `getTest` decides the test's `answerKind` from the problems' own evidence: it counts how many have extractable MCQ choices (`extractChoices(statement).length >= 3`) or a recognized composite visual-choice block versus not, and `CleanupText.decideTestKind` forces every problem to the majority kind when the counts differ by ≥2, or leaves the test **mixed** (each problem keeps its own detected kind) on a tie/off-by-one. A test whose name identifies it as an AIME practice set is always kept mixed, because those user-created sets intentionally combine MCQ and numeric items. Choice extraction recognizes current `\textbf{(A)}` labels; historical `\text{(A)}`, `\mathrm{(A)}`, `\textrm{(A)}`, `\mathbf{(A)}`, `\hbox{(A)}`, and `(\mathrm{A})` forms; plain `A.`/`A)` rows; and the observed malformed command variants used by older AMC pages. When all options live inside one image or Asymptote program, `extractVisualChoiceLabels` stores the presentation identities (`["A", "B", "C", "D", "E"]`) and deliberately retains the composite visual in the statement; explicit parenthesized visual labels determine the count, with five as the fallback for a known AMC visual-selection prompt. Then each problem is resolved: ordinary MCQ extracts choices and strips their appended presentation block from the statement, while visual-only MCQ retains its image; both pick a choice-valid box (`selectBoxedAnswer` + `choiceIndexOfAnswer`, so `answerValue` is a letter and `answerIndex` the option). Numeric takes the selected box verbatim (any string). A problem resolved as MCQ with fewer than three choices logs a warning rather than silently looking numeric. The contest-name type (`inferType`) is only a prior — it decides proof-vs-computational and seeds the non-MCQ kind, but the problems vote on MCQ-vs-not.

---

### `_fetchStickyAnswerKey(forumCategoryId, testName)`

Looks for a stickied answer-key topic in a forum category and returns a parsed answer map.

**Input:**

| Param | Type | Description |
|---|---|---|
| `forumCategoryId` | number | The parent forum's category ID (from `_currentForumCategoryId`) |
| `testName` | string | The test's category name, used to disambiguate multiple answer-key stickies |

**Output:** `Record<string, string>` mapping 1-based problem number to answer string, or `null` if no answer key found.

**Behavior:**
1. Fetches first page of forum topics via `fetch_topics`.
2. Filters for `announce_type === "local"` topics whose `topic_title` contains `"answer key"`.
3. If multiple candidates, scores each by keyword overlap with `testName` (stripping "answer"/"key") and picks the highest scorer; returns `null` if all score 0.
4. Fetches the winning topic and calls `CleanupText.parseAnswerKey(post_canonical, testName)` on each post, merging results (first hit per problem number wins).

---

### `_applyForumAnswerKey(test, answerMap, type)`

Applies a parsed answer map (from `_extractInCategoryAnswerKey` or `_fetchStickyAnswerKey`) to a test's problems.

**Input:**

| Param | Type | Description |
|---|---|---|
| `test` | object | Test object with `problems` array (flat or nested) |
| `answerMap` | `Record<string, string>` | Map from 1-based problem number to raw answer |
| `type` | `TYPES` entry | Used to determine MCQ vs. numeric behavior |

Runs **after** the resolve pass, so it overrides the `\boxed{}`-derived answers where appropriate.

**Behavior:**
- **MCQ** (branches per-problem on `problem.choices`, so a mixed test is handled correctly): answer key is authoritative — re-resolves the `answerIndex` via `CleanupText.choiceIndexOfAnswer` (normalized letter/value match) and sets `answerValue` to the option letter, overriding any `\boxed{}` result.
- **Numeric** (AIME, COMP, etc.): only fills in the answer when `answerValue` is currently `null` (never overrides a `\boxed{}` answer); when it does, it sets `answerValue` via `_setNumericAnswer`.
- Problems with no entry in `answerMap` are untouched.
- Works on both flat and section-nested `problems` arrays (via `allProblems`), and looks each problem up by its own number (`problem.n + 1`), not by arrival order: a slot that reserved a number without producing a problem (a redacted item) must not shift every later answer, and each section restarts at 1.

---

### `_setNumericAnswer(problem, rawAnswer)`

Writes a numeric (non-MCQ computational) answer onto a problem: sets `answerValue = rawAnswer ?? null`, leaving `choices = null` and `answerIndex = -1`. Used by `_resolveProblemAnswer` and `_applyForumAnswerKey` so every numeric path produces an identical representation.

---

## Error Handling Summary

| Situation | Behavior |
|---|---|
| `error_code` in response | `_fetchCategory` throws; `searchTopicForAnswer` handles `E_NO_PERMISSION` gracefully |
| Cloudflare challenge page | `sendRequest` retries up to 3× with 5s/10s/15s delays; throws after all retries |
| JSON parse failure | `sendRequest` retries up to 3× with exponential backoff (1s, 2s, 4s); throws after all retries |
| `no_more_items` not set | `_fetchCategory` paginates until the flag is true |
| `E_NO_PERMISSION` | `_permissionDenied` flag short-circuits answer lookups for the remainder of the current test |
