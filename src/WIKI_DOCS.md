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

| Method | Purpose |
| ------ | ------- |
| `_get(params)` | Low-level cached GET; `params` doubles as the `ResponseCache` key. Retries on the Cloudflare interstitial / bare 403 (linear backoff) and JSON-parse failures (exponential). |
| `parse(page, { section, wikitext })` | `action=parse`; returns `json.parse.wikitext["*"]` (raw) or `json.parse.text["*"]` (HTML). Throws an `Error` with `.code` (e.g. `missingtitle`) on API errors. |
| `getProblemPage(page, { computational, choices })` | Fetches one `…/Problem k` subpage and returns a `makeProblem`-shaped object: cleaned statement, MCQ `choices`, `answerIndex`/`answerValue` (from the first `\boxed{…}` in a solution), and `solutions[]` from every `==Solution N==` section. **Redirects:** if `page` is a `#REDIRECT` to another problem page (AoPS marks a shared problem this way, e.g. an AMC 12 problem repeating an AMC 10 one), it follows one hop to the canonical page for the content but keeps this page's own number, and sets `redirectTarget` on the returned problem. `WikiSession._parseRedirect(wikitext)` extracts the normalized target title. |
| `getContest(titleBase, year)` | Assembles a flat `ScrapedTest` for one variant+year (`name = "${year} ${titleBase}"`, matching the forum category name so it merges by natural key). Structured registry variants populate nullable review metadata (AMC 10/12 A/B and AIME I/II; AMC 8 remains unclassified). Discovers N from the aggregate `… Problems` page and applies the `… Answer Key` page as a fallback for problems whose solutions lack a boxed answer. |

**Parsing pipeline (per page):**

1. `parse(page, { wikitext: true })` → split into a lead + `==H2==` sections via
   `WikiSession._splitSections`.
2. Statement = the `== Problem ==` section (or the lead). `CleanupText.normalizeWikiMath`
   converts `<math>…</math>`/`<cmath>…</cmath>` to `$…$`/`$$…$$` so the forum-oriented
   `extractChoices` / `cleanChoices` / `getBoxed` apply unchanged.
3. MCQ (`choices` true): `extractChoices` pulls `\textbf{(A)}…` options, `cleanChoices`
   removes them from the statement; the answer is the first `\boxed{…}` across solutions,
   run through `parseMCQAns`. Numeric (AIME): the boxed value is taken literally.
4. `CleanupText.cleanWikiProblem` strips `{{templates}}`, `[[Category:…]]`, wikilinks,
   stray headers, and converts `<asy>` diagrams via `toWikiAsyLinks`.

Contest → wiki page-title mapping lives in `contest_id.js` as a `wiki: { variants, years }`
descriptor on the relevant entries (AMC 8/10/12, AIME). Ingest is via
`db.upsertWikiResults` (additive; natural-key merge; trust order **pdf > wiki > forum**).
Variant metadata comes from that configured `titleBase`, not from a later parser
over the completed display name.

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
