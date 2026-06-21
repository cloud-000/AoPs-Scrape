import { Database } from "bun:sqlite";
import { CleanupText } from "./CleanupText.js";
import { getAutoTags } from "./autoTags.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  is_official INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id        INTEGER REFERENCES series(id),
  name             TEXT NOT NULL,
  year             INTEGER,
  aops_category_id TEXT UNIQUE,
  type             TEXT,
  is_computational INTEGER DEFAULT 0,
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
  is_computational INTEGER DEFAULT 0,
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  verified         INTEGER DEFAULT 0,
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
  aops_post_id    INTEGER UNIQUE,
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
`;

export function initDB(dbPath) {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);

    // Migration: add new columns if they don't exist
    const existingCols = db.query("PRAGMA table_info(problems)").all().map(r => r.name);
    if (existingCols.includes('aops_answers') && !existingCols.includes('aops_choices')) {
        db.exec(`ALTER TABLE problems ADD COLUMN aops_choices TEXT`);
        db.exec(`ALTER TABLE problems ADD COLUMN aops_answer TEXT`);
        // migrate data: aops_choices = aops_answers (best effort)
        db.exec(`UPDATE problems SET aops_choices = aops_answers WHERE aops_answers IS NOT NULL AND aops_answers != '[]'`);
        db.exec(`ALTER TABLE problems DROP COLUMN aops_answers`);
    }
    if (!existingCols.includes('tags')) {
        db.exec(`ALTER TABLE problems ADD COLUMN tags TEXT`);
    }

    return db;
}

function upsertSeries(db, name, isOfficial = false) {
    db.run(`INSERT INTO series (name, is_official) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET
        is_official = MAX(series.is_official, excluded.is_official)
    `, [name, isOfficial ? 1 : 0]);
    return db.query(`SELECT id FROM series WHERE name = ?`).get(name).id;
}

function upsertTest(db, { aopsCategoryId, name, year, type, isComputational }, seriesId) {
    db.run(`
        INSERT INTO tests (series_id, name, year, aops_category_id, type, is_computational)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (aops_category_id) DO UPDATE SET
            name             = excluded.name,
            year             = excluded.year,
            type             = excluded.type,
            is_computational = excluded.is_computational,
            series_id        = excluded.series_id
    `, [seriesId, name, year ?? null, aopsCategoryId, type ?? null, isComputational ? 1 : 0]);
    return db.query(`SELECT id FROM tests WHERE aops_category_id = ?`).get(aopsCategoryId).id;
}

function upsertSolutions(db, problemId, solutions, allPosts, isOly) {
    for (const sol of (solutions ?? [])) {
        db.run(`
            INSERT INTO solutions (problem_id, source, aops_topic_id, aops_post_id, aops_user_id, aops_username, content, posted_at)
            VALUES (?, 'aops', ?, ?, ?, ?, ?, ?)
            ON CONFLICT (aops_post_id) DO UPDATE SET
                is_official = MAX(solutions.is_official, excluded.is_official),
                content = excluded.content
        `, [problemId, sol.topic_id ?? null, sol.post_id, sol.user_id ?? null, sol.username ?? null, sol.content, sol.posted_at ?? null]);
    }

    if (isOly && allPosts && allPosts.length > 0) {
        db.run(`
            INSERT INTO oly_potential_solutions (problem_id, posts)
            VALUES (?, ?)
            ON CONFLICT (problem_id) DO UPDATE SET
                posts = excluded.posts,
                scraped_at = datetime('now')
        `, [problemId, JSON.stringify(allPosts)]);
    }
}

function upsertProblem(db, problem, testId) {
    // New column split: choices vs raw answer
    const aopsChoices = problem.choices != null ? JSON.stringify(problem.choices) : null;
    const aopsAnswer = problem.raw_answer ?? null;
    const aopsAnswerIndex = problem.answer ?? -1;
    const section = problem.section ?? -1;
    const topic = CleanupText.inferACGN(problem.statement);
    const autoTagsList = getAutoTags(problem.statement);
    const tagsJson = autoTagsList.length > 0 ? JSON.stringify(autoTagsList) : null;

    // For `answers` column: MCQ → choices texts; AIME/COMP → singleton with raw answer
    const aopsAnswersForDisplay = aopsChoices ?? (aopsAnswer != null ? JSON.stringify([aopsAnswer]) : null);

    // Check for statement change BEFORE the upsert so we can log the old value
    const existing = db.query(`
        SELECT id, aops_statement FROM problems WHERE test_id = ? AND n = ? AND section = ?
    `).get(testId, problem.n, section);

    if (existing && existing.aops_statement && existing.aops_statement !== problem.statement) {
        db.run(`
            INSERT INTO problem_history (problem_id, old_statement, new_statement)
            VALUES (?, ?, ?)
        `, [existing.id, existing.aops_statement, problem.statement]);
    }

    db.run(`
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
    `, [
        testId, problem.n, section,
        problem.topic_id ?? null, problem.post_id ?? null,
        problem.statement, aopsAnswerIndex, aopsChoices, aopsAnswer,
        problem.statement, aopsAnswerIndex, aopsAnswersForDisplay,
        topic, tagsJson, problem.is_computational ? 1 : 0,
    ]);

    // Upsert solutions / potential solutions if present
    const row = db.query(`SELECT id FROM problems WHERE test_id = ? AND n = ? AND section = ?`).get(testId, problem.n, section);
    if (row && (problem.solutions?.length || problem.all_posts?.length)) {
        const isOly = problem.is_computational === false;
        upsertSolutions(db, row.id, problem.solutions, problem.all_posts, isOly);
    }
}

// Recursively flattens raw scrape output into [{seriesName, test}] pairs.
// Handles: series ({name, tests}), single test ({id, problems}), or arrays of either.
function collectTestPairs(raw, parentSeriesName) {
    if (Array.isArray(raw)) {
        return raw.flatMap(item => collectTestPairs(item, parentSeriesName));
    }
    if (raw.tests) {
        return raw.tests.flatMap(item => collectTestPairs(item, raw.name));
    }
    return [{ seriesName: parentSeriesName ?? raw.name, test: raw }];
}

export function upsertScrapeResults(db, raw) {
    const pairs = collectTestPairs(raw, null);

    db.transaction(() => {
        const seriesCache = new Map();

        for (const { seriesName, test } of pairs) {
            if (!seriesCache.has(seriesName)) {
                seriesCache.set(seriesName, upsertSeries(db, seriesName, raw.is_official ?? false));
            }
            const seriesId = seriesCache.get(seriesName);

            const testId = upsertTest(db, {
                aopsCategoryId: test.id.toString(),
                name: test.name,
                year: test.year ?? null,
                type: test.type ?? null,
                isComputational: test.computational ?? false,
            }, seriesId);

            // Sectioned tests have problems as a 2D array; problems already carry .section
            const problems = test.sections.length > 0
                ? test.problems.flat()
                : test.problems;

            for (const problem of problems) {
                upsertProblem(db, { ...problem, is_computational: test.computational ?? false }, testId);
            }
        }
    })();
}
