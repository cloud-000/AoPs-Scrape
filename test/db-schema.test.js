import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDB } from "../src/db.js";

const temporaryPaths = [];

afterEach(() => {
    for (const path of temporaryPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

test("fresh schema creates the normalized solution table and its indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "aops-schema-test-"));
    temporaryPaths.push(directory);
    const db = initDB(join(directory, "test.sqlite"));

    const columns = db
        .query(`PRAGMA table_info(solutions)`)
        .all()
        .map((row) => row.name);
    const indexes = new Set(
        db.query(`PRAGMA index_list(solutions)`).all().map((row) => row.name),
    );

    expect(columns).toContain("normalized_hash");
    expect(indexes).toContain("idx_solutions_problem_status");
    expect(indexes).toContain("idx_solutions_duplicate_of");

    db.close();
});
