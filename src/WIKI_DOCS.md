# AoPS MediaWiki API Reference

This document describes the portions of the Art of Problem Solving (AoPS) MediaWiki API that are useful for scraping problem pages, solutions, and wiki content.

**Base URL**

```text
https://artofproblemsolving.com/wiki/api.php
```

The AoPS wiki runs on MediaWiki, so it supports the standard MediaWiki Action API.

---

# Common Endpoints

## 1. Parse a Page

Returns information about a single wiki page.

### Request

```http
GET /wiki/api.php?action=parse&page=PAGE_NAME&format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=parse&page=2021_AMC_10A_Problems/Problem_23&format=json
```

Returns rendered HTML by default.

Useful response field:

```json
{
    "parse": {
        "text": {
            "*": "<div>...</div>"
        }
    }
}
```

Read the HTML with:

```js
const html = json.parse.text["*"];
```

---

## 2. Get Raw Wiki Source

Instead of rendered HTML, request the original MediaWiki markup.

### Request

```http
GET /wiki/api.php?action=parse&page=PAGE_NAME&prop=wikitext&format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=parse&page=2016_AMC_10B_Problems/Problem_18&prop=wikitext&format=json
```

Response:

```json
{
    "parse": {
        "wikitext": {
            "*": "==Solution 1==\n..."
        }
    }
}
```

Access with:

```js
const source = json.parse.wikitext["*"];
```

---

## 3. Retrieve Only One Section

Instead of downloading an entire page, request a single section.

### Request

```http
GET /wiki/api.php
    ?action=parse
    &page=PAGE_NAME
    &section=SECTION_NUMBER
    &prop=wikitext
    &format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=parse&format=json&page=2016_AMC_10B_Problems/Problem_18&section=1&prop=wikitext&disabletoc=1
```

Parameters:

| Parameter     | Description                          |
| ------------- | ------------------------------------ |
| action=parse  | Parse a wiki page                    |
| page          | Page title                           |
| section       | Section number                       |
| prop=wikitext | Return raw MediaWiki source          |
| format=json   | JSON response                        |
| disabletoc=1  | Disable table of contents generation |

This is useful when only a single solution or problem statement is needed.

---

# Search Pages

Search the wiki for matching pages.

### Request

```http
GET /wiki/api.php
    ?action=query
    &list=search
    &srsearch=SEARCH_TERM
    &format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=query&list=search&srsearch=AMC%2010A%202021%20Problem%2023&format=json
```

Response:

```json
{
    "query": {
        "search": [
            {
                "title": "2021 AMC 10A Problems/Problem 23"
            }
        ]
    }
}
```

---

# List Pages in a Category

Retrieve all pages within a category.

### Request

```http
GET /wiki/api.php
    ?action=query
    &list=categorymembers
    &cmtitle=Category:Theorems
    &format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=query&list=categorymembers&cmtitle=Category:Theorems&format=json
```

Useful for:

- Contest categories
- Theorem categories
- Geometry
- Number Theory
- Algebra
- Combinatorics

---

# List Every Wiki Page

Enumerate all pages in the wiki.

### Request

```http
GET /wiki/api.php
    ?action=query
    &list=allpages
    &aplimit=max
    &format=json
```

Example:

```text
https://artofproblemsolving.com/wiki/api.php?action=query&list=allpages&aplimit=max&format=json
```

The response includes a continuation token when more pages exist.

Example:

```json
{
    "continue": {
        "apcontinue": "..."
    }
}
```

Use it in the next request:

```text
...?action=query
&list=allpages
&apcontinue=TOKEN
&format=json
```

Continue until no `"continue"` object is returned.

---

# Typical Problem Page

Problem pages generally follow this structure:

```text
Problem Statement

==Solution 1==

...

==Solution 2==

...

==Solution 3==

...

==See Also==
```

You can either:

- download the rendered HTML and parse the headings, or
- request specific sections using `section=`.

---

# JavaScript Example

```js
const page = "2021 AMC 10A Problems/Problem 23";

const url =
    "https://artofproblemsolving.com/wiki/api.php?" +
    "action=parse" +
    "&format=json" +
    "&page=" +
    encodeURIComponent(page);

const response = await fetch(url);
const json = await response.json();

const html = json.parse.text["*"];

console.log(html);
```

---

# JavaScript Example (Raw Wiki)

```js
const page = "2021 AMC 10A Problems/Problem 23";

const url =
    "https://artofproblemsolving.com/wiki/api.php?" +
    "action=parse" +
    "&format=json" +
    "&prop=wikitext" +
    "&page=" +
    encodeURIComponent(page);

const json = await (await fetch(url)).json();

console.log(json.parse.wikitext["*"]);
```

---

# Most Useful API Calls

| Purpose                | API                                 |
| ---------------------- | ----------------------------------- |
| Render a page          | `action=parse`                      |
| Get raw wiki markup    | `action=parse&prop=wikitext`        |
| Get a specific section | `action=parse§ion=N`                |
| Search pages           | `action=query&list=search`          |
| List category members  | `action=query&list=categorymembers` |
| Enumerate all pages    | `action=query&list=allpages`        |

---

# WikiSession (`src/WikiSession.js`)

`WikiSession` is the wiki analog of `ForumSession`. It shares the same constructor
shape — `(loggedIn, userId, sessionId, headers = null, onProblemAdd = null)` — plus
`requestDelay`, an optional `ResponseCache`, and the same Cloudflare/JSON retry
envelope, but issues **GET** requests to `api.php` instead of POSTing to the community
ajax endpoint. The wiki sits behind the **same Cloudflare** as the forum, so it needs
the same session `headers` (cookies + UA) from `.env.js`; a plain GET returns a 403
challenge page.

Problems are built with the shared `makeProblem()` factory (exported from
`ForumSession.js`), so wiki and forum problems are interchangeable downstream.

It also carries the same instrumentation surface as `ForumSession` — `logger`,
`onEvent`, `stats`/`resetStats()`/`averageNetworkMs` (see AOPS_DOCS.md for the
field table and event vocabulary), so one `createScrapeProgress()` display drives
either session. Two event types are wiki-specific: `test` (`{ name, pageTitle,
phase: "start" | "done", count }`) at each contest-year boundary, and `problem`
(`{ name, pageTitle, index, total, page }`), emitted **before** each page fetch so
a slow or throttled request reads as "currently on problem k" rather than as
silence. Both carry `name` (the stored test name) *and* `pageTitle` (what is
actually on the wire); they differ for a `testName` variant, and the progress
display prefers `pageTitle` so a slow request names the page you can go look up.
`request` events additionally carry `missing: true` for a `missingtitle` reply,
and `stats.missing` counts them — a run where most requests are `missing` means a
variant is being swept across years it never ran (check `wiki.years` /
`wiki.variants` in `contest_id.js`), not that the scrape is broken.

Unlike `ForumSession`, every `WikiSession.log()` call is a genuine anomaly
(answer-key disagreement, absent MCQ choices, missing aggregate page), so the CLI
leaves `debug` **on** for wiki runs.

| Method | Purpose |
| ------ | ------- |
| `_get(params)` | Low-level cached GET; `params` doubles as the `ResponseCache` key. Retries on the Cloudflare interstitial / bare 403 (linear backoff) and JSON-parse failures (exponential). |
| `parse(page, { section, wikitext })` | `action=parse`; returns `json.parse.wikitext["*"]` (raw) or `json.parse.text["*"]` (HTML). Throws an `Error` with `.code` (e.g. `missingtitle`) on API errors. |
| `getProblemPage(page, { computational, choices })` | Fetches one `…/Problem k` subpage and returns a `makeProblem`-shaped object: cleaned statement, MCQ `choices`, `answerIndex`/`answerValue` (the best `\boxed{…}` across solutions, via `CleanupText.selectBoxedAnswer`), and `solutions[]` from every `==Solution N==` section. **Redirects:** if `page` is a `#REDIRECT` to another problem page (AoPS marks a shared problem this way, e.g. an AMC 12 problem repeating an AMC 10 one), it follows one hop to the canonical page for the content but keeps this page's own number, and sets `redirectTarget` on the returned problem. `WikiSession._parseRedirect(wikitext)` extracts the normalized target title. |
| `getContest(pageBase, year, { testName })` | Assembles a flat `ScrapedTest` for one variant+year. **Two titles, deliberately separate:** `pageBase` addresses the wiki (`"AHSME"` → `"1950 AHSME Problems/Problem 3"`), while `testName` (defaulting to `pageBase`) is the base the test is *stored* under — `name = "${year} ${testName}"` — and must match the forum category name so it merges by natural key. They diverge only where the wiki publishes a contest under a title the forum does not use; see the AHSME note below. Structured registry variants populate nullable review metadata (AMC 10/12 A/B and AIME I/II; AMC 8 remains unclassified). Discovers N from the aggregate `… Problems` page and cross-checks every problem against the official `… Answer Key` page: the key is authoritative, so it fills in a missing boxed answer silently and **overwrites** a boxed answer that disagrees with it (logging a `⚠️` mismatch warning). Comparison is normalized via `WikiSession._normalizeAnswer` (upcase MCQ letters, collapse integer/whitespace formatting) so equal answers aren't flagged. |

**Parsing pipeline (per page):**

1. `parse(page, { wikitext: true })` → split into a lead + `==H2==` sections via
   `WikiSession._splitSections`.
2. Statement = the `== Problem ==` section (or the lead). `CleanupText.normalizeWikiMath`
   converts `<math>…</math>`/`<cmath>…</cmath>` to `$…$`/`$$…$$` so the forum-oriented
   `extractChoices` / `cleanChoices` / `getBoxed` apply unchanged.
3. MCQ (`choices` true): `extractChoices` pulls current `\textbf{(A)}…` options,
   historical `\text{(A)}`, `\mathrm{(A)}`, `\textrm{(A)}`, `(\mathrm{A})`, and
   malformed `\textbf{A}` variants; `cleanChoices` removes them from the statement.
   `extractVisualChoiceLabels` instead represents composite image/Asymptote-only
   options as `A`–`E` while retaining that visual in the problem statement. The answer is picked by
   `CleanupText.selectBoxedAnswer`
   across **all** solution sections (not just the first box), which for MCQ keeps only a box
   that is a valid choice and prefers a sole/last box over an intermediate one, then mapped to
   an option via `choiceIndexOfAnswer`. Numeric (AIME): the selected boxed value is taken
   literally (any string). An expected MCQ page with fewer than three extractable choices logs
   a warning and keeps its source statement intact.
4. `CleanupText.cleanWikiProblem` strips `{{templates}}`, `[[Category:…]]`, wikilinks,
   stray headers, and converts `<asy>` diagrams via `toWikiAsyLinks`.

Contest → wiki page-title mapping lives in `contest_id.js` as a `wiki: { variants, years }`
descriptor on the relevant entries (AMC 8/10/12, AIME). A variant is either a bare
page-title base (`"AMC 12A"`) or an object overriding one axis of it: `years` (the
variant ran for only part of the contest's range) and/or `testName` (the wiki
publishes it under a title the forum does not use). Ingest is via
`db.upsertWikiResults` (additive; natural-key merge; trust order **pdf > wiki > forum**).
The database's structural series policy independently declares every AMC test as
`tests.response_kind='mcq'`; it does not depend on successfully extracting all five options.
Variant metadata comes from the configured `testName`, not from a later parser
over the completed display name.

**AHSME is the case `testName` exists for.** The AMC 12 was the AHSME until 2000, and
the wiki still publishes those years under the old name, but the forum — and so the DB —
stores them as `"1950 AMC 12"`. So the entry is
`{ name: "AHSME", years: [1950, 1999], testName: "AMC 12" }`. Conflating the two titles
breaks the scrape twice over, and the second failure is the quiet one:

1. The test is stored as `"1950 AHSME"`, which never matches the forum's `"1950 AMC 12"`
   row under the `(series, name, year)` natural key — so instead of backfilling answers
   onto the existing test it creates a parallel copy, which then reaches ProblemCloud as
   a separate `manual…`-keyed problem set rather than merging into the existing
   `aops|4814|-1` rows.
2. `ForumSession.inferType("1950 AHSME")` returns `null` → `TYPES.UNKNOWN` →
   `computational: false, choices: false`. The whole test is then scraped as an untyped
   contest: no choices extracted (the A–E options stay glued onto the statement), no
   boxed-answer extraction, and answer-key values stored raw — the AHSME keys carry
   HTML-comment numbering markers (`#C<!--1-->`), which only the MCQ branch launders via
   `parseMCQAns`. Typing it as `"1950 AMC 12"` fixes all of that in one move.

Because `testName` drives type inference, it is the *stored* base — not the page base —
that decides how a contest is parsed.

---

# Notes

- Page titles should be URL-encoded (`encodeURIComponent` in JavaScript).
- Contest problem pages typically use titles like:

```
2021 AMC 10A Problems/Problem 23
```

- The API returns JSON by specifying:

```
format=json
```

- Rendered HTML is found at:

```js
json.parse.text["*"];
```

- Raw MediaWiki source is found at:

```js
json.parse.wikitext["*"];
```

- For large crawls (such as downloading every page), follow the `continue` token until it is no longer present.
