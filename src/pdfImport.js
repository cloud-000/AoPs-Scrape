// Imports OCR'd PDF problems (from the comp-OCR project's `out/` tree) into the
// SQLite DB, merging onto existing AoPS rows where a test matches.
//
// OCR layout:  out/<series>/<test>/
//   problems.json         { "<num>": "<statement>" }   (1-based string keys)
//   problem_answer.json   { "<num>": "<answer>" }       (optional)
// Everything else (problem_solution.json, *.png, ocr_cache*.json, the
// mathcounts/_answers_ocr/ staging folder) is intentionally skipped.
//
// Problem numbers are 1-based in the OCR but 0-based in the DB (ForumSession
// assigns problem 1 -> n=0), so keys are stored as `int(key) - 1` to line up
// with any existing AoPS rows. Tests dedup by (series, name, year) via
// resolveTestId, so `parseTest` mirrors the DB's naming conventions.

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { upsertSeries, upsertTest, upsertPdfProblem } from "./db.js";

const PURPLE_LEVELS = { HS: "High School", MS: "Middle School" };

// Per OCR-series-folder config. `seriesName` is the canonical DB series name
// (must match an existing row exactly to reuse it). `parseTest` turns an OCR
// test folder name into the DB test's { name, year, section, sectionName }.
export const SERIES_CONFIG = {
    purplecomet: {
        seriesName: "Purple Comet Problems",
        isOfficial: false,
        isComputational: true,
        // "2026_HS" -> "2026 Purple Comet Problems High School"
        parseTest(folder) {
            const [year, level] = folder.split("_");
            const sectionName = PURPLE_LEVELS[level] ?? level;
            return {
                name: `${year} Purple Comet Problems ${sectionName}`,
                year: Number(year),
                section: level === "MS" ? 1 : 0,
                sectionName,
            };
        },
    },
    mathcounts: {
        seriesName: "MATHCOUNTS",
        isOfficial: true,
        isComputational: true,
        // "2015_national_sprint" -> "2015 MATHCOUNTS National Sprint"
        parseTest(folder) {
            const [year, ...rest] = folder.split("_");
            const label = rest.map(titleCase).join(" ");
            return {
                name: `${year} MATHCOUNTS ${label}`.trim(),
                year: Number(year),
                section: -1,
                sectionName: null,
            };
        },
    },
    mandelbrot: {
        seriesName: "Mandelbrot Competition",
        isOfficial: true,
        isComputational: true,
        // "2017-18_tmctest1N" -> "2017-18 Mandelbrot Round 1"
        parseTest(folder) {
            const [schoolYear, testId = ""] = folder.split("_");
            const round = testId.match(/(\d+)/)?.[1];
            const name = round
                ? `${schoolYear} Mandelbrot Round ${round}`
                : `${schoolYear} Mandelbrot ${testId}`.trim();
            return {
                name,
                year: Number(schoolYear.split("-")[0]) || null,
                section: -1,
                sectionName: null,
            };
        },
    },
    usamts: {
        seriesName: "USAMTS",
        isOfficial: true,
        isComputational: false,
        // "10_1" -> "USAMTS Year 10 Round 1"
        parseTest(folder) {
            const [seriesYear, round] = folder.split("_");
            return {
                name: `USAMTS Year ${seriesYear} Round ${round}`,
                year: null,
                section: -1,
                sectionName: null,
            };
        },
    },
};

function titleCase(word) {
    return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function isDir(p) {
    return existsSync(p) && statSync(p).isDirectory();
}

function readJson(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

// Returns the OCR series folders present in `outDir` that we know how to import.
export function listPdfSeries(outDir) {
    if (!isDir(outDir)) return [];
    return readdirSync(outDir).filter(
        (f) => !f.startsWith("_") && SERIES_CONFIG[f] && isDir(join(outDir, f)),
    );
}

// Returns the test folders under a given series folder (those with problems.json).
export function listPdfTests(outDir, seriesFolder) {
    const seriesPath = join(outDir, seriesFolder);
    if (!isDir(seriesPath)) return [];
    return readdirSync(seriesPath).filter(
        (f) =>
            !f.startsWith("_") &&
            isDir(join(seriesPath, f)) &&
            existsSync(join(seriesPath, f, "problems.json")),
    );
}

// Walks `outDir` and merges every recognized series/test into the DB in a single
// transaction. Returns a summary { series, tests, problems } of what was upserted.
//
// `options.series` (array of OCR series-folder names) and `options.tests` (array
// of test-folder names) narrow what is imported; when either is null/empty that
// dimension is unfiltered (all).
export function importPdfProblems(db, outDir, options = {}) {
    if (!isDir(outDir)) {
        throw new Error(`OCR output dir not found: ${outDir}`);
    }

    const seriesFilter =
        options.series?.length > 0 ? new Set(options.series) : null;
    const testFilter =
        options.tests?.length > 0 ? new Set(options.tests) : null;

    const summary = { series: 0, tests: 0, problems: 0 };

    db.transaction(() => {
        for (const seriesFolder of readdirSync(outDir)) {
            // Skip the mathcounts/_answers_ocr staging folder and any unknowns.
            if (seriesFolder.startsWith("_")) continue;
            if (seriesFilter && !seriesFilter.has(seriesFolder)) continue;
            const cfg = SERIES_CONFIG[seriesFolder];
            const seriesPath = join(outDir, seriesFolder);
            if (!cfg || !isDir(seriesPath)) {
                if (isDir(seriesPath)) {
                    console.warn(`  skip unknown series folder: ${seriesFolder}`);
                }
                continue;
            }

            // Created lazily on the first importable test so a test-only filter
            // (e.g. --test=2026_HS) doesn't leave empty series rows behind.
            let seriesId = null;

            for (const testFolder of readdirSync(seriesPath)) {
                if (testFolder.startsWith("_")) continue;
                if (testFilter && !testFilter.has(testFolder)) continue;
                const testPath = join(seriesPath, testFolder);
                if (!isDir(testPath)) continue;

                const problems = readJson(join(testPath, "problems.json"));
                if (!problems || Object.keys(problems).length === 0) {
                    console.warn(
                        `  skip empty test (no problems.json): ${seriesFolder}/${testFolder}`,
                    );
                    continue;
                }
                const answers = readJson(join(testPath, "problem_answer.json")) ?? {};

                if (seriesId == null) {
                    seriesId = upsertSeries(db, cfg.seriesName, -1, cfg.isOfficial);
                    summary.series++;
                }

                const meta = cfg.parseTest(testFolder);
                const testId = upsertTest(
                    db,
                    {
                        aopsCategoryId: null,
                        name: meta.name,
                        section: meta.section ?? -1,
                        sectionName: meta.sectionName ?? null,
                        year: meta.year ?? null,
                        type: null,
                        isComputational: cfg.isComputational,
                    },
                    seriesId,
                );
                summary.tests++;

                let count = 0;
                for (const key of Object.keys(problems)) {
                    const n = Number(key) - 1; // 1-based OCR -> 0-based DB
                    if (!Number.isInteger(n) || n < 0) {
                        console.warn(
                            `  skip non-numeric problem key "${key}" in ${seriesFolder}/${testFolder}`,
                        );
                        continue;
                    }
                    upsertPdfProblem(
                        db,
                        {
                            n,
                            statement: problems[key],
                            answer: answers[key] ?? null,
                            source: `${seriesFolder}/${testFolder}`,
                            is_computational: cfg.isComputational,
                        },
                        testId,
                    );
                    count++;
                }
                summary.problems += count;
                console.log(`  ${meta.name}: ${count} problems`);
            }
        }
    })();

    return summary;
}
