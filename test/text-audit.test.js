import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDB } from "../src/db.js";
import {
    auditDatabase,
    auditDatabaseFile,
    auditFindingsCsv,
    auditText,
    writeAuditReports,
} from "../src/textAudit.js";

const temporaryPaths = [];

function temporaryDirectory() {
    const path = mkdtempSync(join(tmpdir(), "aops-text-audit-test-"));
    temporaryPaths.push(path);
    return path;
}

function ruleIds(findings) {
    return findings.map((item) => item.ruleId);
}

afterEach(() => {
    for (const path of temporaryPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("mixed-markup structural audit", () => {
    test("accepts balanced LaTeX and ignores Asymptote internals", () => {
        const text =
            "Let $x=\\frac{1}{2}$ and draw " +
            "[asy] draw((0,0)--(1,1)); label(\"$unclosed {\", (0,0)); [/asy].";
        expect(auditText(text, { entityType: "problem_statement", source: "aops" })).toEqual([]);
    });

    test("accepts adjacent inline spans, TeX token arguments, and optional sqrt indexes", () => {
        const text = "$x$$y$ and $\\frac12+\\sqrt[b]{N}=$";
        expect(
            auditText(text, {
                entityType: "problem_statement",
                source: "aops",
            }),
        ).toEqual([]);
    });

    test("reports exact structural failure categories", () => {
        const findings = auditText(
            "[b]Important. Compute $\\frac{x}{y and use \\left(z.",
            { entityType: "problem_statement", source: "aops" },
        );
        expect(ruleIds(findings)).toContain("math.unclosed_delimiter");
        expect(ruleIds(findings)).toContain("latex.unclosed_brace");
        expect(ruleIds(findings)).toContain("latex.left_without_right");
        expect(ruleIds(findings)).toContain("bbcode.unclosed_tag");
        expect(findings.every((item) => Number.isInteger(item.offset))).toBe(true);
        expect(findings.every((item) => item.line >= 1 && item.column >= 1)).toBe(true);
    });

    test("distinguishes environment and delimiter mismatches", () => {
        const findings = auditText(
            "\\begin{align}$x+1\\]\\end{equation}",
            { entityType: "solution", source: "canonical" },
        );
        expect(ruleIds(findings)).toContain("math.mismatched_delimiter");
        expect(ruleIds(findings)).toContain("latex.environment_mismatch");
    });

    test("applies source- and entity-specific residue rules", () => {
        const wiki = auditText("== Solution ==\n$x=1$", {
            entityType: "problem_statement",
            source: "wiki",
        });
        expect(ruleIds(wiki)).toContain("content.solution_or_answer_section");
        expect(ruleIds(wiki)).toContain("content.wiki_markup_residue");

        const solution = auditText("Solution\n$x=1$", {
            entityType: "solution",
            source: "canonical",
        });
        expect(ruleIds(solution)).not.toContain("content.solution_or_answer_section");
    });
});

describe("database audit and reports", () => {
    function fixtureDatabase() {
        const directory = temporaryDirectory();
        const path = join(directory, "fixture.sqlite");
        const db = initDB(path);
        db.run("INSERT INTO series (name) VALUES ('Fixture Series')");
        db.run(`
            INSERT INTO tests (series_id, name, year, aops_category_id)
            VALUES (1, '2026 Fixture', 2026, 'fixture-test')
        `);
        db.run(
            `INSERT INTO problems (
                test_id, n, aops_statement, aops_choices,
                aops_answer_index, aops_answer, statement
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                1,
                0,
                "Find $x+1",
                JSON.stringify(["$1$", "$2$", "$2$"]),
                9,
                "B",
                "Find $x+1",
            ],
        );
        db.run(
            `INSERT INTO solutions (
                problem_id, content, normalized_hash, content_format
             ) VALUES (1, '$x=1$', 'fixture-hash', 'latex_bbcode')`,
        );
        db.run(
            `INSERT INTO solution_sources (
                solution_id, problem_id, source, source_key, raw_content
             ) VALUES (1, 1, 'aops', 'fixture-source', '[b]Unclosed')`,
        );
        return { db, path, directory };
    }

    test("audits statement, choices, canonical solution, and raw source without mutation", () => {
        const { db } = fixtureDatabase();
        const before = db.query("SELECT * FROM problems WHERE id = 1").get();
        const report = auditDatabase(db);
        const after = db.query("SELECT * FROM problems WHERE id = 1").get();

        expect(after).toEqual(before);
        expect(report.summary.auditedByEntity.problem_statement).toBe(1);
        expect(report.summary.auditedByEntity.answer_choice).toBe(3);
        expect(report.summary.auditedByEntity.solution).toBe(1);
        expect(report.summary.auditedByEntity.solution_source).toBe(1);
        expect(ruleIds(report.findings)).toContain("math.unclosed_delimiter");
        expect(ruleIds(report.findings)).toContain("choice.duplicate_value");
        expect(ruleIds(report.findings)).toContain("choice.answer_index_out_of_range");
        expect(ruleIds(report.findings)).toContain("choice.answer_letter_index_mismatch");
        expect(ruleIds(report.findings)).toContain("bbcode.unclosed_tag");
        db.close();
    });

    test("opens the database read-only and writes deterministic JSON and CSV", () => {
        const { db, path, directory } = fixtureDatabase();
        db.close();
        const first = auditDatabaseFile(path);
        const second = auditDatabaseFile(path);
        expect(second).toEqual(first);

        const jsonFile = join(directory, "reports", "audit.json");
        const csvFile = join(directory, "reports", "audit.csv");
        writeAuditReports(first, { jsonFile, csvFile });

        expect(JSON.parse(readFileSync(jsonFile, "utf8"))).toEqual(first);
        const csv = readFileSync(csvFile, "utf8");
        expect(csv).toBe(auditFindingsCsv(first));
        expect(csv).toContain("choice.answer_index_out_of_range");
    });

    test("supports entity and source filters", () => {
        const { db } = fixtureDatabase();
        const report = auditDatabase(db, {
            entities: new Set(["solutions"]),
            sources: new Set(["canonical"]),
        });
        expect(report.summary.totalAuditedTexts).toBe(1);
        expect(report.summary.auditedByEntity).toEqual({ solution: 1 });
        expect(report.findings).toEqual([]);
        db.close();
    });
});
