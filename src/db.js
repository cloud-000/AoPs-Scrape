import { Database } from "bun:sqlite";
import { CleanupText } from "./CleanupText.js";

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
  quality          INTEGER DEFAULT 0
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
  aops_answers     TEXT,

  pdf_statement TEXT,
  pdf_answer    TEXT,
  pdf_solutions TEXT,
  pdf_source    TEXT,

  statement    TEXT,
  answer_index INTEGER DEFAULT -1,
  answers      TEXT,

  topic            TEXT,
  is_computational INTEGER DEFAULT 0,
  difficulty       INTEGER DEFAULT 0,
  quality          INTEGER DEFAULT 0,
  verified         INTEGER DEFAULT 0,
  notes            TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(test_id, n, section)
);
CREATE INDEX IF NOT EXISTS idx_problems_aops_topic ON problems(aops_topic_id);
`;

export function initDB(dbPath) {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return db;
}

function upsertSeries(db, name) {
    db.run(`INSERT INTO series (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [name]);
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
            series_id        = COALESCE(tests.series_id, excluded.series_id)
    `, [seriesId, name, year ?? null, aopsCategoryId, type ?? null, isComputational ? 1 : 0]);
    return db.query(`SELECT id FROM tests WHERE aops_category_id = ?`).get(aopsCategoryId).id;
}

function upsertProblem(db, problem, testId) {
    const aopsAnswers = JSON.stringify(problem.choices ?? []);
    const aopsAnswerIndex = problem.answer ?? -1;
    const section = problem.section ?? -1;
    const topic = CleanupText.inferACGN(problem.statement);

    db.run(`
        INSERT INTO problems (
            test_id, n, section, aops_topic_id, aops_post_id,
            aops_statement, aops_answer_index, aops_answers,
            statement, answer_index, answers,
            topic, is_computational
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (test_id, n, section) DO UPDATE SET
            aops_topic_id     = excluded.aops_topic_id,
            aops_post_id      = excluded.aops_post_id,
            aops_statement    = excluded.aops_statement,
            aops_answer_index = excluded.aops_answer_index,
            aops_answers      = excluded.aops_answers,
            statement    = COALESCE(problems.pdf_statement, excluded.aops_statement),
            answers      = CASE WHEN problems.pdf_answer IS NOT NULL
                                THEN json_array(problems.pdf_answer)
                                ELSE excluded.aops_answers END,
            answer_index = excluded.aops_answer_index,
            topic        = excluded.topic,
            updated_at   = datetime('now')
    `, [
        testId, problem.n, section,
        problem.topic_id ?? null, problem.post_id ?? null,
        problem.statement, aopsAnswerIndex, aopsAnswers,
        problem.statement, aopsAnswerIndex, aopsAnswers,
        topic, problem.is_computational ? 1 : 0,
    ]);
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
                seriesCache.set(seriesName, upsertSeries(db, seriesName));
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
