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
    cleanPdfDelimiterResidue,
    escapeLiteralCurrency,
    normalizePdfStatement,
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

    test("separates unescaped currency from math delimiter failures", () => {
        const findings = auditText(
            String.raw`Tickets cost $5, $10.50, or $1,000; value in dollars ($). Let $x=5$, $5$, and $100 + x$ remain math. Escaped \$20 is already safe.`,
            { entityType: "problem_statement", source: "pdf" },
        );
        expect(ruleIds(findings)).toEqual([
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
        ]);
        expect(findings.every((item) => item.severity === "warning")).toBe(true);
    });

    test("masks currency without hiding a real unclosed math delimiter", () => {
        const findings = auditText("The prize is $50. Compute $x+1.", {
            entityType: "problem_statement",
            source: "pdf",
        });
        expect(ruleIds(findings)).toEqual([
            "currency.unescaped_dollar",
            "math.unclosed_delimiter",
        ]);
    });

    test("recognizes the observed obscured-price currency form", () => {
        const findings = auditText("The trophies cost $-99.9-, where digits are hidden.", {
            entityType: "problem_statement",
            source: "pdf",
        });
        expect(ruleIds(findings)).toEqual(["currency.unescaped_dollar"]);
    });

    test("preserves number-led math expressions and numeric variable lists", () => {
        const text =
            "$3x+2=4$, $0<x<1$, $12,w,x,y,z,47$, $0.abcd$, " +
            "$3@n=3$, $-2-i$, $15!m$, $100|a|$, $3,5,7,a,$, " +
            "$59 m - 68 n = mn$, $26.$, and $2(n-5)$";
        expect(
            auditText(text, {
                entityType: "problem_statement",
                source: "pdf",
            }),
        ).toEqual([]);
    });

    test("normalizes high-confidence PDF currency idempotently", () => {
        const source = String.raw`Tickets cost $5, $10.50 (or less), or $42K; let $x=5$, $2 Z 6$, and $10K$ remain math; keep \$20.`;
        const expected = String.raw`Tickets cost \$5, \$10.50 (or less), or \$42K; let $x=5$, $2 Z 6$, and $10K$ remain math; keep \$20.`;
        expect(escapeLiteralCurrency(source)).toBe(expected);
        expect(escapeLiteralCurrency(expected)).toBe(expected);
    });

    test("removes only proven PDF delimiter residue patterns", () => {
        expect(cleanPdfDelimiterResidue("$ A shirt costs $5.")).toBe(
            "A shirt costs $5.",
        );
        expect(cleanPdfDelimiterResidue("$$ According to the graph...")).toBe(
            "According to the graph...",
        );
        expect(
            cleanPdfDelimiterResidue("Earnings? 13. $ ![](figure.png)"),
        ).toBe("Earnings? 13. ![](figure.png)");
        expect(
            cleanPdfDelimiterResidue("Earnings? 13. $\n\n![](figure.png)"),
        ).toBe("Earnings? 13. \n\n![](figure.png)");
        expect(cleanPdfDelimiterResidue("Compute $x+1.")).toBe("Compute $x+1.");
        expect(normalizePdfStatement("$ A ticket costs $5.")).toBe(
            String.raw`A ticket costs \$5.`,
        );
    });

    test("does not reinterpret a math closer followed by digits as currency", () => {
        const text = String.raw`Three cm $\times$12; write $n$37 and 24,6$n$8.`;
        expect(
            auditText(text, {
                entityType: "problem_statement",
                source: "pdf",
            }),
        ).toEqual([]);
    });

    test("treats a dollar-wrapped textual choice as math markup", () => {
        expect(
            auditText("$more than $4", {
                entityType: "answer_choice",
                source: "wiki",
            }),
        ).toEqual([]);
    });

    test("still recognizes currency after an earlier balanced math span", () => {
        const findings = auditText("Let $x=5$. The ticket costs $10.", {
            entityType: "problem_statement",
            source: "pdf",
        });
        expect(ruleIds(findings)).toEqual(["currency.unescaped_dollar"]);
    });

    test("does not let prose punctuation turn later prices into math", () => {
        const findings = auditText(
            "The first pile is worth $62. One-third is removed; the second is worth $162. A carton sells for $2.24. The total (worth $17,640,000) is shown.",
            { entityType: "problem_statement", source: "pdf" },
        );
        expect(ruleIds(findings)).toEqual([
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
            "currency.unescaped_dollar",
        ]);
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

    test("accepts BBCode attributes with whitespace around the equals sign", () => {
        const findings = auditText("[hide = Note]Keep this note.[/hide]", {
            entityType: "problem_statement",
            source: "aops",
        });
        expect(ruleIds(findings)).not.toContain("bbcode.unclosed_tag");
        expect(ruleIds(findings)).not.toContain("bbcode.unmatched_close");
        expect(ruleIds(findings)).not.toContain("bbcode.mismatched_close");
    });

    test("does not flag standalone or scripted operators as trailing", () => {
        const findings = auditText(
            "Use $+$ and $\\cdot$. Let $A^+$, $C^*$, and $R^+$ be labels.",
            { entityType: "problem_statement", source: "aops" },
        );
        expect(ruleIds(findings)).not.toContain("latex.trailing_operator");
        expect(
            ruleIds(
                auditText("Compute $x+$.", {
                    entityType: "problem_statement",
                    source: "aops",
                }),
            ),
        ).toContain("latex.trailing_operator");
    });

    test("distinguishes literal choice text and case from presentation labels", () => {
        const literal = auditText(String.raw`\text{A}`, {
            entityType: "answer_choice",
            source: "aops",
        });
        expect(ruleIds(literal)).not.toContain("choice.embedded_label");
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

    test("does not merge case-distinct choices during duplicate detection", () => {
        const { db } = fixtureDatabase();
        db.run(
            "UPDATE problems SET aops_choices = ?, aops_answer_index = 0, aops_answer = 'A' WHERE id = 1",
            [JSON.stringify(["m", "M", "other"])],
        );
        const report = auditDatabase(db, {
            entities: new Set(["choices"]),
            sources: new Set(["aops"]),
        });
        expect(ruleIds(report.findings)).not.toContain("choice.duplicate_value");
        db.close();
    });

    test("distinguishes composite visual choices from missing textual choices", () => {
        const { db } = fixtureDatabase();
        const visual = String.raw`Which graph is correct?
[asy]
label("$\textbf{(A)}$", (0,0));
label("$\textbf{(B)}$", (1,0));
label("$\textbf{(C)}$", (2,0));
label("$\textbf{(D)}$", (3,0));
label("$\textbf{(E)}$", (4,0));
[/asy]`;
        db.run(
            "UPDATE problems SET aops_statement = ?, aops_choices = ?, aops_answer_index = 0, aops_answer = 'A' WHERE id = 1",
            [visual, JSON.stringify(["", "", "", "", ""])],
        );
        const visualReport = auditDatabase(db, {
            entities: new Set(["choices"]),
            sources: new Set(["aops"]),
        });
        expect(ruleIds(visualReport.findings)).toEqual(["choice.visual_only"]);
        expect(visualReport.summary.auditedByEntity.answer_choice).toBe(5);

        db.run(
            "UPDATE problems SET aops_statement = ?, aops_choices = ? WHERE id = 1",
            [
                "What is the area of the shaded figure? [asy]draw(unitsquare);[/asy]",
                JSON.stringify([]),
            ],
        );
        const missingReport = auditDatabase(db, {
            entities: new Set(["choices"]),
            sources: new Set(["aops"]),
        });
        expect(ruleIds(missingReport.findings)).toContain(
            "choice.unexpected_count",
        );
        expect(ruleIds(missingReport.findings)).not.toContain(
            "choice.visual_only",
        );
        db.close();
    });
});
