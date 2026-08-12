import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDB, upsertSolutionCandidate } from "../src/db.js";
import { runPreprocess } from "../src/preprocess.js";

const temporaryPaths = [];

afterEach(() => {
    for (const path of temporaryPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("choice preprocessing", () => {
    test("repairs visual-only MCQs without removing their image", async () => {
        const directory = mkdtempSync(join(tmpdir(), "aops-preprocess-test-"));
        temporaryPaths.push(directory);
        const db = initDB(join(directory, "fixture.sqlite"));
        db.run("INSERT INTO series (name) VALUES ('Fixture Series')");
        db.run(`
            INSERT INTO tests (
                series_id, name, year, aops_category_id,
                is_computational, response_kind
            ) VALUES (1, '2026 Fixture', 2026, 'fixture-test', 1, 'mcq')
        `);
        const statement =
            "Which histogram displays the data? [img]choices.png[/img]";
        db.run(
            `INSERT INTO problems (
                test_id, n, aops_statement, aops_choices,
                aops_answer_index, aops_answer,
                statement, answer_index, answer_value, is_computational
             ) VALUES (1, 0, ?, '[]', -1, 'E', ?, -1, 'E', 1)`,
            [statement, statement],
        );

        await runPreprocess(db);
        const repaired = db
            .query(
                `SELECT aops_statement, aops_choices, aops_answer_index,
                        statement, answer_index
                   FROM problems WHERE id = 1`,
            )
            .get();

        expect(JSON.parse(repaired.aops_choices)).toEqual([
            "A",
            "B",
            "C",
            "D",
            "E",
        ]);
        expect(repaired.aops_answer_index).toBe(4);
        expect(repaired.answer_index).toBe(4);
        expect(repaired.aops_statement).toBe(statement);
        expect(repaired.statement).toBe(statement);

        await runPreprocess(db);
        expect(
            db.query(
                "SELECT aops_statement, aops_choices, aops_answer_index FROM problems WHERE id = 1",
            ).get(),
        ).toEqual({
            aops_statement: statement,
            aops_choices: JSON.stringify(["A", "B", "C", "D", "E"]),
            aops_answer_index: 4,
        });
        db.close();
    });
});

describe("solution text preprocessing", () => {
    test("strips certain forum residue, keeps the raw source, and stays idempotent", async () => {
        const directory = mkdtempSync(join(tmpdir(), "aops-preprocess-solution-"));
        temporaryPaths.push(directory);
        const db = initDB(join(directory, "fixture.sqlite"));
        db.run("INSERT INTO series (name) VALUES ('Fixture Series')");
        db.run(
            `INSERT INTO tests (series_id, name, year, aops_category_id, is_computational)
             VALUES (1, '2026 Fixture', 2026, 'fixture-test', 1)`,
        );
        db.run(
            `INSERT INTO problems (test_id, n, aops_statement, statement, is_computational)
             VALUES (1, 0, 'Find x.', 'Find x.', 1)`,
        );

        const raw = '[hide="Solution"]Since $x+1=8$, $x=\\boxed{7}$.[/hide]\nEdited by bob';
        // Written straight to the table so the row looks like one collected
        // before the normalizer existed.
        db.run(
            `INSERT INTO solutions (problem_id, content, normalized_hash) VALUES (1, ?, 'stale')`,
            [raw],
        );
        db.run(
            `INSERT INTO solution_sources (solution_id, problem_id, source, source_key, raw_content)
             VALUES (1, 1, 'aops', 'post:20', ?)`,
            [raw],
        );
        db.run(
            `INSERT INTO solutions (problem_id, content, normalized_hash, status_source)
             VALUES (1, ?, 'manual-hash', 'manual')`,
            [raw],
        );

        await runPreprocess(db);
        const auto = db.query("SELECT * FROM solutions WHERE id = 1").get();
        const manual = db.query("SELECT content FROM solutions WHERE id = 2").get();
        const source = db.query("SELECT raw_content FROM solution_sources WHERE id = 1").get();

        expect(auto.content).toBe("Since $x+1=8$, $x=\\boxed{7}$.");
        expect(auto.normalized_hash).not.toBe("stale");
        // The documentary source and any manual decision are untouched.
        expect(source.raw_content).toBe(raw);
        expect(manual.content).toBe(raw);

        await runPreprocess(db);
        expect(db.query("SELECT content FROM solutions WHERE id = 1").get().content).toBe(
            "Since $x+1=8$, $x=\\boxed{7}$.",
        );
        db.close();
    });

    test("ingest normalizes canonical content so a re-scrape reuses the same row", () => {
        const directory = mkdtempSync(join(tmpdir(), "aops-preprocess-ingest-"));
        temporaryPaths.push(directory);
        const db = initDB(join(directory, "fixture.sqlite"));
        db.run("INSERT INTO series (name) VALUES ('Fixture Series')");
        db.run(
            `INSERT INTO tests (series_id, name, year, aops_category_id, is_computational)
             VALUES (1, '2026 Fixture', 2026, 'fixture-test', 1)`,
        );
        db.run(
            `INSERT INTO problems (test_id, n, aops_statement, statement, is_computational)
             VALUES (1, 0, 'Find x.', 'Find x.', 1)`,
        );

        const post = '[hide="Solution"]Since $x+1=8$, $x=\\boxed{7}$.[/hide]\n\n\n\nThanks!';
        const candidate = {
            problemId: 1,
            source: "aops",
            sourceKey: "post:20",
            content: post,
            raw_content: post,
            aops_post_id: 20,
        };
        const first = upsertSolutionCandidate(db, candidate);
        const second = upsertSolutionCandidate(db, candidate);

        expect(second).toBe(first);
        expect(db.query("SELECT count(*) AS n FROM solutions").get().n).toBe(1);
        // The greeting is ambiguous and survives for review; the hide wrapper does not.
        expect(db.query("SELECT content FROM solutions WHERE id = ?").get(first).content).toBe(
            "Since $x+1=8$, $x=\\boxed{7}$.\n\nThanks!",
        );
        expect(db.query("SELECT raw_content FROM solution_sources").get().raw_content).toBe(post);
        db.close();
    });
});
