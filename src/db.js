import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CleanupText } from "./CleanupText.js";
import { getAutoTags } from "./autoTags.js";
import { sectionTestMetadata } from "./testMetadata.js";
import { resolveTopic } from "./topicPolicy.js";
import {
    ANSWER_STATUS_CLAIMS,
    RESPONSE_KINDS,
    RESOLVED_ANSWER_STATUSES,
    SERIES_RESPONSE_KIND_DECLARATIONS,
    responseKindForSeries,
    resolveCoverage,
} from "./coverage.js";
import { SOLUTIONS_USERS } from "../contest_id.js";

function sqlStringList(values) {
    return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

const RESPONSE_KIND_SQL = sqlStringList(RESPONSE_KINDS);
const ANSWER_STATUS_CLAIM_SQL = sqlStringList(ANSWER_STATUS_CLAIMS);
const RESOLVED_ANSWER_STATUS_SQL = sqlStringList(RESOLVED_ANSWER_STATUSES);

// ---------------------------------------------------------------------------
// MERGE CONTRACT (how a re-scrape combines with existing rows)
//
//   aops_*          Always overwritten by the latest scrape (raw AoPS facts).
//   pdf_*           Manual overrides. Never touched by the scraper.
//   statement,      Resolved/merged values production reads. Prefer the manual
//   answer_index,   pdf_* / verified value, otherwise fall back to the freshest
//   answer_value    aops_* value.
//   acgn            Inferred Algebra/Combinatorics/Geometry/NumberTheory class.
//                   Set once on insert; never overwritten by the scraper
//                   (re-run explicitly via `preprocess`).
//   tags            Accumulated (UNION'd) across scrapes, never lost.
//   verified,       Manual curation. Never touched by the scraper.
//   difficulty,
//   quality, notes
//
//   Orphan cleanup: re-scraping a test removes its non-curated problem rows
//   whose (n, section) no longer appears in the scrape (e.g. when a test's
//   section structure changes). Rows with pdf_statement or verified are kept.
//
//   problem_links   Duplicate-problem links (alias -> canonical). Additive:
//                   'auto' rows are refreshed by importers, but rows with
//                   status_source='manual' (a human's accept/reject/override)
//                   are never touched. Links are never orphan-deleted.
//
//   Sectioned tests: a scraped category with N sections ("Day 1"/"Day 2", …)
//   is materialized as N separate test rows, one per section, each named
//   "<test name> <section name>" with tests.section = the section index and
//   tests.section_name = the raw section title. Sibling section tests share the
//   AoPS category id and are keyed by (aops_category_id, section). Each
//   section's problems live under its own test with problems.section = -1.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  aops_id     INTEGER DEFAULT -1,
  is_official BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_official IN (0, 1))
);

CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id        INTEGER REFERENCES series(id),
  name             TEXT NOT NULL,
  -- A sectioned AoPS category ("Day 1"/"Day 2", …) is split into one test row
  -- per section. section is the 0-based section index (-1 for a flat test);
  -- section_name is the raw AoPS section title (NULL for a flat test). name
  -- already includes the section title (e.g. "2024 USAMO Day 1").
  section          INTEGER NOT NULL DEFAULT -1,
  section_name     TEXT,
  year             INTEGER,
  division         TEXT,
  division_order   INTEGER,
  format           TEXT,
  format_order     INTEGER,
  -- Not standalone-unique: sibling section tests share the AoPS category id and
  -- are disambiguated by section.
  aops_category_id TEXT,
  type             TEXT,
  is_computational BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
  -- Test-level DECLARATION, from comp-OCR's test_profile.json or a structural
  -- series registry (e.g. every AMC is MCQ). NULL means no source/registry has
  -- declared it, not "computational". is_computational above stays the raw config
  -- value -- the coverage-aware value is derived by isComputationalFor() at read
  -- time (buildProductionProblems / exportStagingSQL), so no importer can
  -- regress it. See src/coverage.js.
  response_kind    TEXT CHECK (response_kind IN (${RESPONSE_KIND_SQL})),
  answer_status    TEXT CHECK (answer_status IN (${ANSWER_STATUS_CLAIM_SQL})),
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  aops_url TEXT GENERATED ALWAYS AS ('https://artofproblemsolving.com/community/c' || aops_category_id) STORED,
  UNIQUE(aops_category_id, section)
);

CREATE TABLE IF NOT EXISTS problems (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id       INTEGER NOT NULL REFERENCES tests(id),
  n             INTEGER NOT NULL,
  -- -1 means no section; avoids NULL uniqueness gotcha in SQLite
  section       INTEGER NOT NULL DEFAULT -1,

  aops_topic_id INTEGER,
  aops_post_id  INTEGER,
  aops_statement   TEXT,
  aops_answer_index INTEGER,
  aops_choices     TEXT,   -- JSON array of MCQ choice texts; NULL if not MCQ
  aops_answer      TEXT,   -- raw answer string (letter "A"-"E" for MCQ, or numeric string for AIME/COMP); NULL if unknown

  -- Wiki source tier (trust: pdf > wiki > aops). Structurally mirrors aops_*.
  wiki_page         TEXT,   -- source wiki page title (e.g. "2021 AMC 10A Problems/Problem 1")
  wiki_statement    TEXT,
  wiki_choices      TEXT,   -- JSON array of MCQ choice texts; NULL if not MCQ
  wiki_answer_index INTEGER,
  wiki_answer       TEXT,   -- literal answer: letter "A"-"E" for MCQ, or numeric string; NULL if unknown

  pdf_statement TEXT,
  pdf_answer    TEXT,
  pdf_source    TEXT,

  -- Resolved/merged values (prefer manual pdf_*/verified, else freshest aops_*)
  statement    TEXT,
  answer_index INTEGER DEFAULT -1,  -- index into aops_choices for MCQ; -1 if numeric/unknown
  answer_value TEXT,                -- literal answer: letter for MCQ, number for numeric; NULL if unknown

  acgn             TEXT,   -- inferred Algebra/Combinatorics/Geometry/NumberTheory class
  tags             TEXT,
  is_computational BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
  -- Sparse per-problem coverage OVERRIDE, from problem_coverage.json. These
  -- never inherit the parent test's declaration -- a value here means a source
  -- named this problem specifically, which is what distinguishes a verified
  -- exception from an inherited default. The resolved value consumers filter on
  -- is COALESCE(override, test declaration, derived) and is computed in
  -- buildProductionProblems. 'known' is deliberately not storable: it is the
  -- absence of a claim, so it is derived rather than written. See coverage.js.
  coverage_response_kind TEXT CHECK (coverage_response_kind IN (${RESPONSE_KIND_SQL})),
  coverage_answer_status TEXT CHECK (coverage_answer_status IN (${ANSWER_STATUS_CLAIM_SQL})),
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  verified         BOOLEAN NOT NULL DEFAULT FALSE CHECK (verified IN (0, 1)),
  notes            TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  aops_topic_url TEXT GENERATED ALWAYS AS ('https://artofproblemsolving.com/community/p' || aops_topic_id) STORED,

  UNIQUE(test_id, n, section)
);
CREATE INDEX IF NOT EXISTS idx_problems_aops_topic ON problems(aops_topic_id);

CREATE TABLE IF NOT EXISTS solutions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id               INTEGER NOT NULL REFERENCES problems(id),
  content                  TEXT NOT NULL,
  content_format           TEXT NOT NULL DEFAULT 'latex_bbcode',
  normalized_hash          TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'candidate'
                             CHECK (status IN ('candidate', 'accepted', 'needs_review', 'rejected', 'duplicate', 'superseded')),
  status_source            TEXT NOT NULL DEFAULT 'auto'
                             CHECK (status_source IN ('auto', 'manual')),
  solution_type            TEXT NOT NULL DEFAULT 'unknown'
                             CHECK (solution_type IN ('full', 'sketch', 'answer_only', 'discussion', 'unknown')),
  quality_score            INTEGER NOT NULL DEFAULT 0 CHECK (quality_score BETWEEN 0 AND 100),
  quality_flags            TEXT,
  classifier_version       TEXT,
  classifier_reasons       TEXT,
  is_official              BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_official IN (0, 1)),
  duplicate_of_solution_id INTEGER REFERENCES solutions(id),
  selected_rank            INTEGER,
  reviewed_by              TEXT,
  reviewed_at              TEXT,
  review_notes             TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now')),
  UNIQUE(problem_id, normalized_hash)
);
CREATE INDEX IF NOT EXISTS idx_solutions_problem_status
  ON solutions (problem_id, status, duplicate_of_solution_id);
CREATE INDEX IF NOT EXISTS idx_solutions_duplicate_of
  ON solutions (duplicate_of_solution_id);

CREATE TABLE IF NOT EXISTS solution_sources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  solution_id         INTEGER NOT NULL REFERENCES solutions(id),
  problem_id          INTEGER NOT NULL REFERENCES problems(id),
  source              TEXT NOT NULL CHECK (source IN ('aops', 'wiki', 'manual', 'import')),
  source_key          TEXT NOT NULL,
  source_url          TEXT,
  raw_content         TEXT,
  source_content_hash TEXT,
  aops_topic_id       INTEGER,
  aops_post_id        INTEGER,
  aops_user_id        INTEGER,
  aops_username       TEXT,
  wiki_page           TEXT,
  wiki_section        TEXT,
  posted_at           TEXT,
  first_seen_at       TEXT DEFAULT (datetime('now')),
  last_seen_at        TEXT DEFAULT (datetime('now')),
  is_official_hint    BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_official_hint IN (0, 1)),
  reliability_hint    INTEGER NOT NULL DEFAULT 0 CHECK (reliability_hint BETWEEN 0 AND 100),
  UNIQUE(problem_id, source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_solution_sources_solution
  ON solution_sources (solution_id);
CREATE INDEX IF NOT EXISTS idx_solution_sources_aops_post
  ON solution_sources (aops_post_id) WHERE aops_post_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oly_potential_solutions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id  INTEGER NOT NULL REFERENCES problems(id) UNIQUE,
  posts       TEXT NOT NULL,
  scraped_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problem_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id    INTEGER NOT NULL REFERENCES problems(id),
  old_statement TEXT,
  new_statement TEXT,
  changed_at    TEXT DEFAULT (datetime('now'))
);

-- Duplicate-problem links: the same real-world problem appearing under two tests
-- (e.g. AMC 10A #18 == AMC 12A #12, Mandelbrot N/R versions, PUMAC A/B rounds).
-- Each ALIAS problem gets one row pointing at its CANONICAL representative; a
-- canonical/standalone problem has no row here. Mirrors the solutions dedup idiom
-- (self-reference + provenance + review status). Only 'accepted' links merge into
-- production / the cloud; 'needs_review' waits for a human. Manual review state
-- (status_source='manual') is preserved across re-imports; 'auto' rows refresh.
CREATE TABLE IF NOT EXISTS problem_links (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id           INTEGER NOT NULL UNIQUE REFERENCES problems(id),  -- the alias member
  canonical_problem_id INTEGER NOT NULL REFERENCES problems(id),         -- its representative
  source        TEXT NOT NULL CHECK (source IN ('pdf_duplicates', 'wiki_redirect', 'manual')),
  similarity    REAL,
  scope         TEXT,                                                    -- e.g. year "2021"
  status        TEXT NOT NULL DEFAULT 'candidate'
                  CHECK (status IN ('candidate', 'accepted', 'needs_review', 'rejected')),
  status_source TEXT NOT NULL DEFAULT 'auto'
                  CHECK (status_source IN ('auto', 'manual')),
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  CHECK (problem_id <> canonical_problem_id)
);
CREATE INDEX IF NOT EXISTS idx_problem_links_canonical
  ON problem_links (canonical_problem_id);

-- Captured AoPS-wiki redirects (a variant problem page that #REDIRECTs to the
-- canonical problem page, e.g. "2021 AMC 12A Problems/Problem 12" ->
-- "2021 AMC 10A Problems/Problem 18"). Capture is decoupled from resolution: the
-- redirecting problem is recorded here with the raw target page title, and
-- resolveWikiRedirectLinks() later turns it into an accepted problem_links row by
-- matching problems.wiki_page = target_page. This lets a redirect resolve even
-- when its target contest is imported in a separate run (re-run resolution in
-- preprocess, no network needed).
CREATE TABLE IF NOT EXISTS wiki_redirects (
  problem_id  INTEGER NOT NULL UNIQUE REFERENCES problems(id),  -- the redirecting (alias) problem
  target_page TEXT NOT NULL,                                    -- canonical wiki page title
  scope       TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Clean, standalone export table. Purely derived from problems + solutions via
-- buildProductionProblems(); rebuilt on demand, holds no manual state of its own.
-- No aops_*/pdf_* source columns. Array-typed columns (Postgres text[]) are
-- stored here as TEXT[] arrays (custom type).
CREATE TABLE IF NOT EXISTS production_problems (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- relational link back to the source test
  test_id            INTEGER REFERENCES tests(id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,        -- problem number within the test

  -- Duplicate pointer: when this row is an ALIAS of another problem (same
  -- real-world problem under a different test), these hold the canonical's
  -- (test_id, n); NULL when this row is its own canonical. Export turns them into
  -- the cloud's canonical_sync_key so rating/progress are shared. Content columns
  -- below are already the canonical's (propagated in buildProductionProblems).
  canonical_test_id  INTEGER REFERENCES tests(id) ON DELETE CASCADE,
  canonical_n        INTEGER,
  aops_id            INTEGER,

  -- content
  statement          TEXT,
  choices            TEXT[],   -- MCQ options, or [answer] for known non-MCQ; empty if unknown
  answer_index       INTEGER DEFAULT -1,  -- 0-based index into choices; -1 = unknown
  official_solutions TEXT,    -- JSON array of accepted canonical solution content strings; NULL if none

  -- metadata (carried over from problems)
  topic              TEXT,   -- Algebra/Combinatorics/Geometry/NumberTheory class
  tags               TEXT[],   -- TEXT[] array (custom type)
  is_computational   BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
  -- RESOLVED coverage semantics: COALESCE(problem override, test declaration,
  -- 'known' when an answer exists). Derived here and nowhere else, so a rebuild
  -- always reflects the current declarations. 'known' is valid here (unlike in
  -- the source columns) because at this point it is a computed fact.
  response_kind      TEXT CHECK (response_kind IN (${RESPONSE_KIND_SQL})),
  answer_status      TEXT CHECK (answer_status IN (${RESOLVED_ANSWER_STATUS_SQL})),
  difficulty         INTEGER DEFAULT 0,
  quality            INTEGER DEFAULT 0,
  verified           BOOLEAN NOT NULL DEFAULT FALSE CHECK (verified IN (0, 1)),
  notes              TEXT,

  built_at           TEXT DEFAULT (datetime('now')),

  UNIQUE(test_id, n),
  CHECK (answer_status IS NULL OR answer_status <> 'not_applicable'
         OR COALESCE(answer_index, -1) = -1),
  CHECK (answer_status IS NULL OR answer_status <> 'known'
         OR COALESCE(answer_index, -1) >= 0)
);
`;

const SOLUTION_CLASSIFIER_VERSION = "solution-classifier-v1";
const KNOWN_SOLUTION_USER_IDS = new Set((SOLUTIONS_USERS ?? []).map((u) => u.id));

function hashText(text) {
    return createHash("sha256").update(text ?? "").digest("hex");
}

function normalizeSolutionContent(content) {
    return String(content ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\[hide(?:=[^\]]*)?\]/gi, "")
        .replace(/\[\/hide\]/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getSourceKey(input, contentHash) {
    if (input.sourceKey != null) return String(input.sourceKey);
    if (input.aops_post_id != null) return `post:${input.aops_post_id}`;
    if (input.wiki_page) {
        return `page:${input.wiki_page}#${input.wiki_section ?? ""}`;
    }
    return `${input.source ?? "manual"}:${contentHash}`;
}

function jsonOrNull(value) {
    return value == null ? null : JSON.stringify(value);
}

function solutionSourcePriority(source) {
    if (source === "manual") return 5;
    if (source === "wiki") return 4;
    if (source === "aops") return 3;
    return 1;
}

// Kept pure over already-loaded `solution_sources` rows: the classifier
// summarizes every solution (most of them twice), so it loads the table in one
// sweep rather than issuing a query per solution.
function summarizeSolutionSources(rows) {
    return {
        rows,
        hasWiki: rows.some((r) => r.source === "wiki"),
        hasManual: rows.some((r) => r.source === "manual"),
        hasOfficialHint: rows.some((r) => r.is_official_hint),
        hasKnownSolutionUser: rows.some((r) =>
            KNOWN_SOLUTION_USER_IDS.has(r.aops_user_id),
        ),
        maxReliability: rows.reduce(
            (max, r) => Math.max(max, r.reliability_hint ?? 0),
            0,
        ),
        bestSourcePriority: rows.reduce(
            (max, r) => Math.max(max, solutionSourcePriority(r.source)),
            0,
        ),
        earliestPostedAt:
            rows
                .map((r) => r.posted_at)
                .filter(Boolean)
                .sort()[0] ?? null,
    };
}

function scoreSolutionContent(content, sourceSummary) {
    const normalized = normalizeSolutionContent(content);
    const flags = [];
    const reasons = [];
    let score = 20;
    let solutionType = "unknown";

    if (!normalized) {
        flags.push("empty");
        reasons.push("empty content");
        return { score: 0, flags, reasons, solutionType: "unknown" };
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const hasMath = /\\(?:frac|sqrt|sum|prod|angle|triangle|boxed|begin|end)|[=<>]/.test(content);
    const hasProofMarker = /\b(proof|solution|therefore|hence|thus|since|suppose|claim|case)\b/i.test(content);
    const hasAnswerOnly =
        /^\\?boxed\s*\{[^}]+\}\.?$/i.test(normalized) ||
        (wordCount <= 8 && /\\boxed\s*\{/.test(content));

    if (sourceSummary.hasWiki || sourceSummary.hasOfficialHint) {
        score += 35;
        reasons.push("official or wiki source");
    }
    if (sourceSummary.hasKnownSolutionUser) {
        score += 20;
        reasons.push("known solution author");
    }
    if (sourceSummary.hasManual) {
        score += 15;
        reasons.push("manual source");
    }
    if (sourceSummary.maxReliability) {
        score += Math.min(15, Math.round(sourceSummary.maxReliability / 10));
    }
    if (wordCount >= 40) score += 20;
    else if (wordCount >= 18) score += 10;
    else flags.push("short");
    if (hasProofMarker) score += 10;
    if (hasMath) score += 5;

    if (hasAnswerOnly) {
        solutionType = "answer_only";
        score = Math.min(score, 35);
        flags.push("answer_only");
        reasons.push("looks like answer only");
    } else if (wordCount >= 40 && hasProofMarker) {
        solutionType = "full";
    } else if (wordCount >= 18) {
        solutionType = "sketch";
    } else if (/thanks|bump|typo|where did|can someone/i.test(content)) {
        solutionType = "discussion";
        score = Math.min(score, 30);
        flags.push("discussion");
    }

    return {
        score: Math.max(0, Math.min(100, score)),
        flags,
        reasons,
        solutionType,
    };
}

function tokenSet(content) {
    return new Set(
        normalizeSolutionContent(content)
            .split(/[^a-z0-9\\]+/i)
            .filter((token) => token.length >= 3),
    );
}

function tokenSetSimilarity(left, right) {
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const token of left) {
        if (right.has(token)) intersection++;
    }
    return intersection / Math.max(left.size, right.size);
}

function compareCanonicalSolutions(a, b) {
    const manualAcceptedA = a.status_source === "manual" && a.status === "accepted";
    const manualAcceptedB = b.status_source === "manual" && b.status === "accepted";
    if (manualAcceptedA !== manualAcceptedB) return manualAcceptedA ? -1 : 1;
    if (a.is_official !== b.is_official) return a.is_official ? -1 : 1;
    if (a.best_source_priority !== b.best_source_priority) {
        return b.best_source_priority - a.best_source_priority;
    }
    if (a.has_known_solution_user !== b.has_known_solution_user) {
        return a.has_known_solution_user ? -1 : 1;
    }
    if (a.quality_score !== b.quality_score) return b.quality_score - a.quality_score;
    if ((a.earliest_posted_at ?? "") !== (b.earliest_posted_at ?? "")) {
        if (!a.earliest_posted_at) return 1;
        if (!b.earliest_posted_at) return -1;
        return a.earliest_posted_at.localeCompare(b.earliest_posted_at);
    }
    return a.id - b.id;
}

function markOrphanedAutoSolutionSuperseded(db, solutionId) {
    if (!solutionId) return;
    const row = db
        .query(
            `SELECT s.id, s.status_source, COUNT(ss.id) AS source_count
             FROM solutions s
             LEFT JOIN solution_sources ss ON ss.solution_id = s.id
             WHERE s.id = ?
             GROUP BY s.id`,
        )
        .get(solutionId);
    if (row && row.status_source !== "manual" && row.source_count === 0) {
        db.run(
            `UPDATE solutions
             SET status = 'superseded', duplicate_of_solution_id = NULL, updated_at = datetime('now')
             WHERE id = ?`,
            [solutionId],
        );
    }
}

export function upsertSolutionCandidate(db, input) {
    if (!input?.problemId || !input.content) return null;

    const source = input.source ?? "manual";
    const content = String(input.content).trim();
    if (!content) return null;

    const normalizedHash = hashText(normalizeSolutionContent(content));
    const rawHash = hashText(content);
    const sourceKey = getSourceKey(input, rawHash);
    const isOfficialHint = input.is_official ?? input.isOfficial ?? source === "wiki";
    const reliabilityHint =
        input.reliability_hint ??
        (source === "wiki" || isOfficialHint ? 90 : source === "manual" ? 80 : 0);

    let solution = db
        .query(
            `SELECT * FROM solutions WHERE problem_id = ? AND normalized_hash = ?`,
        )
        .get(input.problemId, normalizedHash);

    if (!solution) {
        const status = input.status ?? (isOfficialHint ? "accepted" : "candidate");
        const statusSource = input.status_source ?? "auto";
        db.run(
            `INSERT INTO solutions (
                problem_id, content, content_format, normalized_hash,
                status, status_source, is_official, quality_score,
                quality_flags, classifier_version, classifier_reasons,
                solution_type, selected_rank, reviewed_by, reviewed_at, review_notes
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.problemId,
                content,
                input.content_format ?? "latex_bbcode",
                normalizedHash,
                status,
                statusSource,
                isOfficialHint ? 1 : 0,
                input.quality_score ?? 0,
                jsonOrNull(input.quality_flags),
                input.classifier_version ?? null,
                jsonOrNull(input.classifier_reasons),
                input.solution_type ?? "unknown",
                input.selected_rank ?? null,
                input.reviewed_by ?? null,
                input.reviewed_at ?? null,
                input.review_notes ?? null,
            ],
        );
        solution = db
            .query(`SELECT * FROM solutions WHERE rowid = last_insert_rowid()`)
            .get();
    } else {
        db.run(
            `UPDATE solutions SET
                content = CASE WHEN status_source = 'manual' THEN content ELSE ? END,
                status = CASE
                    WHEN status_source = 'manual' THEN status
                    WHEN status = 'superseded' THEN ?
                    ELSE status
                END,
                is_official = MAX(is_official, ?),
                quality_score = CASE
                    WHEN status_source = 'manual' THEN quality_score
                    ELSE MAX(quality_score, ?)
                END,
                updated_at = datetime('now')
             WHERE id = ?`,
            [
                content,
                isOfficialHint ? "accepted" : "candidate",
                isOfficialHint ? 1 : 0,
                input.quality_score ?? 0,
                solution.id,
            ],
        );
    }

    const existingSource = db
        .query(
            `SELECT solution_id FROM solution_sources
             WHERE problem_id = ? AND source = ? AND source_key = ?`,
        )
        .get(input.problemId, source, sourceKey);

    db.run(
        `INSERT INTO solution_sources (
            solution_id, problem_id, source, source_key, source_url,
            raw_content, source_content_hash,
            aops_topic_id, aops_post_id, aops_user_id, aops_username,
            wiki_page, wiki_section, posted_at,
            is_official_hint, reliability_hint
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(problem_id, source, source_key) DO UPDATE SET
            solution_id = excluded.solution_id,
            source_url = excluded.source_url,
            raw_content = excluded.raw_content,
            source_content_hash = excluded.source_content_hash,
            aops_topic_id = excluded.aops_topic_id,
            aops_post_id = excluded.aops_post_id,
            aops_user_id = excluded.aops_user_id,
            aops_username = excluded.aops_username,
            wiki_page = excluded.wiki_page,
            wiki_section = excluded.wiki_section,
            posted_at = excluded.posted_at,
            last_seen_at = datetime('now'),
            is_official_hint = MAX(solution_sources.is_official_hint, excluded.is_official_hint),
            reliability_hint = MAX(solution_sources.reliability_hint, excluded.reliability_hint)`,
        [
            solution.id,
            input.problemId,
            source,
            sourceKey,
            input.source_url ?? null,
            input.raw_content ?? content,
            rawHash,
            input.aops_topic_id ?? null,
            input.aops_post_id ?? null,
            input.aops_user_id ?? null,
            input.aops_username ?? null,
            input.wiki_page ?? null,
            input.wiki_section ?? null,
            input.posted_at ?? null,
            isOfficialHint ? 1 : 0,
            reliabilityHint,
        ],
    );

    if (existingSource?.solution_id && existingSource.solution_id !== solution.id) {
        markOrphanedAutoSolutionSuperseded(db, existingSource.solution_id);
    }

    return solution.id;
}

export function classifySolutions(
    db,
    { version = SOLUTION_CLASSIFIER_VERSION, nearDuplicateThreshold = 0.92 } = {},
) {
    let updated = 0;
    let duplicates = 0;

    db.transaction(() => {
        const rows = db
            .query(
                `SELECT *
                 FROM solutions
                 WHERE status_source != 'manual'
                   AND status != 'superseded'
                 ORDER BY problem_id, id`,
            )
            .all();

        // Every solution here gets summarized (most of them twice — once to
        // score, once to rank a duplicate group), so load solution_sources in
        // one sweep and memoize. Per-row queries cost ~2x 50k round trips.
        const sourceRowsBySolution = new Map();
        for (const source of db
            .query(
                `SELECT solution_id, source, is_official_hint, reliability_hint,
                        aops_user_id, posted_at
                 FROM solution_sources`,
            )
            .all()) {
            const list = sourceRowsBySolution.get(source.solution_id);
            if (list) list.push(source);
            else sourceRowsBySolution.set(source.solution_id, [source]);
        }
        const summaries = new Map();
        const summaryFor = (solutionId) => {
            let summary = summaries.get(solutionId);
            if (!summary) {
                summary = summarizeSolutionSources(
                    sourceRowsBySolution.get(solutionId) ?? [],
                );
                summaries.set(solutionId, summary);
            }
            return summary;
        };

        const updateStmt = db.prepare(
            `UPDATE solutions SET
                status = ?,
                solution_type = ?,
                quality_score = ?,
                quality_flags = ?,
                classifier_version = ?,
                classifier_reasons = ?,
                is_official = MAX(is_official, ?),
                duplicate_of_solution_id = NULL,
                updated_at = datetime('now')
             WHERE id = ? AND status_source != 'manual'`,
        );

        for (const row of rows) {
            const summary = summaryFor(row.id);
            const scored = scoreSolutionContent(row.content, summary);
            const isOfficial = row.is_official || summary.hasWiki || summary.hasOfficialHint;
            let status;
            if (isOfficial || scored.score >= 70) {
                status = "accepted";
            } else if (
                scored.score < 40 ||
                scored.solutionType === "answer_only" ||
                scored.solutionType === "discussion"
            ) {
                status = "rejected";
            } else {
                status = "needs_review";
            }
            updateStmt.run(
                status,
                scored.solutionType,
                scored.score,
                JSON.stringify(scored.flags),
                version,
                JSON.stringify(scored.reasons),
                isOfficial ? 1 : 0,
                row.id,
            );
            updated++;
        }

        // Near-duplicate detection is per problem, but asking for one problem's
        // candidates at a time made SQLite drive the scan off
        // idx_solutions_duplicate_of (`duplicate_of_solution_id IS NULL` matches
        // nearly every row, and the phase above just widened it), re-walking the
        // whole table once per problem. Read the candidate set once and bucket it
        // by problem_id here instead.
        const candidatesByProblem = new Map();
        for (const row of db
            .query(
                `SELECT s.*
                 FROM solutions s
                 WHERE s.status IN ('accepted', 'needs_review', 'candidate')
                   AND s.duplicate_of_solution_id IS NULL
                 ORDER BY s.problem_id, s.id`,
            )
            .all()) {
            const summary = summaryFor(row.id);
            const candidate = {
                ...row,
                best_source_priority: summary.bestSourcePriority,
                has_known_solution_user: summary.hasKnownSolutionUser,
                earliest_posted_at: summary.earliestPostedAt,
            };
            const bucket = candidatesByProblem.get(row.problem_id);
            if (bucket) bucket.push(candidate);
            else candidatesByProblem.set(row.problem_id, [candidate]);
        }

        const markDuplicateStmt = db.prepare(
            `UPDATE solutions SET
                status = 'duplicate',
                duplicate_of_solution_id = ?,
                updated_at = datetime('now')
             WHERE id = ? AND status_source != 'manual'`,
        );

        for (const candidates of candidatesByProblem.values()) {
            // One token set per candidate rather than one per comparison.
            const tokens = candidates.map((c) => tokenSet(c.content));

            const consumed = new Set();
            for (let i = 0; i < candidates.length; i++) {
                if (consumed.has(candidates[i].id)) continue;
                const group = [candidates[i]];
                for (let j = i + 1; j < candidates.length; j++) {
                    if (consumed.has(candidates[j].id)) continue;
                    if (
                        tokenSetSimilarity(tokens[i], tokens[j]) >=
                        nearDuplicateThreshold
                    ) {
                        group.push(candidates[j]);
                    }
                }
                if (group.length <= 1) continue;
                group.sort(compareCanonicalSolutions);
                const canonical = group[0];
                for (const duplicate of group.slice(1)) {
                    if (duplicate.status_source === "manual") continue;
                    markDuplicateStmt.run(canonical.id, duplicate.id);
                    consumed.add(duplicate.id);
                    duplicates++;
                }
            }
        }
    })();

    return { updated, duplicates };
}

export function initDB(dbPath) {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);

    // Migration: add new columns if they don't exist
    const existingCols = db
        .query("PRAGMA table_info(problems)")
        .all()
        .map((r) => r.name);
    if (
        existingCols.includes("aops_answers") &&
        !existingCols.includes("aops_choices")
    ) {
        db.exec(`ALTER TABLE problems ADD COLUMN aops_choices TEXT`);
        db.exec(`ALTER TABLE problems ADD COLUMN aops_answer TEXT`);
        // migrate data: aops_choices = aops_answers (best effort)
        db.exec(
            `UPDATE problems SET aops_choices = aops_answers WHERE aops_answers IS NOT NULL AND aops_answers != '[]'`,
        );
        db.exec(`ALTER TABLE problems DROP COLUMN aops_answers`);
    }
    if (!existingCols.includes("tags")) {
        db.exec(`ALTER TABLE problems ADD COLUMN tags TEXT`);
    }

    // Migration: reshape the resolved/merged columns and rename topic→acgn.
    //   answers      -> answer_value (literal answer = COALESCE(pdf_answer, aops_answer))
    //   topic        -> acgn
    //   pdf_solutions-> dropped (was never written/read)
    // Rebuild the table from the current SCHEMA (preserving id so child FKs in
    // solutions/oly_potential_solutions/problem_history stay valid).
    if (
        existingCols.includes("answers") ||
        existingCols.includes("topic") ||
        existingCols.includes("pdf_solutions")
    ) {
        db.transaction(() => {
            db.exec(`PRAGMA foreign_keys = OFF;`);
            db.exec(`ALTER TABLE problems RENAME TO problems_old;`);
            // The index follows the rename to problems_old and keeps its name;
            // drop it so SCHEMA can recreate it on the new table.
            db.exec(`DROP INDEX IF EXISTS idx_problems_aops_topic;`);
            // CREATE TABLE IF NOT EXISTS in SCHEMA recreates `problems` with the
            // new shape; all other tables already exist and are skipped.
            db.exec(SCHEMA);
            db.exec(`
INSERT INTO problems (
  id, test_id, n, section,
  aops_topic_id, aops_post_id, aops_statement, aops_answer_index, aops_choices, aops_answer,
  pdf_statement, pdf_answer, pdf_source,
  statement, answer_index, answer_value,
  acgn, tags, is_computational, difficulty, quality, verified, notes,
  created_at, updated_at
)
SELECT
  id, test_id, n, section,
  aops_topic_id, aops_post_id, aops_statement, aops_answer_index, aops_choices, aops_answer,
  pdf_statement, pdf_answer, pdf_source,
  statement, answer_index, COALESCE(pdf_answer, aops_answer),
  topic, tags, is_computational, difficulty, quality, verified, notes,
  created_at, updated_at
FROM problems_old;
            `);
            db.exec(`DROP TABLE problems_old;`);
            db.exec(`PRAGMA foreign_keys = ON;`);
        })();
    }

    const existingSeriesCols = db
        .query("PRAGMA table_info(series)")
        .all()
        .map((r) => r.name);
    if (!existingSeriesCols.includes("aops_id")) {
        db.exec(`ALTER TABLE series ADD COLUMN aops_id INTEGER DEFAULT -1`);
    }
    db.exec(`UPDATE series SET aops_id = -1 WHERE aops_id IS NULL`);
    db.exec(`DROP INDEX IF EXISTS idx_series_aops_id`);

    // Migration: tests table changes (make is_computational BOOLEAN)
    const testsColsInfo = db.query("PRAGMA table_info(tests)").all();
    const isCompCol = testsColsInfo.find((r) => r.name === "is_computational");
    if (isCompCol && isCompCol.type === "INTEGER") {
        db.transaction(() => {
            db.exec(`PRAGMA foreign_keys = OFF;`);
            db.exec(`ALTER TABLE tests RENAME TO tests_old;`);
            db.exec(`
CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id        INTEGER REFERENCES series(id),
  name             TEXT NOT NULL,
  year             INTEGER,
  aops_category_id TEXT UNIQUE,
  type             TEXT,
  is_computational BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  aops_url TEXT GENERATED ALWAYS AS ('https://artofproblemsolving.com/community/c' || aops_category_id) STORED
);
            `);
            db.exec(`
INSERT INTO tests (id, series_id, name, year, aops_category_id, type, is_computational, difficulty, quality)
SELECT id, series_id, name, year, aops_category_id, type, COALESCE(is_computational, 0), difficulty, quality
FROM tests_old;
            `);
            db.exec(`DROP TABLE tests_old;`);
            db.exec(`PRAGMA foreign_keys = ON;`);
        })();
    }

    // Migration: series table changes (make is_official BOOLEAN)
    const seriesColsInfo = db.query("PRAGMA table_info(series)").all();
    const isOffCol = seriesColsInfo.find((r) => r.name === "is_official");
    if (isOffCol && isOffCol.type === "INTEGER") {
        db.transaction(() => {
            db.exec(`PRAGMA foreign_keys = OFF;`);
            db.exec(`ALTER TABLE series RENAME TO series_old;`);
            db.exec(`
CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  aops_id     INTEGER DEFAULT -1,
  is_official BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_official IN (0, 1))
);
            `);
            db.exec(`
INSERT INTO series (id, name, aops_id, is_official)
SELECT id, name, aops_id, COALESCE(is_official, 0)
FROM series_old;
            `);
            db.exec(`DROP TABLE series_old;`);
            db.exec(`PRAGMA foreign_keys = ON;`);
        })();
    }

    // Migration: give tests per-section columns (section / section_name) and
    // swap the standalone UNIQUE(aops_category_id) for UNIQUE(aops_category_id,
    // section), then split any existing sectioned test (its problems carry
    // section >= 0) into one test row per section. Section titles were never
    // stored, so migrated section tests get a "Section N" placeholder name;
    // a re-scrape re-links them by (aops_category_id, section) and backfills
    // the real title. A test with a single section is treated as flat.
    const testsMigCols = db
        .query("PRAGMA table_info(tests)")
        .all()
        .map((r) => r.name);
    if (!testsMigCols.includes("section_name")) {
        db.transaction(() => {
            db.exec(`PRAGMA foreign_keys = OFF;`);
            db.exec(`ALTER TABLE tests RENAME TO tests_old;`);
            // CREATE TABLE IF NOT EXISTS in SCHEMA recreates `tests` with the
            // new shape; all other tables already exist and are skipped.
            db.exec(SCHEMA);
            db.exec(`
INSERT INTO tests (id, series_id, name, section, section_name, year, aops_category_id, type, is_computational, difficulty, quality)
SELECT id, series_id, name, -1, NULL, year, aops_category_id, type, COALESCE(is_computational, 0), difficulty, quality
FROM tests_old;
            `);
            db.exec(`DROP TABLE tests_old;`);
            db.exec(`PRAGMA foreign_keys = ON;`);

            // Split existing sectioned tests into one test row per section.
            const sectionRows = db
                .query(
                    `SELECT test_id, section FROM problems
                     WHERE section >= 0
                     GROUP BY test_id, section
                     ORDER BY test_id, section`,
                )
                .all();
            const sectionsByTest = new Map();
            for (const { test_id, section } of sectionRows) {
                if (!sectionsByTest.has(test_id))
                    sectionsByTest.set(test_id, []);
                sectionsByTest.get(test_id).push(section);
            }

            for (const [testId, sections] of sectionsByTest) {
                const base = db
                    .query(`SELECT * FROM tests WHERE id = ?`)
                    .get(testId);
                if (!base) continue;

                if (sections.length === 1) {
                    // A single section is effectively a flat test: keep the row
                    // and just flatten its problems to section = -1 (matches a
                    // fresh scrape of a one-section category).
                    db.run(`UPDATE problems SET section = -1 WHERE test_id = ?`, [
                        testId,
                    ]);
                    continue;
                }

                sections.forEach((s, i) => {
                    const placeholder = `Section ${s + 1}`;
                    const name = `${base.name} ${placeholder}`;
                    let sectionTestId;
                    if (i === 0) {
                        // Reuse the base row for the first section.
                        db.run(
                            `UPDATE tests SET name = ?, section = ?, section_name = ? WHERE id = ?`,
                            [name, s, placeholder, testId],
                        );
                        sectionTestId = testId;
                    } else {
                        db.run(
                            `INSERT INTO tests (series_id, name, section, section_name, year, aops_category_id, type, is_computational, difficulty, quality)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                base.series_id,
                                name,
                                s,
                                placeholder,
                                base.year,
                                base.aops_category_id,
                                base.type,
                                base.is_computational,
                                base.difficulty,
                                base.quality,
                            ],
                        );
                        sectionTestId = db
                            .query(
                                `SELECT id FROM tests WHERE rowid = last_insert_rowid()`,
                            )
                            .get().id;
                    }
                    // Move this section's problems onto the section test,
                    // flattening section to -1.
                    db.run(
                        `UPDATE problems SET test_id = ?, section = -1 WHERE test_id = ? AND section = ?`,
                        [sectionTestId, testId, s],
                    );
                });
            }
        })();
    }

    // Presentation-only series review metadata. These fields are deliberately
    // absent from every natural/unique key and are populated on a later
    // structured re-import rather than parsed from existing display names.
    const testsMetadataCols = db
        .query("PRAGMA table_info(tests)")
        .all()
        .map((r) => r.name);
    for (const [col, type] of [
        ["division", "TEXT"],
        ["division_order", "INTEGER"],
        ["format", "TEXT"],
        ["format_order", "INTEGER"],
    ]) {
        if (!testsMetadataCols.includes(col)) {
            db.exec(`ALTER TABLE tests ADD COLUMN ${col} ${type}`);
        }
    }

    // Migration: production_problems was redesigned/extended or schema changed. It holds only
    // derived data, so drop the stale shape and let SCHEMA recreate the new one.
    const prodTableInfo = db.query("PRAGMA table_info(production_problems)").all();
    const prodCols = prodTableInfo.map((r) => r.name);
    const choicesCol = prodTableInfo.find((r) => r.name === "choices");
    const tagsCol = prodTableInfo.find((r) => r.name === "tags");

    const needsRecreate = prodCols.length > 0 && (
        !prodCols.includes("test_id") ||
        !prodCols.includes("canonical_test_id") ||
        !prodCols.includes("aops_id") ||
        prodCols.includes("answer_value") ||
        prodCols.includes("acgn") ||
        !prodCols.includes("topic") ||
        !prodCols.includes("response_kind") ||
        prodCols.includes("section") ||
        (choicesCol && choicesCol.type !== "TEXT[]") ||
        (tagsCol && tagsCol.type !== "TEXT[]")
    );

    if (needsRecreate) {
        db.exec(`DROP TABLE production_problems`);
        db.exec(SCHEMA);
    }

    // Data migration: the "Purple Comet Problems" series was renamed to
    // "Purple Comet". Rename the series row (OR IGNORE in case a "Purple Comet"
    // row already exists) and rewrite affected test names so existing rows line
    // up with fresh scrapes / PDF imports. Idempotent.
    db.run(
        `UPDATE OR IGNORE series SET name = 'Purple Comet' WHERE name = 'Purple Comet Problems'`,
    );
    db.run(
        `UPDATE tests SET name = REPLACE(name, 'Purple Comet Problems', 'Purple Comet') WHERE name LIKE '%Purple Comet Problems%'`,
    );

    // Migration: add the wiki_* source-tier columns to already-migrated DBs.
    // New DBs (and DBs that pass through the rename→recreate reshape above) get
    // these from SCHEMA; a production DB past that reshape needs explicit ALTERs.
    // Re-read table_info so we see the post-reshape shape.
    const problemsColsNow = db
        .query("PRAGMA table_info(problems)")
        .all()
        .map((r) => r.name);
    for (const [col, type] of [
        ["wiki_page", "TEXT"],
        ["wiki_statement", "TEXT"],
        ["wiki_choices", "TEXT"],
        ["wiki_answer_index", "INTEGER"],
        ["wiki_answer", "TEXT"],
    ]) {
        if (!problemsColsNow.includes(col)) {
            db.exec(`ALTER TABLE problems ADD COLUMN ${col} ${type}`);
        }
    }

    // Migration: MATHCOUNTS Countdown tests were named from the raw OCR folder
    // token ("2000 MATHCOUNTS National Cdr") while their format column already
    // said "Countdown". pdfImport now builds MATHCOUNTS names from the resolved
    // labels, so the older rows are renamed to match — otherwise the "cdr" and
    // "countdown" folder spellings would resolve to two tests for one round.
    // Idempotent, and the NOT EXISTS guard keeps a rename from colliding with a
    // row that already carries the new name.
    db.run(`
        UPDATE tests AS t SET name = replace(t.name, ' Cdr', ' Countdown')
        WHERE t.format = 'Countdown'
          AND t.name LIKE '% Cdr'
          AND NOT EXISTS (
              SELECT 1 FROM tests o
              WHERE o.series_id = t.series_id
                AND o.name = replace(t.name, ' Cdr', ' Countdown')
                AND o.year IS t.year
          )
    `);

    // Data migration: response formats that are structural facts of a series.
    // AMC is MCQ regardless of whether a particular wiki/forum statement still
    // contains extractable option text. Idempotent and shared with upsertTest's
    // new-row/refresh policy via SERIES_RESPONSE_KIND_DECLARATIONS.
    for (const [seriesName, responseKind] of Object.entries(
        SERIES_RESPONSE_KIND_DECLARATIONS,
    )) {
        db.run(
            `UPDATE tests SET response_kind = ?
             WHERE series_id = (SELECT id FROM series WHERE name = ?)
               AND response_kind IS NOT ?`,
            [responseKind, seriesName, responseKind],
        );
    }

    return db;
}

export function upsertSeries(db, name, aopsId = -1, isOfficial = false) {
    const finalAopsId = aopsId === null || aopsId === undefined ? -1 : aopsId;
    db.run(
        `INSERT INTO series (name, aops_id, is_official) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET
        aops_id = CASE WHEN excluded.aops_id != -1 THEN excluded.aops_id ELSE series.aops_id END,
        is_official = MAX(series.is_official, excluded.is_official)
    `,
        [name, finalAopsId, isOfficial ? 1 : 0],
    );
    return db.query(`SELECT id FROM series WHERE name = ?`).get(name).id;
}

// Resolves an existing test id. Prefers the AoPS category id + section (stable
// when present); otherwise falls back to the natural key (series_id, year, name)
// so non-AoPS sources (e.g. Mandelbrot) dedup, and a PDF-first test can later be
// linked to its AoPS category. `section` defaults to -1 (a flat, unsectioned
// test); sibling section tests share the AoPS category id and differ by section.
// Returns null if no match.
export function resolveTestId(db, { aopsCategoryId, section = -1, seriesId, year, name }) {
    if (aopsCategoryId != null) {
        const byAops = db
            .query(`SELECT id FROM tests WHERE aops_category_id = ? AND section = ?`)
            .get(aopsCategoryId, section);
        if (byAops) return byAops.id;
    }
    // `year IS ?` matches NULL years too (IS behaves like = for non-NULL).
    const byNatural = db
        .query(
            `SELECT id FROM tests WHERE series_id = ? AND name = ? AND year IS ?`,
        )
        .get(seriesId, name, year ?? null);
    return byNatural ? byNatural.id : null;
}

// Resolve a problem row id by its natural key (test_id, n, section). Returns null
// if no such problem exists yet (e.g. a duplicates.json member whose test hasn't
// been imported). Problems always store section = -1 (sections live on the test
// row), so callers normally pass the default.
export function resolveProblemId(db, { testId, n, section = -1 }) {
    const row = db
        .query(`SELECT id FROM problems WHERE test_id = ? AND n = ? AND section = ?`)
        .get(testId, n, section);
    return row ? row.id : null;
}

// Upsert a duplicate-problem link (alias problem_id -> canonical_problem_id).
// Additive and merge-contract-aware: a link a human has curated
// (status_source='manual') is never overwritten by an automatic importer; a
// manual caller (statusSource='manual') always wins. Self-links are ignored.
// Returns 'inserted' | 'updated' | 'skipped' | 'preserved'.
export function upsertProblemLink(
    db,
    {
        problemId,
        canonicalProblemId,
        source,
        similarity = null,
        scope = null,
        status = "candidate",
        statusSource = "auto",
        notes = null,
    },
) {
    if (problemId == null || canonicalProblemId == null) return "skipped";
    if (problemId === canonicalProblemId) return "skipped";

    const existing = db
        .query(
            `SELECT id, status_source FROM problem_links WHERE problem_id = ?`,
        )
        .get(problemId);

    // Never let an automatic importer clobber a human's curated link.
    if (existing && existing.status_source === "manual" && statusSource !== "manual") {
        return "preserved";
    }

    if (existing) {
        db.run(
            `UPDATE problem_links SET
                canonical_problem_id = ?,
                source        = ?,
                similarity    = ?,
                scope         = ?,
                status        = ?,
                status_source = ?,
                notes         = COALESCE(?, notes),
                updated_at    = datetime('now')
             WHERE id = ?`,
            [
                canonicalProblemId,
                source,
                similarity,
                scope,
                status,
                statusSource,
                notes,
                existing.id,
            ],
        );
        return "updated";
    }

    db.run(
        `INSERT INTO problem_links (
            problem_id, canonical_problem_id, source, similarity, scope,
            status, status_source, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            problemId,
            canonicalProblemId,
            source,
            similarity,
            scope,
            status,
            statusSource,
            notes,
        ],
    );
    return "inserted";
}

// Resolve a problem's canonical id by following ACCEPTED links to the ultimate
// representative (transitive; guarded against cycles). A problem with no accepted
// alias link is its own canonical, so this returns the input id. Used by build.
export function resolveCanonicalId(db, problemId) {
    const stmt = db.query(
        `SELECT canonical_problem_id FROM problem_links
         WHERE problem_id = ? AND status = 'accepted'`,
    );
    const seen = new Set();
    let current = problemId;
    while (!seen.has(current)) {
        seen.add(current);
        const row = stmt.get(current);
        if (!row || row.canonical_problem_id == null) break;
        current = row.canonical_problem_id;
    }
    return current;
}

const TEST_METADATA_KEYS = [
    "division",
    "divisionOrder",
    "format",
    "formatOrder",
];

function testMetadataFields(test) {
    const metadata = {};
    for (const key of TEST_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(test, key)) {
            metadata[key] = test[key];
        }
    }
    return metadata;
}

// `updateSection` controls whether an UPDATE (merge onto an existing row) may
// rewrite section/section_name. The scraper owns a test's section structure, so
// it passes true; non-scrape sources (PDF import) pass false so they never
// disturb the section metadata of a row the scraper created — e.g. a PDF
// "High School" test merging by name onto a genuinely two-section AoPS year must
// not flatten a sibling section to -1 and collide on UNIQUE(aops_category_id,
// section). A brand-new row still takes the caller's section on INSERT.
// Review/coverage metadata uses property presence as ownership: omitted fields
// preserve the stored value, while explicitly supplied null clears stale
// classification. A structural series declaration outranks importer presence:
// it is an intrinsic contest fact rather than a source snapshot.
export function upsertTest(db, test, seriesId) {
    const {
        aopsCategoryId,
        name,
        section = -1,
        sectionName = null,
        year,
        type,
        isComputational,
        updateSection = true,
        division,
        divisionOrder,
        format,
        formatOrder,
        responseKind,
        answerStatus,
    } = test;
    const has = (key) => Object.prototype.hasOwnProperty.call(test, key);
    const seriesName = db
        .query(`SELECT name FROM series WHERE id = ?`)
        .get(seriesId)?.name;
    const structuralResponseKind = responseKindForSeries(seriesName);
    const effectiveResponseKind = structuralResponseKind ?? responseKind;
    const updateResponseKind =
        structuralResponseKind != null || has("responseKind");
    const updateDivisionOrder =
        has("divisionOrder") || (has("division") && division == null);
    const updateFormatOrder =
        has("formatOrder") || (has("format") && format == null);
    const normalizedDivisionOrder =
        division == null && has("division") ? null : divisionOrder;
    const normalizedFormatOrder =
        format == null && has("format") ? null : formatOrder;
    const existingId = resolveTestId(db, {
        aopsCategoryId,
        section,
        seriesId,
        year,
        name,
    });

    if (existingId != null) {
        db.run(
            `
            UPDATE tests SET
                name             = ?,
                section          = CASE WHEN ? THEN ? ELSE section END,
                section_name     = CASE WHEN ? THEN ? ELSE section_name END,
                year             = ?,
                division         = CASE WHEN ? THEN ? ELSE division END,
                division_order   = CASE WHEN ? THEN ? ELSE division_order END,
                format           = CASE WHEN ? THEN ? ELSE format END,
                format_order     = CASE WHEN ? THEN ? ELSE format_order END,
                type             = ?,
                is_computational = ?,
                -- Coverage semantics are only rewritten by an importer that
                -- actually read a profile; a scrape without one leaves them be.
                response_kind    = CASE WHEN ? THEN ? ELSE response_kind END,
                answer_status    = CASE WHEN ? THEN ? ELSE answer_status END,
                series_id        = ?,
                -- Link the AoPS id when one arrives; never clobber an existing link.
                aops_category_id = COALESCE(aops_category_id, ?)
            WHERE id = ?
        `,
            [
                name,
                updateSection ? 1 : 0,
                section,
                updateSection ? 1 : 0,
                sectionName ?? null,
                year ?? null,
                has("division") ? 1 : 0,
                division ?? null,
                updateDivisionOrder ? 1 : 0,
                normalizedDivisionOrder ?? null,
                has("format") ? 1 : 0,
                format ?? null,
                updateFormatOrder ? 1 : 0,
                normalizedFormatOrder ?? null,
                type ?? null,
                isComputational ? 1 : 0,
                updateResponseKind ? 1 : 0,
                effectiveResponseKind ?? null,
                has("answerStatus") ? 1 : 0,
                answerStatus ?? null,
                seriesId,
                aopsCategoryId ?? null,
                existingId,
            ],
        );
        return existingId;
    }

    db.run(
        `
        INSERT INTO tests (
            series_id, name, section, section_name, year,
            division, division_order, format, format_order,
            aops_category_id, type, is_computational,
            response_kind, answer_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        [
            seriesId,
            name,
            section,
            sectionName ?? null,
            year ?? null,
            division ?? null,
            division == null ? null : (divisionOrder ?? null),
            format ?? null,
            format == null ? null : (formatOrder ?? null),
            aopsCategoryId ?? null,
            type ?? null,
            isComputational ? 1 : 0,
            effectiveResponseKind ?? null,
            answerStatus ?? null,
        ],
    );
    return db
        .query(`SELECT id FROM tests WHERE rowid = last_insert_rowid()`)
        .get().id;
}

function upsertSolutions(db, problemId, solutions, allPosts, isOly) {
    for (const sol of solutions ?? []) {
        upsertSolutionCandidate(db, {
            problemId,
            source: "aops",
            sourceKey:
                sol.post_id != null ? `post:${sol.post_id}` : undefined,
            content: sol.content,
            raw_content: sol.content,
            aops_topic_id: sol.topic_id ?? null,
            aops_post_id: sol.post_id ?? null,
            aops_user_id: sol.user_id ?? null,
            aops_username: sol.username ?? null,
            posted_at: sol.posted_at ?? null,
            is_official: false,
        });
    }

    if (isOly && allPosts && allPosts.length > 0) {
        db.run(
            `
            INSERT INTO oly_potential_solutions (problem_id, posts)
            VALUES (?, ?)
            ON CONFLICT (problem_id) DO UPDATE SET
                posts = excluded.posts,
                scraped_at = datetime('now')
        `,
            [problemId, JSON.stringify(allPosts)],
        );
    }
}

// The `acgn` topic for a problem being written under `testId`: the parent
// test's declared subject when it has one (a Calculus / Integration Bee round),
// else the keyword inference over the statement. See src/topicPolicy.js. Every
// path that writes problems.acgn — here and in preprocess's reclassify step —
// must resolve it this way, or a re-run of `preprocess` would undo the
// declaration. bun:sqlite caches prepared statements per SQL string, so the
// per-problem lookup is a hash hit, not a re-parse.
function topicForTest(db, testId, statement) {
    const test = db.query(`SELECT format FROM tests WHERE id = ?`).get(testId);
    return resolveTopic(statement, test);
}

function upsertProblem(db, problem, testId) {
    const aopsChoices =
        problem.choices != null ? JSON.stringify(problem.choices) : null;
    const aopsAnswer = problem.answerValue ?? null; // literal answer (letter or number)
    const aopsAnswerIndex = problem.answerIndex ?? -1; // index into choices for MCQ
    const section = problem.section ?? -1;
    const acgn = topicForTest(db, testId, problem.statement);
    const autoTagsList = getAutoTags(problem.statement);
    const tagsJson =
        autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    // Check for statement change BEFORE the upsert so we can log the old value
    const existing = db
        .query(
            `
        SELECT id, aops_statement FROM problems WHERE test_id = ? AND n = ? AND section = ?
    `,
        )
        .get(testId, problem.n, section);

    if (
        existing &&
        existing.aops_statement &&
        existing.aops_statement !== problem.statement
    ) {
        db.run(
            `
            INSERT INTO problem_history (problem_id, old_statement, new_statement)
            VALUES (?, ?, ?)
        `,
            [existing.id, existing.aops_statement, problem.statement],
        );
    }

    db.run(
        `
        INSERT INTO problems (
            test_id, n, section, aops_topic_id, aops_post_id,
            aops_statement, aops_answer_index, aops_choices, aops_answer,
            statement, answer_index, answer_value,
            acgn, tags, is_computational
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            aops_topic_id     = excluded.aops_topic_id,
            aops_post_id      = excluded.aops_post_id,
            aops_statement    = excluded.aops_statement,
            aops_answer_index = excluded.aops_answer_index,
            aops_choices      = excluded.aops_choices,
            aops_answer       = excluded.aops_answer,
            -- Resolved values, trust order verified > pdf > wiki > aops. This
            -- (aops) path reads its own tier from excluded.*, other tiers from
            -- problems.*, so every write path computes the same result.
            statement    = COALESCE(problems.pdf_statement, problems.wiki_statement, excluded.aops_statement),
            answer_value = CASE
                WHEN problems.verified THEN problems.answer_value
                WHEN problems.pdf_answer IS NOT NULL THEN problems.pdf_answer
                WHEN problems.wiki_answer IS NOT NULL THEN problems.wiki_answer
                ELSE excluded.aops_answer
            END,
            -- answer_index keys off which choices win (wiki_choices > aops_choices)
            -- so it always indexes into the resolved choices array.
            answer_index = CASE
                WHEN problems.verified THEN problems.answer_index
                WHEN problems.wiki_choices IS NOT NULL THEN problems.wiki_answer_index
                ELSE excluded.aops_answer_index
            END,
            -- Scraper-immutable: acgn never overwritten after INSERT (re-run via preprocess)
            acgn = problems.acgn,
            -- Scraper-immutable: tags are UNION'd, never overwritten
            tags = CASE
                WHEN problems.tags IS NULL THEN excluded.tags
                WHEN excluded.tags IS NULL THEN problems.tags
                ELSE (
                    SELECT json_group_array(DISTINCT value)
                    FROM (
                        SELECT value FROM json_each(problems.tags)
                        UNION
                        SELECT value FROM json_each(excluded.tags)
                    )
                )
            END,
            -- Scraper-immutable: verified never touched by scraper
            verified = problems.verified,
            -- Scraper-immutable: difficulty, quality, notes are manual only
            difficulty = problems.difficulty,
            quality    = problems.quality,
            notes      = problems.notes,
            updated_at = datetime('now')
    `,
        [
            testId,
            problem.n,
            section,
            problem.topicId ?? null,
            problem.postId ?? null,
            problem.statement,
            aopsAnswerIndex,
            aopsChoices,
            aopsAnswer,
            problem.statement,
            aopsAnswerIndex,
            aopsAnswer,
            acgn,
            tagsJson,
            problem.is_computational ? 1 : 0,
        ],
    );

    // Upsert solutions / potential solutions if present
    const row = db
        .query(
            `SELECT id FROM problems WHERE test_id = ? AND n = ? AND section = ?`,
        )
        .get(testId, problem.n, section);
    if (row && (problem.solutions?.length || problem.posts?.length)) {
        const isOly = problem.is_computational === false;
        upsertSolutions(db, row.id, problem.solutions, problem.posts, isOly);
    }
}

// Upserts a problem from a PDF/OCR source. Writes the manual pdf_* columns and
// re-resolves statement/answer_value following the same merge contract the
// scraper uses (pdf_* / verified outrank aops_*). Unlike upsertProblem it never
// touches aops_*, acgn, tags, verified, difficulty, quality or notes on an
// existing row, and a missing OCR answer never wipes an existing pdf_answer.
// PDF import is additive only — no orphan cleanup — so AoPS-only rows survive.
//
// Coverage: `coverage_response_kind`/`coverage_answer_status` are the SPARSE
// OVERRIDE tier and hold only what a source said about this problem specifically
// (see src/coverage.js). The caller separately passes `answerNotApplicable`, the
// RESOLVED verdict including any inherited test declaration, because clearing a
// stale answer is an action that must follow the resolved state even when the
// claim lives on the test row.
//
// That clearing is the one exception to "a missing answer never wipes": when the
// resolved answer_status is `not_applicable`, a source has affirmatively said no
// answer exists, so any previously imported one goes. That is what retracts the
// answers OCR'd out of proof prose before comp-OCR declared those tests proof —
// deleting the upstream problem_answer.json alone would not, because the
// COALESCE below is otherwise designed to preserve exactly such a value.
export function upsertPdfProblem(db, problem, testId) {
    const section = -1; // section lives on the test row; problems always -1
    const statement = problem.statement;
    const has = (key) => Object.prototype.hasOwnProperty.call(problem, key);
    const updateCoverageResponseKind = has("coverage_response_kind");
    const updateCoverageAnswerStatus = has("coverage_answer_status");
    const coverageResponseKind = problem.coverage_response_kind ?? null;
    const coverageAnswerStatus = problem.coverage_answer_status ?? null;
    const answerNotApplicable = problem.answerNotApplicable === true;
    const answer = answerNotApplicable ? null : (problem.answer ?? null);
    const source = problem.source ?? null;
    const acgn = topicForTest(db, testId, statement);
    const autoTagsList = getAutoTags(statement);
    const tagsJson =
        autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    // RETURNING fires on both the INSERT and the DO UPDATE path, so it recovers
    // the (possibly pre-existing) row id in one statement — no separate SELECT,
    // and no reliance on last_insert_rowid() (unreliable through ON CONFLICT).
    // Callers use this id to attach imported solutions.
    return db
        .query(
            `
        INSERT INTO problems (
            test_id, n, section,
            pdf_statement, pdf_answer, pdf_source,
            statement, answer_index, answer_value,
            acgn, tags, is_computational,
            coverage_response_kind, coverage_answer_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            pdf_statement = excluded.pdf_statement,
            -- A source-backed not_applicable retracts an automatic answer, but
            -- never destroys verified curation. A verified contradiction is
            -- stored and surfaced as a blocking build conflict below.
            pdf_answer    = CASE
                WHEN problems.verified THEN problems.pdf_answer
                WHEN ? THEN NULL
                ELSE COALESCE(excluded.pdf_answer, problems.pdf_answer)
            END,
            pdf_source    = excluded.pdf_source,
            -- Resolved values, trust order verified > pdf > wiki > aops. pdf tier
            -- from excluded.*, wiki/aops from problems.*.
            statement    = COALESCE(excluded.pdf_statement, problems.wiki_statement, problems.aops_statement),
            answer_value = CASE
                WHEN problems.verified THEN problems.answer_value
                WHEN ? THEN NULL
                ELSE COALESCE(excluded.pdf_answer, problems.pdf_answer, problems.wiki_answer, problems.aops_answer)
            END,
            -- pdf carries no choice index; the resolved index rides on whichever
            -- choices win (wiki > aops), keeping it order-independent.
            answer_index = CASE
                WHEN problems.verified THEN problems.answer_index
                WHEN ? THEN -1
                WHEN problems.wiki_choices IS NOT NULL THEN problems.wiki_answer_index
                ELSE problems.aops_answer_index
            END,
            -- Structural fact about the contest, refreshed like tests.is_computational
            -- (upsertTest) so a corrected config propagates to existing rows and a
            -- test never disagrees with its problems.
            is_computational = excluded.is_computational,
            -- Property presence carries snapshot ownership: omitted properties
            -- preserve stored overrides; an explicit NULL clears them.
            coverage_response_kind = CASE
                WHEN ? THEN excluded.coverage_response_kind
                ELSE problems.coverage_response_kind
            END,
            coverage_answer_status = CASE
                WHEN ? THEN excluded.coverage_answer_status
                ELSE problems.coverage_answer_status
            END,
            updated_at = datetime('now')
        RETURNING id
    `,
        )
        .get(
            testId,
            problem.n,
            section,
            statement,
            answer,
            source,
            statement,
            -1,
            answer,
            acgn,
            tagsJson,
            problem.is_computational ? 1 : 0,
            coverageResponseKind,
            coverageAnswerStatus,
            // The three `?`s guarding the not_applicable branches above, in
            // statement order: pdf_answer, answer_value, answer_index.
            answerNotApplicable ? 1 : 0,
            answerNotApplicable ? 1 : 0,
            answerNotApplicable ? 1 : 0,
            updateCoverageResponseKind ? 1 : 0,
            updateCoverageAnswerStatus ? 1 : 0,
        ).id;
}

// Applies a PDF/OCR answer to a problem the OCR produced NO statement for.
//
// An answer key covers the whole test, but OCR can drop individual statements
// (a lost page region), so problem_answer.json routinely names problems absent
// from problems.json. Those answers used to be silently unreachable — the import
// loop only visited statement keys — even when an AoPS scrape had already
// supplied a perfectly good statement for the row.
//
// This is UPDATE-only, deliberately: with no statement there is nothing to
// insert, and a row of pure answer would be worse than the gap it fills. Returns
// the problem id, or null when no row exists (an OCR-only test where nothing
// else supplied the statement — the caller reports it rather than inventing a
// row). It writes the answer tier and is_computational only; every statement
// column, and the acgn/tags derived from one, is left exactly as found.
//
// The answer semantics are upsertPdfProblem's, unchanged: verified outranks the
// import, a resolved not_applicable retracts a stale answer, and the resolved
// columns re-COALESCE down the same verified > pdf > wiki > aops ladder.
export function upsertPdfAnswerOnly(db, problem, testId) {
    const section = -1; // section lives on the test row; problems always -1
    const has = (key) => Object.prototype.hasOwnProperty.call(problem, key);
    const updateCoverageResponseKind = has("coverage_response_kind");
    const updateCoverageAnswerStatus = has("coverage_answer_status");
    const answerNotApplicable = problem.answerNotApplicable === true;
    const answer = answerNotApplicable ? null : (problem.answer ?? null);

    const row = db
        .query(
            `
        UPDATE problems SET
            pdf_answer = CASE
                WHEN verified THEN pdf_answer
                WHEN ? THEN NULL
                ELSE COALESCE(?, pdf_answer)
            END,
            -- Provenance of the pdf_* tier, which this write now contributes to.
            pdf_source = COALESCE(?, pdf_source),
            answer_value = CASE
                WHEN verified THEN answer_value
                WHEN ? THEN NULL
                ELSE COALESCE(?, pdf_answer, wiki_answer, aops_answer)
            END,
            answer_index = CASE
                WHEN verified THEN answer_index
                WHEN ? THEN -1
                WHEN wiki_choices IS NOT NULL THEN wiki_answer_index
                ELSE aops_answer_index
            END,
            -- Structural fact about the contest, refreshed here for the same
            -- reason upsertPdfProblem refreshes it: this is the only write path
            -- that knows the series config, so skipping it is what left these
            -- rows disagreeing with their own test row.
            is_computational = ?,
            coverage_response_kind = CASE
                WHEN ? THEN ?
                ELSE coverage_response_kind
            END,
            coverage_answer_status = CASE
                WHEN ? THEN ?
                ELSE coverage_answer_status
            END,
            updated_at = datetime('now')
        WHERE test_id = ? AND n = ? AND section = ?
        RETURNING id
    `,
        )
        .get(
            answerNotApplicable ? 1 : 0,
            answer,
            problem.source ?? null,
            answerNotApplicable ? 1 : 0,
            answer,
            answerNotApplicable ? 1 : 0,
            problem.is_computational ? 1 : 0,
            updateCoverageResponseKind ? 1 : 0,
            problem.coverage_response_kind ?? null,
            updateCoverageAnswerStatus ? 1 : 0,
            problem.coverage_answer_status ?? null,
            testId,
            problem.n,
            section,
        );

    return row?.id ?? null;
}

// Upserts a problem from the AoPS Wiki. Writes the wiki_* tier (statement,
// choices, answer index/value) and re-resolves statement/answer following the
// merge contract (verified > pdf > wiki > aops). Like the PDF path it is
// additive: it never touches aops_*, verified, difficulty, quality, notes or
// tags on an existing row, sets acgn only on a fresh insert, and there is no
// orphan cleanup. Wiki solutions (source='wiki') are refreshed alongside.
export function upsertWikiProblem(db, problem, testId) {
    const section = -1; // section lives on the test row; problems always -1
    const wikiChoices =
        problem.choices != null ? JSON.stringify(problem.choices) : null;
    const wikiAnswer = problem.answerValue ?? null;
    const wikiAnswerIndex = problem.answerIndex ?? -1;
    const statement = problem.statement;
    const acgn = topicForTest(db, testId, statement);
    const autoTagsList = getAutoTags(statement);
    const tagsJson =
        autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    db.run(
        `
        INSERT INTO problems (
            test_id, n, section,
            wiki_page, wiki_statement, wiki_choices, wiki_answer_index, wiki_answer,
            statement, answer_index, answer_value,
            acgn, tags, is_computational
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            wiki_page         = excluded.wiki_page,
            wiki_statement    = excluded.wiki_statement,
            wiki_choices      = excluded.wiki_choices,
            wiki_answer_index = excluded.wiki_answer_index,
            wiki_answer       = excluded.wiki_answer,
            -- Resolved values, trust order verified > pdf > wiki > aops. wiki tier
            -- from excluded.*, pdf/aops from problems.*.
            statement    = COALESCE(problems.pdf_statement, excluded.wiki_statement, problems.aops_statement),
            answer_value = CASE
                WHEN problems.verified THEN problems.answer_value
                WHEN problems.pdf_answer IS NOT NULL THEN problems.pdf_answer
                WHEN excluded.wiki_answer IS NOT NULL THEN excluded.wiki_answer
                ELSE problems.aops_answer
            END,
            answer_index = CASE
                WHEN problems.verified THEN problems.answer_index
                WHEN excluded.wiki_choices IS NOT NULL THEN excluded.wiki_answer_index
                ELSE problems.aops_answer_index
            END,
            updated_at = datetime('now')
    `,
        [
            testId,
            problem.n,
            section,
            problem.page ?? null,
            statement,
            wikiChoices,
            wikiAnswerIndex,
            wikiAnswer,
            statement,
            wikiAnswerIndex,
            wikiAnswer,
            acgn,
            tagsJson,
            problem.is_computational ? 1 : 0,
        ],
    );

    const row = db
        .query(
            `SELECT id FROM problems WHERE test_id = ? AND n = ? AND section = ?`,
        )
        .get(testId, problem.n, section);
    if (row && problem.solutions?.length) {
        upsertWikiSolutions(db, row.id, problem.solutions);
    }
}

// Wiki solutions carry no stable post id, so refresh this problem's wiki
// provenance wholesale. Canonical solution rows are reused by content hash, and
// old auto-only wiki rows with no remaining source are marked superseded.
function upsertWikiSolutions(db, problemId, solutions) {
    const oldWikiSolutionIds = db
        .query(
            `SELECT DISTINCT solution_id
             FROM solution_sources
             WHERE problem_id = ? AND source = 'wiki'`,
        )
        .all(problemId)
        .map((r) => r.solution_id);
    db.run(`DELETE FROM solution_sources WHERE problem_id = ? AND source = 'wiki'`, [
        problemId,
    ]);
    for (const solutionId of oldWikiSolutionIds) {
        markOrphanedAutoSolutionSuperseded(db, solutionId);
    }
    for (const sol of solutions ?? []) {
        if (!sol?.content) continue;
        upsertSolutionCandidate(db, {
            problemId,
            source: "wiki",
            content: sol.content,
            raw_content: sol.content,
            wiki_page: sol.page ?? null,
            wiki_section: sol.section ?? null,
            is_official: sol.is_official === false ? 0 : 1,
            reliability_hint: sol.is_official === false ? 70 : 95,
        });
    }
}

// Removes a test's stale problem rows after a re-scrape: any row whose
// (n, section) is no longer produced by the scrape (e.g. the test's section
// structure changed). Manually-curated rows (pdf_statement set, or verified)
// are always kept. Child rows in solution_sources / solutions /
// oly_potential_solutions / problem_history are deleted alongside their problems.
function cleanupOrphanProblems(db, testId, keepPairs) {
    if (keepPairs.length === 0) return; // never wipe a test on an empty scrape
    const keys = keepPairs.map((p) => `${p.n}|${p.section}`);
    const placeholders = keys.map(() => "?").join(",");
    const orphans = db
        .query(
            `SELECT id FROM problems
             WHERE test_id = ?
               AND pdf_statement IS NULL AND verified = 0
               AND (n || '|' || section) NOT IN (${placeholders})`,
        )
        .all(testId, ...keys);

    for (const { id } of orphans) {
        db.run(`DELETE FROM solution_sources WHERE problem_id = ?`, [id]);
        db.run(`DELETE FROM solutions WHERE problem_id = ?`, [id]);
        db.run(`DELETE FROM oly_potential_solutions WHERE problem_id = ?`, [id]);
        db.run(`DELETE FROM problem_history WHERE problem_id = ?`, [id]);
        db.run(`DELETE FROM problems WHERE id = ?`, [id]);
    }
}

// Recursively flattens raw scrape output into [{seriesName, seriesAopsId, test}] pairs.
// Handles: series ({name, tests}), single test ({id, problems}), or arrays of either.
function collectTestPairs(raw, parentSeriesName, parentSeriesAopsId) {
    if (Array.isArray(raw)) {
        return raw.flatMap((item) =>
            collectTestPairs(item, parentSeriesName, parentSeriesAopsId),
        );
    }
    if (raw.tests) {
        return raw.tests.flatMap((item) =>
            collectTestPairs(item, raw.name, raw.id ?? parentSeriesAopsId),
        );
    }
    return [
        {
            seriesName: parentSeriesName ?? raw.name,
            seriesAopsId: parentSeriesAopsId ?? -1,
            test: raw,
        },
    ];
}

export function upsertScrapeResults(db, raw) {
    const pairs = collectTestPairs(raw, null, null);

    db.transaction(() => {
        const seriesCache = new Map();

        for (const { seriesName, seriesAopsId, test } of pairs) {
            if (!seriesCache.has(seriesName)) {
                seriesCache.set(
                    seriesName,
                    upsertSeries(
                        db,
                        seriesName,
                        seriesAopsId,
                        raw.is_official ?? false,
                    ),
                );
            }
            const seriesId = seriesCache.get(seriesName);
            const aopsCategoryId = test.id != null ? test.id.toString() : null;
            const isComputational = test.computational ?? false;

            // A sectioned test (problems is a 2D array, one bucket per section
            // name) is materialized as one test row per section, named
            // "<test name> <section name>". A flat test is a single row with
            // section = -1. `units` normalizes both into the same shape.
            // A section may be unnamed — the problems a category listed before
            // its first header (the test proper, ahead of a shortlist or a
            // tiebreaker round); that row keeps the plain test name, which is
            // also how resolveTestId re-finds it if it was scraped flat before.
            const sectioned = (test.sections?.length ?? 0) > 0;
            const inheritedMetadata = testMetadataFields(test);
            const units = sectioned
                ? test.sections.map((sectionName, i) => {
                      const sectionMetadata = sectionTestMetadata(
                          test.type,
                          sectionName,
                      );
                      return {
                          name: `${test.name} ${sectionName}`.trim(),
                          section: i,
                          sectionName: sectionName || null,
                          problems: test.problems[i] ?? [],
                          metadata: sectionMetadata ?? inheritedMetadata,
                      };
                  })
                : [
                      {
                          name: test.name,
                          section: -1,
                          sectionName: null,
                          problems: test.problems,
                          metadata: inheritedMetadata,
                      },
                  ];

            for (const unit of units) {
                const testId = upsertTest(
                    db,
                    {
                        aopsCategoryId,
                        name: unit.name,
                        section: unit.section,
                        sectionName: unit.sectionName,
                        year: test.year ?? null,
                        ...unit.metadata,
                        type: test.type ?? null,
                        isComputational,
                    },
                    seriesId,
                );

                // Each section is its own test now, so problems always store
                // section = -1 (the section lives on the test row instead).
                for (const problem of unit.problems) {
                    upsertProblem(
                        db,
                        { ...problem, section: -1, is_computational: isComputational },
                        testId,
                    );
                }

                // Drop rows from a previous scrape that this scrape no longer produced.
                cleanupOrphanProblems(
                    db,
                    testId,
                    unit.problems.map((p) => ({ n: p.n, section: -1 })),
                );
            }
        }
    })();
}

// Additive analog of upsertScrapeResults for AoPS Wiki scrapes. Merges wiki
// problems onto existing forum/PDF rows via the natural key (series_id, name,
// year): aopsCategoryId is null (wiki doesn't know the forum category id) and
// updateSection is false (wiki must not disturb scraper-owned section metadata).
// There is no orphan cleanup, so forum/PDF-only rows always survive. Handles
// flat tests only (AMC/AIME; AIME I/II are separate test rows, not sections).
export function upsertWikiResults(db, raw) {
    const pairs = collectTestPairs(raw, null, null);

    db.transaction(() => {
        const seriesCache = new Map();

        for (const { seriesName, test } of pairs) {
            if (!seriesCache.has(seriesName)) {
                seriesCache.set(
                    seriesName,
                    upsertSeries(db, seriesName, -1, raw.is_official ?? false),
                );
            }
            const seriesId = seriesCache.get(seriesName);
            const isComputational = test.computational ?? false;

            const testId = upsertTest(
                db,
                {
                    aopsCategoryId: null,
                    name: test.name,
                    section: -1,
                    sectionName: null,
                    year: test.year ?? null,
                    ...testMetadataFields(test),
                    type: test.type ?? null,
                    isComputational,
                    updateSection: false,
                },
                seriesId,
            );

            for (const problem of test.problems) {
                upsertWikiProblem(
                    db,
                    { ...problem, section: -1, is_computational: isComputational },
                    testId,
                );
                // Capture a redirect placement (a variant page that redirects to
                // the canonical problem page) for later link resolution.
                if (problem.redirectTarget) {
                    const row = db
                        .query(
                            `SELECT id FROM problems WHERE test_id = ? AND n = ? AND section = -1`,
                        )
                        .get(testId, problem.n);
                    if (row) {
                        db.run(
                            `INSERT INTO wiki_redirects (problem_id, target_page, scope)
                             VALUES (?, ?, ?)
                             ON CONFLICT (problem_id) DO UPDATE SET
                                target_page = excluded.target_page,
                                scope       = excluded.scope,
                                updated_at  = datetime('now')`,
                            [row.id, problem.redirectTarget, test.year ?? null],
                        );
                    }
                }
            }
        }

        // Resolve any redirects whose target is now present (this run or a prior
        // one). Unresolved ones wait for their target contest to be imported.
        resolveWikiRedirectLinks(db);
    })();
}

// Turns captured wiki_redirects rows into accepted problem_links by matching the
// target wiki page title to an imported problem (problems.wiki_page). Idempotent
// and re-runnable with no network (also invoked from preprocess), so a redirect
// resolves once its target contest exists. Returns { linked, unresolved }.
export function resolveWikiRedirectLinks(db) {
    const rows = db
        .query(`SELECT problem_id, target_page, scope FROM wiki_redirects`)
        .all();
    let linked = 0;
    let unresolved = 0;
    for (const r of rows) {
        const target = db
            .query(`SELECT id FROM problems WHERE wiki_page = ? LIMIT 1`)
            .get(r.target_page);
        if (!target || target.id === r.problem_id) {
            if (!target) unresolved++;
            continue;
        }
        const outcome = upsertProblemLink(db, {
            problemId: r.problem_id,
            canonicalProblemId: target.id,
            source: "wiki_redirect",
            similarity: 1.0,
            scope: r.scope != null ? String(r.scope) : null,
            status: "accepted",
        });
        if (outcome === "inserted" || outcome === "updated") linked++;
    }
    return { linked, unresolved };
}

// Collapses transitive accepted-link chains so every alias points DIRECTLY at the
// ultimate canonical (e.g. A->B and B->C becomes A->C). Keeps a canonical from
// also being someone's alias, which keeps build/export a single hop. Human
// (status_source='manual') links are left as authored. Returns { repointed }.
export function normalizeProblemLinks(db) {
    const links = db
        .query(
            `SELECT problem_id, canonical_problem_id, status_source
             FROM problem_links WHERE status = 'accepted'`,
        )
        .all();
    let repointed = 0;
    db.transaction(() => {
        for (const l of links) {
            if (l.status_source === "manual") continue;
            const ultimate = resolveCanonicalId(db, l.canonical_problem_id);
            if (
                ultimate !== l.canonical_problem_id &&
                ultimate !== l.problem_id
            ) {
                db.run(
                    `UPDATE problem_links
                     SET canonical_problem_id = ?, updated_at = datetime('now')
                     WHERE problem_id = ?`,
                    [ultimate, l.problem_id],
                );
                repointed++;
            }
        }
    })();
    return { repointed };
}

/**
 * Formats a JavaScript array (or JSON string representing an array)
 * into a Postgres-style TEXT[] literal representation: e.g. {"a", "b", "c"}
 */
export function toPostgresTextArray(value) {
    if (value === null || value === undefined) {
        return null;
    }
    let arr = value;
    if (typeof value === "string") {
        try {
            arr = JSON.parse(value);
        } catch (e) {
            if (value.startsWith("{") && value.endsWith("}")) {
                return value;
            }
            return null;
        }
    }
    if (!Array.isArray(arr)) {
        return null;
    }
    const escapedElements = arr.map((item) => {
        if (item === null || item === undefined) {
            return "NULL";
        }
        const str = String(item);
        const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `"${escaped}"`;
    });
    return `{${escapedElements.join(",")}}`;
}

export class VerifiedCoverageConflictError extends Error {
    constructor(conflicts) {
        const locations = conflicts
            .map(
                (row) =>
                    `  - ${row.test_name} problem ${row.n + 1} ` +
                    `(problem_id=${row.problem_id}, test_id=${row.test_id})`,
            )
            .join("\n");
        super(
            "Cannot build production_problems: verified answer data " +
                "conflicts with answer_status='not_applicable'.\n" +
                locations +
                "\nResolve each conflict by correcting the coverage claim " +
                "or intentionally removing/unverifying the answer.",
        );
        this.name = "VerifiedCoverageConflictError";
        this.conflicts = conflicts;
    }
}

function getVerifiedCoverageConflicts(db) {
    return db
        .query(
            `SELECT p.id AS problem_id, p.test_id, p.n,
                    COALESCE(t.name, '[missing test]') AS test_name,
                    p.answer_value, p.answer_index
             FROM problems p
             LEFT JOIN tests t ON t.id = p.test_id
             WHERE p.verified = 1
               AND COALESCE(p.coverage_answer_status, t.answer_status)
                   = 'not_applicable'
               AND (p.answer_value IS NOT NULL
                    OR COALESCE(p.answer_index, -1) >= 0)
             ORDER BY p.test_id, p.n, p.id`,
        )
        .all();
}

// Rebuilds the denormalized production_problems table from the curated problems
// + solutions data. The table is purely derived, so we wipe and rebuild it in a
// single transaction. Duplicate problems (accepted problem_links) are handled
// here: an ALIAS row keeps its own placement identity (test_id, n) but its
// content is PROPAGATED from its canonical, and canonical_test_id/canonical_n
// point at the canonical placement (so export can emit the canonical_sync_key
// that shares rating/progress in the cloud). A canonical/standalone row uses its
// own content and leaves canonical_test_id/canonical_n NULL. Returns the count.
export function buildProductionProblems(db) {
    let count = 0;
    db.transaction(() => {
        const verifiedCoverageConflicts = getVerifiedCoverageConflicts(db);
        if (verifiedCoverageConflicts.length > 0) {
            throw new VerifiedCoverageConflictError(
                verifiedCoverageConflicts,
            );
        }

        db.run(`DELETE FROM production_problems`);

        // To restrict production to vetted rows, add a WHERE here
        // (e.g. `WHERE p.verified = 1` or `WHERE p.statement IS NOT NULL`).
        const rows = db
            .query(
                `
            SELECT p.id, p.test_id, p.n, p.section, p.aops_topic_id AS aops_id, p.statement,
                   COALESCE(p.wiki_choices, p.aops_choices) AS choices, p.answer_index, p.answer_value, p.acgn, p.tags,
                   p.is_computational,
                   p.coverage_response_kind, t.response_kind AS test_response_kind,
                   p.coverage_answer_status, t.answer_status AS test_answer_status,
                   p.difficulty, p.quality, p.verified, p.notes
            FROM problems p
            -- LEFT so a problem with a dangling test_id still builds, exactly as
            -- it did before resolution needed the parent row.
            LEFT JOIN tests t ON t.id = p.test_id
            ORDER BY p.test_id, p.section, p.n
        `,
            )
            .all();

        const solStmt = db.query(
            `SELECT content FROM solutions
             WHERE problem_id = ?
               AND status = 'accepted'
               AND duplicate_of_solution_id IS NULL
             ORDER BY selected_rank IS NULL,
                      selected_rank,
                      is_official DESC,
                      quality_score DESC,
                      id`,
        );

        // Pass 1: compute each problem's derived content bundle + placement, keyed
        // by problem id, so an alias can borrow its canonical's bundle in pass 2.
        const contentById = new Map();
        const placeById = new Map();
        for (const r of rows) {
            const sols = solStmt.all(r.id).map((x) => x.content);
            const hasSourceChoices = r.choices != null;
            const hasAnswerValue = r.answer_value != null;
            const productionChoices = hasSourceChoices
                ? r.choices
                : hasAnswerValue
                  ? [r.answer_value]
                  : [];
            const productionAnswerIndex = hasSourceChoices
                ? r.answer_index
                : hasAnswerValue
                  ? 0
                  : -1;
            const coverage = resolveCoverage({
                overrideResponseKind: r.coverage_response_kind,
                declarationResponseKind: r.test_response_kind,
                overrideAnswerStatus: r.coverage_answer_status,
                declarationAnswerStatus: r.test_answer_status,
                hasAnswer: productionAnswerIndex >= 0,
                rawIsComputational: r.is_computational,
            });
            if (
                coverage.answerStatus === "not_applicable" &&
                productionAnswerIndex >= 0
            ) {
                throw new Error(
                    `Coverage invariant failed for problem_id=${r.id}: ` +
                        "answer_status='not_applicable' requires answer_index=-1",
                );
            }
            if (
                coverage.answerStatus === "known" &&
                productionAnswerIndex < 0
            ) {
                throw new Error(
                    `Coverage invariant failed for problem_id=${r.id}: ` +
                        "answer_status='known' requires a usable answer",
                );
            }
            contentById.set(r.id, {
                statement: r.statement,
                choices: toPostgresTextArray(productionChoices),
                answer_index: productionAnswerIndex,
                official_solutions: sols.length ? JSON.stringify(sols) : null,
                topic: r.acgn,
                tags: toPostgresTextArray(r.tags),
                is_computational: coverage.isComputational,
                response_kind: coverage.responseKind,
                answer_status: coverage.answerStatus,
                difficulty: r.difficulty,
                quality: r.quality,
                verified: r.verified,
                notes: r.notes,
            });
            placeById.set(r.id, { test_id: r.test_id, n: r.n });
        }

        const insert = db.query(`
            INSERT INTO production_problems (
                test_id, n, canonical_test_id, canonical_n, aops_id,
                statement, choices, answer_index, official_solutions,
                topic, tags, is_computational, response_kind, answer_status,
                difficulty, quality, verified, notes
            ) VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?)
        `);

        // Pass 2: resolve canonical, propagate its content to aliases, insert.
        for (const r of rows) {
            const canonicalId = resolveCanonicalId(db, r.id);
            const isAlias =
                canonicalId !== r.id && contentById.has(canonicalId);
            const bundle = isAlias
                ? contentById.get(canonicalId)
                : contentById.get(r.id);
            const canonicalPlace = isAlias ? placeById.get(canonicalId) : null;
            insert.run(
                r.test_id,
                r.n,
                canonicalPlace ? canonicalPlace.test_id : null,
                canonicalPlace ? canonicalPlace.n : null,
                r.aops_id,
                bundle.statement,
                bundle.choices,
                bundle.answer_index,
                bundle.official_solutions,
                bundle.topic,
                bundle.tags,
                bundle.is_computational,
                bundle.response_kind,
                bundle.answer_status,
                bundle.difficulty,
                bundle.quality,
                bundle.verified,
                bundle.notes,
            );
            count++;
        }
    })();
    return count;
}
