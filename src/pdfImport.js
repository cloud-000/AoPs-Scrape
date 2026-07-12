// Imports OCR'd PDF problems (from the comp-OCR project's `out/` tree) into the
// SQLite DB, merging onto existing AoPS rows where a test matches.
//
// OCR layout:  out/<series>/<test>/
//   problems.json         { "<num>": "<statement>" }          (1-based string keys)
//   problem_answer.json   { "<num>": "<answer>" }             (optional)
//   problem_solution.json { "<num>": ["<solution>", ...] }    (optional)
// Everything else (*.png figures, ocr_cache*.json, the mathcounts/_answers_ocr/
// staging folder) is intentionally skipped.
//
// Solutions are ingested through upsertSolutionCandidate as source='import', so
// they reuse the existing dedup pipeline: exact dedup by normalized content hash
// on insert, and near-dedup in preprocess (classifySolutions). Solutions from
// official contests (SERIES_CONFIG[*].isOfficial) are marked is_official and
// auto-accept into production; non-official ones enter as candidates the
// classifier score-gates.
//
// Problem numbers are 1-based in the OCR but 0-based in the DB (ForumSession
// assigns problem 1 -> n=0), so keys are stored as `int(key) - 1` to line up
// with any existing AoPS rows. Tests dedup by (series, name, year) via
// resolveTestId, so `parseTest` mirrors the DB's naming conventions.

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
    upsertSeries,
    upsertTest,
    upsertPdfProblem,
    upsertSolutionCandidate,
} from "./db.js";
import {
    mathcountsTestMetadata,
    numberedFormatMetadata,
    schoolDivisionMetadata,
} from "./testMetadata.js";

const PURPLE_LEVELS = { HS: "High School", MS: "Middle School" };

const HMMT_MONTHS = { feb: "February", nov: "November" };
const HMMT_ROUNDS = {
    adv: "Advanced",
    alg: "Algebra",
    calc: "Calculus",
    comb: "Combinatorics",
    geo: "Geometry",
    gen: "General",
    gen1: "General 1",
    gen2: "General 2",
    guts: "Guts",
    oral: "Oral",
    pow: "Power",
    team: "Team",
    team1: "Team 1",
    team2: "Team 2",
    algcalc: "Algebra/Calculus",
    algcomb: "Algebra/Combinatorics",
    alggeo: "Algebra/Geometry",
    calccomb: "Calculus/Combinatorics",
    calcgeo: "Calculus/Geometry",
    combgeo: "Combinatorics/Geometry",
    thm: "Theme",
};
const PUMAC_SUBJECTS = {
    algebra: "Algebra",
    combinatorics: "Combinatorics",
    geometry: "Geometry",
    number_theory: "Number Theory",
    individual_finals: "Individual Finals",
};

// Per OCR-series-folder config. `seriesName` is the canonical DB series name
// (must match an existing row exactly to reuse it). `parseTest` turns an OCR
// test folder name into the DB test's { name, year, section, sectionName }.
export const SERIES_CONFIG = {
    purplecomet: {
        seriesName: "Purple Comet",
        isOfficial: false,
        isComputational: true,
        // "2026_HS" -> "2026 Purple Comet High School". Flat test: the level is
        // baked into the name (not a DB section), mirroring how the scraper
        // folds a single-section AoPS category — see
        // ForumSession._normalizeSections — so PDF rows merge onto AoPS rows.
        parseTest(folder) {
            const [year, level] = folder.split("_");
            const label = PURPLE_LEVELS[level] ?? level;
            return {
                name: `${year} Purple Comet ${label}`,
                year: Number(year),
                section: -1,
                sectionName: null,
                ...schoolDivisionMetadata(level),
            };
        },
    },
    mathcounts: {
        seriesName: "MATHCOUNTS",
        isOfficial: true,
        isComputational: true,
        // "2015_national_sprint" -> "2015 MATHCOUNTS National Sprint"
        parseTest(folder) {
            const [year, division, format, ...extra] = folder.split("_");
            if (format?.toLowerCase() === "countdown") return null;
            const rest = [division, format, ...extra].filter(Boolean);
            const label = rest.map(titleCase).join(" ");
            return {
                name: `${year} MATHCOUNTS ${label}`.trim(),
                year: Number(year),
                section: -1,
                sectionName: null,
                ...mathcountsTestMetadata(division, format),
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
                ...numberedFormatMetadata("Round", round),
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
                ...numberedFormatMetadata("Round", round),
            };
        },
    },
    hmmt: {
        seriesName: "HMMT",
        isOfficial: true,
        isComputational: true,
        // "2026_feb_guts" -> "2026 HMMT February Guts" (series "HMMT")
        // "2026_nov_gen1" -> "2026 HMMT November General 1" (series "HMMT November")
        // "2026_hmic"     -> "2026 HMMT Invitational"    (series "HMMT")
        // The series name varies per test so PDF rows merge onto the split AoPS
        // series rows (HMMT vs HMMT November) rather than one combined series.
        parseTest(folder) {
            const [yearStr, monthOrKind, round, ...extra] = folder.split("_");
            const year = Number(yearStr);
            if (!Number.isInteger(year) || extra.length > 0) return null;
            if (monthOrKind?.toLowerCase() === "hmic") {
                return {
                    name: `${year} HMMT Invitational`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "HMMT",
                };
            }
            const month = HMMT_MONTHS[monthOrKind?.toLowerCase()];
            const roundLabel = HMMT_ROUNDS[round?.toLowerCase()];
            if (!month || !roundLabel) return null;
            const seriesName = month === "November" ? "HMMT November" : "HMMT";
            return {
                name: `${year} HMMT ${month} ${roundLabel}`,
                year,
                section: -1,
                sectionName: null,
                seriesName,
            };
        },
    },
    mpfg: {
        seriesName: "MPFG",
        isOfficial: true,
        isComputational: false,
        // "2025_mathprize" -> "2025 Math Prize"   (series "MPFG")
        // "2025_olympiad"  -> "2025 Olympiad"     (series "MPFG Olympiad")
        // Both are proof-based; the series split mirrors the AoPS registry.
        parseTest(folder) {
            const [yearStr, kind, ...extra] = folder.split("_");
            const year = Number(yearStr);
            if (!Number.isInteger(year) || extra.length > 0) return null;
            const k = kind?.toLowerCase();
            if (k === "mathprize") {
                return {
                    name: `${year} Math Prize`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "MPFG",
                };
            }
            if (k === "olympiad") {
                return {
                    name: `${year} Olympiad`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "MPFG Olympiad",
                };
            }
            return null;
        },
    },
    pumac: {
        seriesName: "PUMAC",
        isOfficial: true,
        isComputational: true,
        // "2025_A_algebra"          -> "2025 PUMaC A Algebra"
        // "2025_B_individual_finals" -> "2025 PUMaC B Individual Finals"
        // "2025_team"               -> "2025 PUMaC Team"
        parseTest(folder) {
            const parts = folder.split("_");
            const yearStr = parts[0];
            const letter = parts[1];
            // Subject may itself contain an underscore (e.g. individual_finals).
            const subject = parts.slice(2).join("_");
            const year = Number(yearStr);
            if (!Number.isInteger(year) || !letter) return null;
            const L = letter.toUpperCase();
            if (L === "TEAM") {
                return {
                    name: `${year} PUMaC Team`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "PUMAC",
                };
            }
            if (L !== "A" && L !== "B") return null;
            const subj = PUMAC_SUBJECTS[subject?.toLowerCase()];
            if (!subj) return null;
            return {
                name: `${year} PUMaC ${L} ${subj}`,
                year,
                section: -1,
                sectionName: null,
                seriesName: "PUMAC",
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
    const cfg = SERIES_CONFIG[seriesFolder];
    return readdirSync(seriesPath).filter((f) => {
        if (
            f.startsWith("_") ||
            !isDir(join(seriesPath, f)) ||
            !existsSync(join(seriesPath, f, "problems.json"))
        ) {
            return false;
        }
        return !cfg || cfg.parseTest(f) != null;
    });
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

    const summary = { series: 0, tests: 0, problems: 0, solutions: 0 };

    db.transaction(() => {
        for (const seriesFolder of readdirSync(outDir)) {
            // Skip the mathcounts/_answers_ocr staging folder and any unknowns.
            if (seriesFolder.startsWith("_")) continue;
            if (seriesFilter && !seriesFilter.has(seriesFolder)) continue;
            const cfg = SERIES_CONFIG[seriesFolder];
            const seriesPath = join(outDir, seriesFolder);
            if (!cfg || !isDir(seriesPath)) {
                if (isDir(seriesPath)) {
                    console.warn(
                        `  skip unknown series folder: ${seriesFolder}`,
                    );
                }
                continue;
            }

            // A single OCR folder can map to multiple DB series (e.g. HMMT Feb ->
            // "HMMT", HMMT Nov -> "HMMT November"), so the series is resolved
            // per test from `meta.seriesName ?? cfg.seriesName`. Track which
            // series rows we've already created so a test-only filter (e.g.
            // --test=2026_feb_guts) doesn't leave empty series rows behind, and
            // so summary.series counts each series once.
            const seriesIds = new Map(); // seriesName -> id

            for (const testFolder of readdirSync(seriesPath)) {
                if (testFolder.startsWith("_")) continue;
                if (testFilter && !testFilter.has(testFolder)) continue;
                const testPath = join(seriesPath, testFolder);
                if (!isDir(testPath)) continue;

                const meta = cfg.parseTest(testFolder);
                if (meta == null) {
                    console.warn(
                        `  skip unsupported test: ${seriesFolder}/${testFolder}`,
                    );
                    continue;
                }

                const problems = readJson(join(testPath, "problems.json"));
                if (!problems || Object.keys(problems).length === 0) {
                    console.warn(
                        `  skip empty test (no problems.json): ${seriesFolder}/${testFolder}`,
                    );
                    continue;
                }
                const answers =
                    readJson(join(testPath, "problem_answer.json")) ?? {};
                const solutions =
                    readJson(join(testPath, "problem_solution.json")) ?? {};

                const seriesName = meta.seriesName ?? cfg.seriesName;
                let seriesId = seriesIds.get(seriesName);
                if (seriesId == null) {
                    seriesId = upsertSeries(db, seriesName, -1, cfg.isOfficial);
                    seriesIds.set(seriesName, seriesId);
                    summary.series++;
                }

                const testId = upsertTest(
                    db,
                    {
                        aopsCategoryId: null,
                        name: meta.name,
                        section: meta.section ?? -1,
                        sectionName: meta.sectionName ?? null,
                        year: meta.year ?? null,
                        division: meta.division,
                        divisionOrder: meta.divisionOrder,
                        format: meta.format,
                        formatOrder: meta.formatOrder,
                        type: null,
                        isComputational: cfg.isComputational,
                        // Section structure is scraper-owned; PDF import must
                        // not rewrite section/section_name on an existing row.
                        updateSection: false,
                    },
                    seriesId,
                );
                summary.tests++;

                let count = 0;
                const problemIdByN = new Map(); // n -> problem id, for attaching solutions
                for (const key of Object.keys(problems)) {
                    const n = Number(key) - 1; // 1-based OCR -> 0-based DB
                    if (!Number.isInteger(n) || n < 0) {
                        console.warn(
                            `  skip non-numeric problem key "${key}" in ${seriesFolder}/${testFolder}`,
                        );
                        continue;
                    }
                    const problemId = upsertPdfProblem(
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
                    problemIdByN.set(n, problemId);
                    count++;
                }

                // Attach OCR'd solutions to the problems just upserted. Keys are
                // 1-based like problems; each value is an array of solution
                // strings. Dedup (exact + near) is handled downstream by
                // upsertSolutionCandidate / classifySolutions.
                let solCount = 0;
                for (const key of Object.keys(solutions)) {
                    const n = Number(key) - 1;
                    if (!Number.isInteger(n) || n < 0) {
                        console.warn(
                            `  skip non-numeric solution key "${key}" in ${seriesFolder}/${testFolder}`,
                        );
                        continue;
                    }
                    const problemId = problemIdByN.get(n);
                    if (problemId == null) continue; // solution with no matching problem
                    const list = solutions[key];
                    if (!Array.isArray(list)) continue;
                    for (const solStr of list) {
                        if (typeof solStr !== "string" || !solStr.trim())
                            continue;
                        upsertSolutionCandidate(db, {
                            problemId,
                            source: "import",
                            content: solStr,
                            content_format: "markdown_latex",
                            // Official contests auto-accept; others enter as
                            // candidates for the classifier to score-gate.
                            is_official: cfg.isOfficial,
                            // sourceKey omitted -> getSourceKey falls back to
                            // `import:<contentHash>`, deduping identical source
                            // rows and making re-import idempotent.
                        });
                        solCount++;
                    }
                }

                summary.problems += count;
                summary.solutions += solCount;
                console.log(
                    `  ${meta.name}: ${count} problems, ${solCount} solutions`,
                );
            }
        }
    })();

    return summary;
}
