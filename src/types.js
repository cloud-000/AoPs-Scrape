// Shared data-shape definitions for the scrape pipeline. These are JSDoc-only
// (no runtime code) and act as the single contract between ForumSession (which
// produces them) and db.js (which consumes them in upsertScrapeResults).
//
// Use `makeProblem()` in ForumSession.js to construct a ScrapedProblem so every
// problem has identical fields.

/**
 * A single problem as produced by the scraper.
 * @typedef {Object} ScrapedProblem
 * @property {string}            statement    Cleaned LaTeX/BBCode statement (no MCQ choices appended).
 * @property {number}            n            0-based index within the test (or section).
 * @property {number}            section      Section index; -1 if the test has no sections.
 * @property {number|null}       topicId      AoPS topic id of the problem's forum thread.
 * @property {number|null}       postId       AoPS post id of the statement post.
 * @property {string[]|null}     choices      MCQ options; null for numeric/proof problems.
 * @property {number}            answerIndex  Index into `choices` for MCQ; -1 if numeric/unknown.
 * @property {string|null}       answerValue  Literal answer: letter ("A"–"E") for MCQ, number for
 *                                            numeric (AIME/COMP), null if unknown.
 * @property {ScrapedSolution[]} solutions    Classified solution posts.
 * @property {ForumPost[]}       posts         All discussion posts (kept for OLY solution curation).
 */

/**
 * A solution post attached to a problem.
 * @typedef {Object} ScrapedSolution
 * @property {number} post_id
 * @property {number} topic_id
 * @property {number|null} user_id
 * @property {string|null} username
 * @property {string} content
 * @property {string|null} posted_at  ISO timestamp.
 */

/**
 * A raw forum post (subset of AoPS post_data) collected for later curation.
 * @typedef {Object} ForumPost
 * @property {number} post_id
 * @property {number|null} user_id
 * @property {string|null} username
 * @property {string} content
 * @property {string|null} posted_at  ISO timestamp.
 */

/**
 * A test (one contest/exam) produced by ForumSession.getTest().
 * @typedef {Object} ScrapedTest
 * @property {number|string} id            AoPS category id.
 * @property {string}  name
 * @property {number|null} year
 * @property {string|null} [division]          Structured audience/level label when known.
 * @property {number|null} [divisionOrder]     Stable sibling division display order.
 * @property {string|null} [format]            Structured test variant label when known.
 * @property {number|null} [formatOrder]       Stable sibling format display order.
 * @property {string}  type                Type name (e.g. "AMC 10", "AIME").
 * @property {boolean} computational       Has numeric/MCQ answers (vs. proof-based).
 * @property {string[]} sections           Section names; empty for flat tests. A
 *                                         leading "" is the unnamed lead section:
 *                                         the problems listed before the first header.
 * @property {ScrapedProblem[]|ScrapedProblem[][]} problems  Flat, or 2D when sectioned.
 * @property {number}  count               Total problem count.
 */

export {};
