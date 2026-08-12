import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDB } from "../src/db.js";
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
