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
- `item_type === "post"` or `post_type === "view_posts_text"` → a section marker or description post (not a problem)
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

### `getTest(id, testType = null, done = [])`

Fetches and parses a single test category into a structured test object.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the test |
| `testType` | `TYPES` entry \| null | Fallback type if the name heuristic returns null |
| `done` | number[] | List of `topic_id`s already processed (prevents duplicates in multi-test scrapes) |

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

**Problem shape:**

```js
{
  statement: string,        // cleaned LaTeX/BBCode
  n: number,                // 0-based problem index
  topic_id: number,
  post_id: number,
  choices: string[] | null, // MCQ options or [answer] for computational, null for proof-based
  answer: number | null,    // index into choices, or -1 if unknown, or null for proof-based
  section: number,          // (only present if sectioned test) index into sections[]
}
```

Sections: if a test has sections, `problems` is an array of arrays (`problems[sectionIndex][problemIndex]`). If only one section is detected, the section is collapsed and `problems` is flat.

---

### `getAllTests(id, type = null, shownDepth = 1, done = new Set(), returnDone = false)`

Recursively scrapes a folder hierarchy, returning a tree of test results.

**Input:**

| Param | Type | Description |
|---|---|---|
| `id` | number | AoPS category ID of the top-level folder |
| `type` | `TYPES` entry \| null | Type override propagated to child tests |
| `shownDepth` | number | Controls tree nesting: at depth > 0 sub-folders are wrapped as `{ name, tests[], count }`; at depth ≤ 0 their children are flattened into the parent's `tests[]` |
| `done` | Set\<number\> | Set of category IDs already visited (prevents infinite recursion) |
| `returnDone` | boolean | If true, includes the `done` set in the return value |

**Output:**

```js
{
  id: number,
  name: string,
  tests: (TestResult | FolderResult)[],  // mix of getTest results and nested getAllTests results
  count: number,
  done?: Set<number>,  // only present if returnDone is true
}
```

Items with `item_type === "folder"` are recursed; `item_type === "view_posts"` items are passed to `getTest`. Items in `CONTEST_IDS.IGNORE` or already in `done` are skipped.

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

---

## Error Handling Summary

| Situation | Behavior |
|---|---|
| `error_code` in response | `_fetchCategory` throws; `searchTopicForAnswer` handles `E_NO_PERMISSION` gracefully |
| Cloudflare challenge page | `sendRequest` retries up to 3× with 5s/10s/15s delays; throws after all retries |
| JSON parse failure | `sendRequest` retries up to 3× with exponential backoff (1s, 2s, 4s); throws after all retries |
| `no_more_items` not set | `_fetchCategory` paginates until the flag is true |
| `E_NO_PERMISSION` | `_permissionDenied` flag short-circuits answer lookups for the remainder of the current test |
