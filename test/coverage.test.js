import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ANSWER_STATUS_CLAIMS,
    RESPONSE_KINDS,
    RESOLVED_ANSWER_STATUSES,
    isComputationalFor,
    readProblemCoverage,
    readTestProfile,
    resolveCoverage,
} from "../src/coverage.js";
import {
    buildProductionProblems,
    initDB,
    upsertPdfProblem,
    upsertSeries,
    upsertTest,
    VerifiedCoverageConflictError,
} from "../src/db.js";
import { importPdfProblems } from "../src/pdfImport.js";

const temporaryPaths = [];

function temporaryDirectory() {
    const path = mkdtempSync(join(tmpdir(), "aops-coverage-test-"));
    temporaryPaths.push(path);
    return path;
}

function temporaryDatabase() {
    const directory = temporaryDirectory();
    return initDB(join(directory, "test.sqlite"));
}

function pdfImportFixture() {
    const outDirectory = temporaryDirectory();
    const testDirectory = join(
        outDirectory,
        "purplecomet",
        "2026_HS",
    );
    mkdirSync(testDirectory, { recursive: true });
    writeFileSync(
        join(testDirectory, "problems.json"),
        JSON.stringify({ 1: "Compute the fixture." }),
    );
    writeFileSync(
        join(testDirectory, "problem_answer.json"),
        JSON.stringify({ 1: "42" }),
    );
    return { outDirectory, testDirectory };
}

afterEach(() => {
    for (const path of temporaryPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("coverage vocabulary and computational policy", () => {
    test("stored claims exclude the derived known status", () => {
        expect(RESPONSE_KINDS).toContain("proof");
        expect(ANSWER_STATUS_CLAIMS).toContain("not_applicable");
        expect(ANSWER_STATUS_CLAIMS).not.toContain("known");
        expect(RESOLVED_ANSWER_STATUSES).toEqual([
            ...ANSWER_STATUS_CLAIMS,
            "known",
        ]);
    });

    test("only proof overrides the raw computational flag", () => {
        expect(isComputationalFor(true, null)).toBe(1);
        expect(isComputationalFor(false, null)).toBe(0);
        expect(isComputationalFor(true, "proof")).toBe(0);
        expect(isComputationalFor(true, "interactive")).toBe(1);
        expect(isComputationalFor(true, "estimation")).toBe(1);
        expect(isComputationalFor(false, "short_answer")).toBe(0);
    });

    test("pure resolution applies override, declaration, and derived precedence", () => {
        expect(
            resolveCoverage({
                overrideResponseKind: "interactive",
                declarationResponseKind: "proof",
                overrideAnswerStatus: "source_missing",
                declarationAnswerStatus: "not_applicable",
                hasAnswer: true,
                rawIsComputational: true,
            }),
        ).toEqual({
            responseKind: "interactive",
            answerStatus: "source_missing",
            isComputational: 1,
        });

        expect(
            resolveCoverage({
                declarationResponseKind: "proof",
                declarationAnswerStatus: "not_applicable",
                rawIsComputational: true,
            }),
        ).toEqual({
            responseKind: "proof",
            answerStatus: "not_applicable",
            isComputational: 0,
        });

        expect(resolveCoverage({ hasAnswer: true })).toEqual({
            responseKind: null,
            answerStatus: "known",
            isComputational: 0,
        });
        expect(resolveCoverage()).toEqual({
            responseKind: null,
            answerStatus: null,
            isComputational: 0,
        });
    });
});

describe("coverage file readers", () => {
    test("reads a valid test declaration without persisting derived fields", () => {
        const directory = temporaryDirectory();
        writeFileSync(
            join(directory, "test_profile.json"),
            JSON.stringify({
                response_kind: "proof",
                answer_status: "not_applicable",
                practice_mode: "browse",
            }),
        );

        expect(readTestProfile(directory, "fixture/profile")).toEqual({
            state: "present",
            value: {
                response_kind: "proof",
                answer_status: "not_applicable",
            },
        });
    });

    test("an absent file contributes no usable claim", () => {
        const directory = temporaryDirectory();

        expect(readTestProfile(directory)).toEqual({
            state: "absent",
            value: null,
        });
        expect(readProblemCoverage(directory)).toEqual({
            state: "absent",
            value: null,
        });
    });

    test("keeps valid fields and drops unknown vocabulary", () => {
        const directory = temporaryDirectory();
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        writeFileSync(
            join(directory, "test_profile.json"),
            JSON.stringify({
                response_kind: "essay",
                answer_status: "needs_review",
            }),
        );
        writeFileSync(
            join(directory, "problem_coverage.json"),
            JSON.stringify({
                1: { answer_status: "source_missing" },
                2: { response_kind: "proof", answer_status: "known" },
                3: { response_kind: "essay" },
                4: null,
            }),
        );

        expect(readTestProfile(directory, "fixture/profile")).toEqual({
            state: "present",
            value: {
                response_kind: undefined,
                answer_status: "needs_review",
            },
        });
        expect(readProblemCoverage(directory, "fixture/problems")).toEqual({
            state: "present",
            value: {
                1: { response_kind: null, answer_status: "source_missing" },
                2: { response_kind: "proof", answer_status: undefined },
                3: { response_kind: undefined, answer_status: null },
                4: {
                    response_kind: undefined,
                    answer_status: undefined,
                },
            },
        });
        expect(warn).toHaveBeenCalledTimes(4);
        warn.mockRestore();
    });

    test("malformed files contribute no usable claim", () => {
        const directory = temporaryDirectory();
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        writeFileSync(join(directory, "test_profile.json"), "{");
        writeFileSync(join(directory, "problem_coverage.json"), "[");

        expect(readTestProfile(directory)).toEqual({
            state: "invalid",
            value: null,
        });
        expect(readProblemCoverage(directory)).toEqual({
            state: "invalid",
            value: null,
        });
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    test("distinguishes an absent profile from an explicit empty snapshot", () => {
        const directory = temporaryDirectory();
        expect(readTestProfile(directory).state).toBe("absent");

        writeFileSync(join(directory, "test_profile.json"), "{}");
        expect(readTestProfile(directory)).toEqual({
            state: "present",
            value: { response_kind: null, answer_status: null },
        });
    });

    test("distinguishes an absent coverage map from a present empty snapshot", () => {
        const directory = temporaryDirectory();
        expect(readProblemCoverage(directory).state).toBe("absent");

        writeFileSync(join(directory, "problem_coverage.json"), "{}");
        expect(readProblemCoverage(directory)).toEqual({
            state: "present",
            value: {},
        });
    });
});

describe("production coverage resolution", () => {
    test("resolves override, declaration, and derived known in that order", () => {
        const db = temporaryDatabase();
        const seriesId = upsertSeries(db, "Coverage Fixtures", -1, true);
        const proofTestId = upsertTest(
            db,
            {
                name: "Proof Fixture",
                year: 2026,
                isComputational: true,
                responseKind: "proof",
                answerStatus: "not_applicable",
            },
            seriesId,
        );
        const ordinaryTestId = upsertTest(
            db,
            {
                name: "Ordinary Fixture",
                year: 2026,
                isComputational: true,
            },
            seriesId,
        );

        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Prove the fixture.",
                answer: null,
                is_computational: true,
                answerNotApplicable: true,
            },
            proofTestId,
        );
        upsertPdfProblem(
            db,
            {
                n: 1,
                statement: "A source omitted this answer.",
                answer: null,
                is_computational: true,
                coverage_answer_status: "source_missing",
            },
            proofTestId,
        );
        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Compute the fixture.",
                answer: "42",
                is_computational: true,
            },
            ordinaryTestId,
        );

        buildProductionProblems(db);

        const proofRows = db
            .query(
                `SELECT n, response_kind, answer_status, answer_index,
                        is_computational
                 FROM production_problems
                 WHERE test_id = ? ORDER BY n`,
            )
            .all(proofTestId);
        const ordinaryRow = db
            .query(
                `SELECT response_kind, answer_status, answer_index,
                        is_computational
                 FROM production_problems
                 WHERE test_id = ? AND n = 0`,
            )
            .get(ordinaryTestId);
        const sourceProofRows = db
            .query(
                `SELECT n, coverage_response_kind, coverage_answer_status
                 FROM problems WHERE test_id = ? ORDER BY n`,
            )
            .all(proofTestId);

        expect(proofRows).toEqual([
            {
                n: 0,
                response_kind: "proof",
                answer_status: "not_applicable",
                answer_index: -1,
                is_computational: 0,
            },
            {
                n: 1,
                response_kind: "proof",
                answer_status: "source_missing",
                answer_index: -1,
                is_computational: 0,
            },
        ]);
        expect(ordinaryRow).toEqual({
            response_kind: null,
            answer_status: "known",
            answer_index: 0,
            is_computational: 1,
        });
        expect(sourceProofRows).toEqual([
            {
                n: 0,
                coverage_response_kind: null,
                coverage_answer_status: null,
            },
            {
                n: 1,
                coverage_response_kind: null,
                coverage_answer_status: "source_missing",
            },
        ]);

        db.close();
    });

    test("fresh source tables reject derived or unknown claims", () => {
        const db = temporaryDatabase();
        const seriesId = upsertSeries(db, "Constraint Fixtures", -1, true);
        const testId = upsertTest(
            db,
            { name: "Constraint Fixture", isComputational: true },
            seriesId,
        );

        expect(() =>
            db.run(`UPDATE tests SET answer_status = 'known' WHERE id = ?`, [
                testId,
            ]),
        ).toThrow();
        expect(() =>
            db.run(`UPDATE tests SET response_kind = 'essay' WHERE id = ?`, [
                testId,
            ]),
        ).toThrow();

        db.close();
    });
});

describe("verified coverage conflicts", () => {
    test("preserves verified answers, stores the claim, and blocks build without replacing production", () => {
        const db = temporaryDatabase();
        const seriesId = upsertSeries(db, "Verified Fixtures", -1, true);
        const testId = upsertTest(
            db,
            { name: "Verified Fixture", isComputational: true },
            seriesId,
        );

        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Compute the verified fixture.",
                answer: "42",
                is_computational: true,
            },
            testId,
        );
        buildProductionProblems(db);
        const productionBefore = db
            .query(
                `SELECT test_id, n, statement, choices, answer_index,
                        answer_status
                 FROM production_problems ORDER BY test_id, n`,
            )
            .all();

        db.run(
            `UPDATE problems SET verified = 1 WHERE test_id = ? AND n = 0`,
            [testId],
        );
        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Compute the verified fixture.",
                answer: null,
                is_computational: true,
                coverage_answer_status: "not_applicable",
                answerNotApplicable: true,
            },
            testId,
        );

        expect(
            db
                .query(
                    `SELECT pdf_answer, answer_value, answer_index, verified,
                            coverage_answer_status
                     FROM problems WHERE test_id = ? AND n = 0`,
                )
                .get(testId),
        ).toEqual({
            pdf_answer: "42",
            answer_value: "42",
            answer_index: -1,
            verified: 1,
            coverage_answer_status: "not_applicable",
        });

        let conflict;
        try {
            buildProductionProblems(db);
        } catch (error) {
            conflict = error;
        }
        expect(conflict).toBeInstanceOf(VerifiedCoverageConflictError);
        expect(conflict?.name).toBe("VerifiedCoverageConflictError");
        expect(conflict?.message).toContain(
            "Verified Fixture problem 1 (problem_id=1, test_id=1)",
        );
        expect(conflict?.conflicts).toHaveLength(1);
        expect(
            db
                .query(
                    `SELECT test_id, n, statement, choices, answer_index,
                            answer_status
                     FROM production_problems ORDER BY test_id, n`,
                )
                .all(),
        ).toEqual(productionBefore);

        db.close();
    });

    test("retracts an unverified answer but permits a verified statement with no answer", () => {
        const db = temporaryDatabase();
        const seriesId = upsertSeries(db, "Retraction Fixtures", -1, true);
        const testId = upsertTest(
            db,
            { name: "Retraction Fixture", isComputational: true },
            seriesId,
        );

        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Automatic answer fixture.",
                answer: "17",
                is_computational: true,
            },
            testId,
        );
        upsertPdfProblem(
            db,
            {
                n: 0,
                statement: "Automatic answer fixture.",
                answer: null,
                is_computational: true,
                coverage_answer_status: "not_applicable",
                answerNotApplicable: true,
            },
            testId,
        );
        upsertPdfProblem(
            db,
            {
                n: 1,
                statement: "Verified statement-only fixture.",
                answer: null,
                is_computational: true,
                coverage_answer_status: "not_applicable",
                answerNotApplicable: true,
            },
            testId,
        );
        db.run(
            `UPDATE problems SET verified = 1 WHERE test_id = ? AND n = 1`,
            [testId],
        );

        expect(
            db
                .query(
                    `SELECT n, pdf_answer, answer_value, answer_index, verified
                     FROM problems WHERE test_id = ? ORDER BY n`,
                )
                .all(testId),
        ).toEqual([
            {
                n: 0,
                pdf_answer: null,
                answer_value: null,
                answer_index: -1,
                verified: 0,
            },
            {
                n: 1,
                pdf_answer: null,
                answer_value: null,
                answer_index: -1,
                verified: 1,
            },
        ]);

        expect(buildProductionProblems(db)).toBe(2);
        expect(
            db
                .query(
                    `SELECT n, answer_status, answer_index
                     FROM production_problems WHERE test_id = ? ORDER BY n`,
                )
                .all(testId),
        ).toEqual([
            { n: 0, answer_status: "not_applicable", answer_index: -1 },
            { n: 1, answer_status: "not_applicable", answer_index: -1 },
        ]);

        db.close();
    });
});

describe("persisted coverage during PDF re-import", () => {
    test("absent or invalid profiles preserve their declaration and retraction", () => {
        const db = temporaryDatabase();
        const { outDirectory, testDirectory } = pdfImportFixture();
        const log = spyOn(console, "log").mockImplementation(() => {});
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        const profilePath = join(testDirectory, "test_profile.json");

        writeFileSync(
            profilePath,
            JSON.stringify({
                response_kind: "proof",
                answer_status: "not_applicable",
            }),
        );
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });

        const testId = db.query(`SELECT id FROM tests`).get().id;
        const problem = () =>
            db
                .query(
                    `SELECT pdf_answer, answer_value, answer_index
                     FROM problems WHERE test_id = ? AND n = 0`,
                )
                .get(testId);
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            answer_index: -1,
        });

        rmSync(profilePath);
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            answer_index: -1,
        });

        writeFileSync(profilePath, "{");
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            answer_index: -1,
        });

        writeFileSync(profilePath, "{}");
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(
            db
                .query(
                    `SELECT response_kind, answer_status FROM tests WHERE id = ?`,
                )
                .get(testId),
        ).toEqual({ response_kind: null, answer_status: null });
        expect(problem()).toEqual({
            pdf_answer: "42",
            answer_value: "42",
            answer_index: null,
        });

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        log.mockRestore();
        db.close();
    });

    test("absent or invalid problem maps preserve overrides; an empty snapshot clears", () => {
        const db = temporaryDatabase();
        const { outDirectory, testDirectory } = pdfImportFixture();
        const log = spyOn(console, "log").mockImplementation(() => {});
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        const coveragePath = join(testDirectory, "problem_coverage.json");

        writeFileSync(
            coveragePath,
            JSON.stringify({ 1: { answer_status: "not_applicable" } }),
        );
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });

        const testId = db.query(`SELECT id FROM tests`).get().id;
        const problem = () =>
            db
                .query(
                    `SELECT pdf_answer, answer_value, coverage_answer_status
                     FROM problems WHERE test_id = ? AND n = 0`,
                )
                .get(testId);
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            coverage_answer_status: "not_applicable",
        });

        rmSync(coveragePath);
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            coverage_answer_status: "not_applicable",
        });

        writeFileSync(coveragePath, "[");
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(problem()).toEqual({
            pdf_answer: null,
            answer_value: null,
            coverage_answer_status: "not_applicable",
        });

        writeFileSync(coveragePath, "{}");
        importPdfProblems(db, outDirectory, { series: ["purplecomet"] });
        expect(problem()).toEqual({
            pdf_answer: "42",
            answer_value: "42",
            coverage_answer_status: null,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
        log.mockRestore();
        db.close();
    });
});
