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
- `item_type === "post"` or `post_type === "view_posts_text"` → usually a section marker or description post (not a problem). **Exception:** some contests pack the entire test into one such post as a numbered list ("1. … 2. …" with MCQ choices) and expose no per-problem forum topics. `getTest` detects this via `_isPackedProblemPost` and routes the post through the multi-problem path instead of treating it as a section title. Such problems have `topic_id === 0` and therefore no discussion thread to mine for answers (answers stay `-1`/`null`).
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
- `debug: boolean` — logs raw API responses to stdout when true.
- `_permissionDenied: boolean` — set to true when `E_NO_PERMISSION` is returned; causes `searchTopicForAnswer` to short-circuit for the rest of the current `getTest` call.
- `enableStickyAnswerKey: boolean` — when true, `getTest` will attempt to find a stickied answer-key post in the parent forum and apply it. Should only be true for unofficial/user-made contests. Default `false`.
- `_currentForumCategoryId: number | null` — cached forum category ID populated during `searchTopicForSolutions`; consumed and reset by `getTest`.

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

**Output:** A `TYPES` entry object `{ name, computational, choices }`, or `null` if `returnNull` is true and nothing matched.

---

### `sendRequest(bodyInput)`

The single low-level fetch call. Adds auth fields, applies the random delay, posts to `ajax.php`, and returns parsed JSON. Retries up to 3 times on Cloudflare challenge pages (with exponential backoff) and on JSON parse failures.

If `session.cache` is set (a `ResponseCache` instance, see `src/ResponseCache.js`), `sendRequest` first checks the cache: on a hit it returns the cached response immediately, skipping the network call and the request delay entirely. On a miss it performs the fetch as normal and writes the parsed response to the cache before returning. Cache keys are derived deterministically from `bodyInput` (the payload, which excludes user-specific auth fields), so cached responses are user-independent. The cache is opt-in via the "Use response cache?" prompt in the `scrape` command and stored as plain JSON files under `./response_cache`.

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
  type: string,             // e.g. "AMC 10", "AIME", "AMO"
  computational: boolean,
  sections: string[],       // empty array if no sections
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

Numeric answers: computational tests without MCQ choices (AIME, ARML, COMP, COLLEGE, …) keep `choices = null` and `answerIndex = -1`; the known answer lives in `answerValue` (set by `_setNumericAnswer`). MCQ problems have `choices` populated, `answerIndex` pointing at the correct option, and `answerValue` holding the option letter.

Sections: if a test has sections, `problems` is an array of arrays (`problems[sectionIndex][problemIndex]`). If only one section is detected, the section is collapsed and `problems` is flat.

Packed posts: for each item, a `view_posts_text`/description item is normally a section marker, but `_isPackedProblemPost(item, ctx)` first checks whether it actually contains multiple numbered problems (`CleanupText.checkContainsMultiple`). If so, the item is fed to `_handleProblemItem` (multi-problem split) instead of `_handleSectionMarker`. This is the only path that produces problems with `topicId === 0`.

Answer keys: after the problem list is built (and only for computational tests), `getTest` always calls `_extractInCategoryAnswerKey(items, name)` to look for an answer key shipped inside the category itself (a `post_hidden` item whose `item_text` matches `/answers?\s*key/i`). If found, it is parsed with `CleanupText.parseAnswerKey(post_canonical, name)` and applied via `_applyForumAnswerKey`. `parseAnswerKey` handles several layouts — bare letters/short numbers (`4. D`), `$…$` math (`4. $\frac{17}{6}$`), and free-form lists with optional `| author` annotations (`3. 1018081 | james4l`); when a post packs multiple `[hide=label]` keys (e.g. one per subtest), the block whose label best matches `name` is chosen. Only when no in-category key is present does it fall back to the stickied-forum lookup (`_fetchStickyAnswerKey`, gated by `enableStickyAnswerKey`). The in-category key requires no extra request — it comes from the data already fetched by `_fetchCategory`.

---

### `_extractInCategoryAnswerKey(items, name = null)`

Finds and parses an answer key embedded in a test category's own item list.

**Input:**

| Param | Type | Description |
|---|---|---|
| `items` | object[] | The category items array returned by `_fetchCategory(id)` |
| `name` | string \| null | Test name, forwarded to `parseAnswerKey` to disambiguate multi-key posts |

**Output:** `Record<string, string>` mapping 1-based problem number to answer string, or `null` if no answer-key item is found or it parses to nothing.

Selects the first item with `item_type === "post_hidden"` whose `item_text` matches `/answers?\s*key/i`, then runs `CleanupText.parseAnswerKey(post_canonical, name)`. These items are excluded from the problem list by `_isProblemItem`, so they must be parsed separately here. No network request.

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
- If `searchManyProblems` is false: `string | null` — the raw `\boxed{…}` content of the first matching reply, or `null` if none found.
- If `searchManyProblems` is true: `Record<string, string>` — map of problem number string → boxed answer string (e.g., `{ "1": "42", "2": "7" }`).
- Returns `null` (and sets `_permissionDenied = true`) if the API returns `E_NO_PERMISSION`; subsequent calls within the same `getTest` are short-circuited.
- Returns empty results immediately for a falsy `id` (e.g. `0`), since packed-post problems have no backing discussion topic.

**Side effect:** caches `topic.category_id` from the response into `this._currentForumCategoryId` (used by `_fetchStickyAnswerKey`).

`searchTopicForAnswer` is a thin wrapper over `searchTopicForSolutions(id, searchManyProblems, isOly=false)`, which returns `{ answer, answers, solutions, posts }` — `answer` (single boxed string), `answers` (number→string map for packed posts), `solutions` (classified solution posts), and `posts` (all discussion posts, populated only when `isOly` is true). `searchTopicForAnswer` returns just `answer` or `answers`.

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

**Behavior:**
- **MCQ** (`type.choices`): answer key is authoritative — sets `answerValue` and re-resolves the `answerIndex`, overriding any `\boxed{}` result from the discussion thread.
- **Numeric** (AIME, COMP, etc.): only fills in the answer when `answerValue` is currently `null` (never overrides a `\boxed{}` answer); when it does, it sets `answerValue` via `_setNumericAnswer`.
- Problems with no entry in `answerMap` are untouched.
- Works on both flat and section-nested `problems` arrays; uses a running counter (not `problem.n`) for 1-based numbering across sections.

---

### `_setNumericAnswer(problem, rawAnswer)`

Writes a numeric (non-MCQ computational) answer onto a problem: sets `answerValue = rawAnswer ?? null`, leaving `choices = null` and `answerIndex = -1`. Used by `_buildProblem`, `_handleMultiProblem`, and `_applyForumAnswerKey` so every numeric path produces an identical representation.

---

## Error Handling Summary

| Situation | Behavior |
|---|---|
| `error_code` in response | `_fetchCategory` throws; `searchTopicForAnswer` handles `E_NO_PERMISSION` gracefully |
| Cloudflare challenge page | `sendRequest` retries up to 3× with 5s/10s/15s delays; throws after all retries |
| JSON parse failure | `sendRequest` retries up to 3× with exponential backoff (1s, 2s, 4s); throws after all retries |
| `no_more_items` not set | `_fetchCategory` paginates until the flag is true |
| `E_NO_PERMISSION` | `_permissionDenied` flag short-circuits answer lookups for the remainder of the current test |
