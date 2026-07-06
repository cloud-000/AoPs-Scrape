import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CleanupText } from "./CleanupText.js";
import { getAutoTags } from "./autoTags.js";
import { SOLUTIONS_USERS } from "../contest_id.js";

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
  -- Not standalone-unique: sibling section tests share the AoPS category id and
  -- are disambiguated by section.
  aops_category_id TEXT,
  type             TEXT,
  is_computational BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
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

-- Clean, standalone export table. Purely derived from problems + solutions via
-- buildProductionProblems(); rebuilt on demand, holds no manual state of its own.
-- No aops_*/pdf_* source columns. Array-typed columns (Postgres text[]) are
-- stored here as TEXT[] arrays (custom type).
CREATE TABLE IF NOT EXISTS production_problems (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- relational link back to the source test
  test_id            INTEGER REFERENCES tests(id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,        -- problem number within the test
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
  difficulty         INTEGER DEFAULT 0,
  quality            INTEGER DEFAULT 0,
  verified           BOOLEAN NOT NULL DEFAULT FALSE CHECK (verified IN (0, 1)),
  notes              TEXT,

  built_at           TEXT DEFAULT (datetime('now')),

  UNIQUE(test_id, n)
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

function getSolutionSourceSummary(db, solutionId) {
    const rows = db
        .query(
            `SELECT source, is_official_hint, reliability_hint, aops_user_id, posted_at
             FROM solution_sources
             WHERE solution_id = ?`,
        )
        .all(solutionId);
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

function tokenSimilarity(a, b) {
    const left = tokenSet(a);
    const right = tokenSet(b);
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
            const summary = getSolutionSourceSummary(db, row.id);
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

        const problemIds = db
            .query(`SELECT DISTINCT problem_id FROM solutions ORDER BY problem_id`)
            .all()
            .map((r) => r.problem_id);

        const markDuplicateStmt = db.prepare(
            `UPDATE solutions SET
                status = 'duplicate',
                duplicate_of_solution_id = ?,
                updated_at = datetime('now')
             WHERE id = ? AND status_source != 'manual'`,
        );

        for (const problemId of problemIds) {
            const candidates = db
                .query(
                    `SELECT s.*
                     FROM solutions s
                     WHERE s.problem_id = ?
                       AND s.status IN ('accepted', 'needs_review', 'candidate')
                       AND s.duplicate_of_solution_id IS NULL
                     ORDER BY s.id`,
                )
                .all(problemId)
                .map((row) => {
                    const summary = getSolutionSourceSummary(db, row.id);
                    return {
                        ...row,
                        best_source_priority: summary.bestSourcePriority,
                        has_known_solution_user: summary.hasKnownSolutionUser,
                        earliest_posted_at: summary.earliestPostedAt,
                    };
                });

            const consumed = new Set();
            for (let i = 0; i < candidates.length; i++) {
                if (consumed.has(candidates[i].id)) continue;
                const group = [candidates[i]];
                for (let j = i + 1; j < candidates.length; j++) {
                    if (consumed.has(candidates[j].id)) continue;
                    if (
                        tokenSimilarity(candidates[i].content, candidates[j].content) >=
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

function migrateSolutionsSchema(db) {
    const solutionCols = db
        .query("PRAGMA table_info(solutions)")
        .all()
        .map((r) => r.name);
    if (solutionCols.includes("normalized_hash")) return;

    const oldRows = db.query(`SELECT * FROM solutions ORDER BY id`).all();
    db.transaction(() => {
        db.exec(`PRAGMA foreign_keys = OFF;`);
        db.exec(`ALTER TABLE solutions RENAME TO solutions_old;`);
        db.exec(`DROP INDEX IF EXISTS idx_solutions_aops_post_id;`);
        db.exec(SCHEMA);
        for (const row of oldRows) {
            const source = row.source ?? "aops";
            const isOfficial = row.is_official ? 1 : 0;
            const isVerified = row.verified ? 1 : 0;
            upsertSolutionCandidate(db, {
                problemId: row.problem_id,
                source,
                sourceKey:
                    row.aops_post_id != null
                        ? `post:${row.aops_post_id}`
                        : `${source}:legacy:${row.id}`,
                content: row.content,
                raw_content: row.content,
                aops_topic_id: row.aops_topic_id,
                aops_post_id: row.aops_post_id,
                aops_user_id: row.aops_user_id,
                aops_username: row.aops_username,
                posted_at: row.posted_at,
                is_official: isOfficial,
                reliability_hint: isOfficial ? 90 : 0,
                quality_score: Math.max(0, Math.min(100, row.quality ?? 0)),
                status: isVerified || isOfficial ? "accepted" : "candidate",
                status_source: isVerified ? "manual" : "auto",
            });
        }
        db.exec(`DROP TABLE solutions_old;`);
        db.exec(`PRAGMA foreign_keys = ON;`);
    })();
}

function ensureSolutionIndexes(db) {
    const solutionCols = db
        .query("PRAGMA table_info(solutions)")
        .all()
        .map((r) => r.name);
    if (!solutionCols.includes("status")) return;
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_solutions_problem_status
  ON solutions (problem_id, status, duplicate_of_solution_id);
CREATE INDEX IF NOT EXISTS idx_solutions_duplicate_of
  ON solutions (duplicate_of_solution_id);
    `);
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

    // Migration: production_problems was redesigned/extended or schema changed. It holds only
    // derived data, so drop the stale shape and let SCHEMA recreate the new one.
    const prodTableInfo = db.query("PRAGMA table_info(production_problems)").all();
    const prodCols = prodTableInfo.map((r) => r.name);
    const choicesCol = prodTableInfo.find((r) => r.name === "choices");
    const tagsCol = prodTableInfo.find((r) => r.name === "tags");

    const needsRecreate = prodCols.length > 0 && (
        !prodCols.includes("test_id") ||
        !prodCols.includes("aops_id") ||
        prodCols.includes("answer_value") ||
        prodCols.includes("acgn") ||
        !prodCols.includes("topic") ||
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

    migrateSolutionsSchema(db);
    ensureSolutionIndexes(db);

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

// `updateSection` controls whether an UPDATE (merge onto an existing row) may
// rewrite section/section_name. The scraper owns a test's section structure, so
// it passes true; non-scrape sources (PDF import) pass false so they never
// disturb the section metadata of a row the scraper created — e.g. a PDF
// "High School" test merging by name onto a genuinely two-section AoPS year must
// not flatten a sibling section to -1 and collide on UNIQUE(aops_category_id,
// section). A brand-new row still takes the caller's section on INSERT.
export function upsertTest(
    db,
    { aopsCategoryId, name, section = -1, sectionName = null, year, type, isComputational, updateSection = true },
    seriesId,
) {
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
                type             = ?,
                is_computational = ?,
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
                type ?? null,
                isComputational ? 1 : 0,
                seriesId,
                aopsCategoryId ?? null,
                existingId,
            ],
        );
        return existingId;
    }

    db.run(
        `
        INSERT INTO tests (series_id, name, section, section_name, year, aops_category_id, type, is_computational)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
        [
            seriesId,
            name,
            section,
            sectionName ?? null,
            year ?? null,
            aopsCategoryId ?? null,
            type ?? null,
            isComputational ? 1 : 0,
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

function upsertProblem(db, problem, testId) {
    const aopsChoices =
        problem.choices != null ? JSON.stringify(problem.choices) : null;
    const aopsAnswer = problem.answerValue ?? null; // literal answer (letter or number)
    const aopsAnswerIndex = problem.answerIndex ?? -1; // index into choices for MCQ
    const section = problem.section ?? -1;
    const acgn = CleanupText.inferACGN(problem.statement);
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
export function upsertPdfProblem(db, problem, testId) {
    const section = -1; // section lives on the test row; problems always -1
    const statement = problem.statement;
    const answer = problem.answer ?? null;
    const source = problem.source ?? null;
    const acgn = CleanupText.inferACGN(statement);
    const autoTagsList = getAutoTags(statement);
    const tagsJson =
        autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    db.run(
        `
        INSERT INTO problems (
            test_id, n, section,
            pdf_statement, pdf_answer, pdf_source,
            statement, answer_index, answer_value,
            acgn, tags, is_computational
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            pdf_statement = excluded.pdf_statement,
            -- A missing OCR answer must not wipe an existing one.
            pdf_answer    = COALESCE(excluded.pdf_answer, problems.pdf_answer),
            pdf_source    = excluded.pdf_source,
            -- Resolved values, trust order verified > pdf > wiki > aops. pdf tier
            -- from excluded.*, wiki/aops from problems.*.
            statement    = COALESCE(excluded.pdf_statement, problems.wiki_statement, problems.aops_statement),
            answer_value = CASE
                WHEN problems.verified THEN problems.answer_value
                ELSE COALESCE(excluded.pdf_answer, problems.pdf_answer, problems.wiki_answer, problems.aops_answer)
            END,
            -- pdf carries no choice index; the resolved index rides on whichever
            -- choices win (wiki > aops), keeping it order-independent.
            answer_index = CASE
                WHEN problems.verified THEN problems.answer_index
                WHEN problems.wiki_choices IS NOT NULL THEN problems.wiki_answer_index
                ELSE problems.aops_answer_index
            END,
            updated_at = datetime('now')
    `,
        [
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
        ],
    );
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
    const acgn = CleanupText.inferACGN(statement);
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
            const sectioned = (test.sections?.length ?? 0) > 0;
            const units = sectioned
                ? test.sections.map((sectionName, i) => ({
                      name: `${test.name} ${sectionName}`,
                      section: i,
                      sectionName,
                      problems: test.problems[i] ?? [],
                  }))
                : [
                      {
                          name: test.name,
                          section: -1,
                          sectionName: null,
                          problems: test.problems,
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
            }
        }
    })();
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

// Rebuilds the denormalized production_problems table from the curated problems
// + solutions data. The table is purely derived, so we wipe and rebuild it in a
// single transaction (no stale rows, no dedup logic). Returns the row count.
export function buildProductionProblems(db) {
    let count = 0;
    db.transaction(() => {
        db.run(`DELETE FROM production_problems`);

        // To restrict production to vetted rows, add a WHERE here
        // (e.g. `WHERE p.verified = 1` or `WHERE p.statement IS NOT NULL`).
        const rows = db
            .query(
                `
            SELECT p.id, p.test_id, p.n, p.section, p.aops_topic_id AS aops_id, p.statement,
                   COALESCE(p.wiki_choices, p.aops_choices) AS choices, p.answer_index, p.answer_value, p.acgn, p.tags,
                   p.is_computational, p.difficulty, p.quality, p.verified, p.notes
            FROM problems p
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
        const insert = db.query(`
            INSERT INTO production_problems (
                test_id, n, aops_id,
                statement, choices, answer_index, official_solutions,
                topic, tags, is_computational, difficulty, quality, verified, notes
            ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?,?,?,?)
        `);

        for (const r of rows) {
            const sols = solStmt.all(r.id).map((x) => x.content);
            const officialSolutions = sols.length ? JSON.stringify(sols) : null;
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
            insert.run(
                r.test_id,
                r.n,
                r.aops_id,
                r.statement,
                toPostgresTextArray(productionChoices),
                productionAnswerIndex,
                officialSolutions,
                r.acgn,
                toPostgresTextArray(r.tags),
                r.is_computational,
                r.difficulty,
                r.quality,
                r.verified,
                r.notes,
            );
            count++;
        }
    })();
    return count;
}
