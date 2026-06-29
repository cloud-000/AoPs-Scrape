import { Database } from "bun:sqlite";
import { CleanupText } from "./CleanupText.js";
import { getAutoTags } from "./autoTags.js";

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
  year             INTEGER,
  aops_category_id TEXT UNIQUE,
  type             TEXT,
  is_computational BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_computational IN (0, 1)),
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  aops_url TEXT GENERATED ALWAYS AS ('https://artofproblemsolving.com/community/c' || aops_category_id) STORED
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

  pdf_statement TEXT,
  pdf_answer    TEXT,
  pdf_solutions TEXT,
  pdf_source    TEXT,

  statement    TEXT,
  answer_index INTEGER DEFAULT -1,
  answers      TEXT,

  topic            TEXT,
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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id      INTEGER NOT NULL REFERENCES problems(id),
  source          TEXT NOT NULL DEFAULT 'aops',
  aops_topic_id   INTEGER,
  aops_post_id    INTEGER,
  aops_user_id    INTEGER,
  aops_username   TEXT,
  content         TEXT NOT NULL,
  posted_at       TEXT,
  is_official     INTEGER DEFAULT 0,
  quality         INTEGER DEFAULT 0,
  verified        INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- Dedup real AoPS solutions by post id; -1 (not on AoPS) rows are excluded
-- so multiple sentinel rows can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_solutions_aops_post_id
  ON solutions (aops_post_id) WHERE aops_post_id >= 0;

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
  choices            TEXT[],   -- TEXT[] array (custom type); NULL if not MCQ
  answer_index       INTEGER DEFAULT -1,  -- 0-based index into choices; -1 = unknown
  official_solutions TEXT,    -- JSON array of official solution content strings; NULL if none

  -- metadata (carried over from problems)
  topic              TEXT,
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

    // Migration: production_problems was redesigned/extended or schema changed. It holds only
    // derived data, so drop the stale shape and let SCHEMA recreate the new one.
    const prodTableInfo = db.query("PRAGMA table_info(production_problems)").all();
    const prodCols = prodTableInfo.map((r) => r.name);
    const choicesCol = prodTableInfo.find((r) => r.name === "choices");
    const tagsCol = prodTableInfo.find((r) => r.name === "tags");

    const needsRecreate = prodCols.length > 0 && (
        !prodCols.includes("test_id") ||
        !prodCols.includes("aops_id") ||
        prodCols.includes("section") ||
        (choicesCol && choicesCol.type !== "TEXT[]") ||
        (tagsCol && tagsCol.type !== "TEXT[]")
    );

    if (needsRecreate) {
        db.exec(`DROP TABLE production_problems`);
        db.exec(SCHEMA);
    }

    return db;
}

function upsertSeries(db, name, aopsId = -1, isOfficial = false) {
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

// Resolves an existing test id. Prefers the AoPS category id (stable when
// present); otherwise falls back to the natural key (series_id, year, name) so
// non-AoPS sources (e.g. Mandelbrot) dedup, and a PDF-first test can later be
// linked to its AoPS category. Returns null if no match.
function resolveTestId(db, { aopsCategoryId, seriesId, year, name }) {
    if (aopsCategoryId != null) {
        const byAops = db
            .query(`SELECT id FROM tests WHERE aops_category_id = ?`)
            .get(aopsCategoryId);
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

function upsertTest(
    db,
    { aopsCategoryId, name, year, type, isComputational },
    seriesId,
) {
    const existingId = resolveTestId(db, {
        aopsCategoryId,
        seriesId,
        year,
        name,
    });

    if (existingId != null) {
        db.run(
            `
            UPDATE tests SET
                name             = ?,
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
        INSERT INTO tests (series_id, name, year, aops_category_id, type, is_computational)
        VALUES (?, ?, ?, ?, ?, ?)
    `,
        [
            seriesId,
            name,
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
        db.run(
            `
            INSERT INTO solutions (problem_id, source, aops_topic_id, aops_post_id, aops_user_id, aops_username, content, posted_at)
            VALUES (?, 'aops', ?, ?, ?, ?, ?, ?)
            ON CONFLICT (aops_post_id) WHERE aops_post_id >= 0 DO UPDATE SET
                is_official = MAX(solutions.is_official, excluded.is_official),
                content = excluded.content
        `,
            [
                problemId,
                sol.topic_id ?? null,
                sol.post_id ?? null,
                sol.user_id ?? null,
                sol.username ?? null,
                sol.content,
                sol.posted_at ?? null,
            ],
        );
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
    // New column split: choices vs raw answer
    const aopsChoices =
        problem.choices != null ? JSON.stringify(problem.choices) : null;
    const aopsAnswer = problem.raw_answer ?? null;
    const aopsAnswerIndex = problem.answer ?? -1;
    const section = problem.section ?? -1;
    const topic = CleanupText.inferACGN(problem.statement);
    const autoTagsList = getAutoTags(problem.statement);
    const tagsJson =
        autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    // For `answers` column: MCQ → choices texts; AIME/COMP → singleton with raw answer
    const aopsAnswersForDisplay =
        aopsChoices ??
        (aopsAnswer != null ? JSON.stringify([aopsAnswer]) : null);

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
            statement, answer_index, answers,
            topic, tags, is_computational
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            aops_topic_id     = excluded.aops_topic_id,
            aops_post_id      = excluded.aops_post_id,
            aops_statement    = excluded.aops_statement,
            aops_answer_index = excluded.aops_answer_index,
            aops_choices      = excluded.aops_choices,
            aops_answer       = excluded.aops_answer,
            statement    = COALESCE(problems.pdf_statement, excluded.aops_statement),
            answers      = CASE
                WHEN problems.pdf_answer IS NOT NULL THEN json_array(problems.pdf_answer)
                ELSE excluded.answers
            END,
            answer_index = CASE
                WHEN problems.verified THEN problems.answer_index
                WHEN problems.pdf_answer IS NOT NULL THEN problems.answer_index
                ELSE excluded.aops_answer_index
            END,
            -- Scraper-immutable: topic never overwritten after INSERT
            topic = problems.topic,
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
            problem.topic_id ?? null,
            problem.post_id ?? null,
            problem.statement,
            aopsAnswerIndex,
            aopsChoices,
            aopsAnswer,
            problem.statement,
            aopsAnswerIndex,
            aopsAnswersForDisplay,
            topic,
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
    if (row && (problem.solutions?.length || problem.all_posts?.length)) {
        const isOly = problem.is_computational === false;
        upsertSolutions(
            db,
            row.id,
            problem.solutions,
            problem.all_posts,
            isOly,
        );
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

            const testId = upsertTest(
                db,
                {
                    aopsCategoryId: test.id != null ? test.id.toString() : null,
                    name: test.name,
                    year: test.year ?? null,
                    type: test.type ?? null,
                    isComputational: test.computational ?? false,
                },
                seriesId,
            );

            // Sectioned tests have problems as a 2D array; problems already carry .section
            const problems =
                test.sections.length > 0 ? test.problems.flat() : test.problems;

            for (const problem of problems) {
                upsertProblem(
                    db,
                    {
                        ...problem,
                        is_computational: test.computational ?? false,
                    },
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
                   p.aops_choices AS choices, p.answer_index, p.topic, p.tags,
                   p.is_computational, p.difficulty, p.quality, p.verified, p.notes
            FROM problems p
            ORDER BY p.test_id, p.section, p.n
        `,
            )
            .all();

        const solStmt = db.query(
            `SELECT content FROM solutions
             WHERE problem_id = ? AND is_official = 1 ORDER BY id`,
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
            insert.run(
                r.test_id,
                r.n,
                r.aops_id,
                r.statement,
                toPostgresTextArray(r.choices),
                r.answer_index,
                officialSolutions,
                r.topic,
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
