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
    resolveTestId,
    resolveProblemId,
    upsertProblemLink,
} from "./db.js";
import {
    mathcountsTestMetadata,
    numberedFormatMetadata,
    schoolDivisionMetadata,
    hmmtSeasonMetadata,
    hmmtRoundMetadata,
    mpfgContestMetadata,
    pumacDivisionMetadata,
    pumacSubjectMetadata,
    mandelbrotDivisionMetadata,
    bmtDivisionMetadata,
    bmtFormatMetadata,
    smtDivisionMetadata,
    smtFormatMetadata,
} from "./testMetadata.js";

const PURPLE_LEVELS = { HS: "High School", MS: "Middle School" };

const HMMT_MONTHS = { feb: "February", nov: "November" };
// HMMT round/theme -> format label + order (the "which format" axis).
const HMMT_ROUNDS = {
    adv: { label: "Advanced", order: 10 },
    alg: { label: "Algebra", order: 20 },
    calc: { label: "Calculus", order: 30 },
    comb: { label: "Combinatorics", order: 40 },
    geo: { label: "Geometry", order: 50 },
    gen: { label: "General", order: 60 },
    gen1: { label: "General 1", order: 61 },
    gen2: { label: "General 2", order: 62 },
    guts: { label: "Guts", order: 70 },
    oral: { label: "Oral", order: 80 },
    pow: { label: "Power", order: 90 },
    team: { label: "Team", order: 100 },
    team1: { label: "Team 1", order: 101 },
    team2: { label: "Team 2", order: 102 },
    algcalc: { label: "Algebra/Calculus", order: 110 },
    algcomb: { label: "Algebra/Combinatorics", order: 120 },
    alggeo: { label: "Algebra/Geometry", order: 130 },
    calccomb: { label: "Calculus/Combinatorics", order: 140 },
    calcgeo: { label: "Calculus/Geometry", order: 150 },
    combgeo: { label: "Combinatorics/Geometry", order: 160 },
    thm: { label: "Theme", order: 170 },
};
const PUMAC_SUBJECTS = {
    algebra: { label: "Algebra", order: 10 },
    combinatorics: { label: "Combinatorics", order: 20 },
    geometry: { label: "Geometry", order: 30 },
    number_theory: { label: "Number Theory", order: 40 },
    individual_finals: { label: "Individual Finals", order: 50 },
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
        // "2017-18_tmctest1N" -> "2017-18 Mandelbrot National Round 1" (National division)
        // "2017-18_tmctest1R" -> "2017-18 Mandelbrot Regional Round 1" (Regional division)
        // "2009-10_mtptest1"  -> "2009-10 Mandelbrot Team Play Round 1" (Team Play)
        // The `tmc` individual test is split into National (N) / Regional (R)
        // divisions; the `mtp` Team Play round carries no N/R suffix. Without the
        // division in the name the N/R (and tmc/mtp) folders would collide on one
        // test name, so it must distinguish them.
        parseTest(folder) {
            const [schoolYear, testId = ""] = folder.split("_");
            const m = testId.match(/^(tmc|mtp)test(\d+)([NR])?$/i);
            if (!m) return null;
            const kind = m[1].toLowerCase();
            const round = m[2];
            const divToken = kind === "mtp" ? "team" : m[3]?.toUpperCase();
            const div = mandelbrotDivisionMetadata(divToken);
            if (!div.division) return null;
            // Reuse numberedFormatMetadata for the round but keep only its format
            // fields so the division above isn't clobbered by its empty base.
            const { format, formatOrder } = numberedFormatMetadata(
                "Round",
                round,
            );
            return {
                name: `${schoolYear} Mandelbrot ${div.division} Round ${round}`,
                year: Number(schoolYear.split("-")[0]) || null,
                section: -1,
                sectionName: null,
                ...div,
                format,
                formatOrder,
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
                    ...hmmtSeasonMetadata("hmic"),
                    ...hmmtRoundMetadata(null, null),
                };
            }
            const month = HMMT_MONTHS[monthOrKind?.toLowerCase()];
            const roundKey = round?.toLowerCase();
            const roundMeta = HMMT_ROUNDS[roundKey];
            if (!month || !roundMeta) return null;
            const seriesName = month === "November" ? "HMMT November" : "HMMT";
            return {
                name: `${year} HMMT ${month} ${roundMeta.label}`,
                year,
                section: -1,
                sectionName: null,
                seriesName,
                ...hmmtSeasonMetadata(monthOrKind),
                ...hmmtRoundMetadata(roundMeta.label, roundMeta.order),
            };
        },
    },
    mpfg: {
        seriesName: "MPFG",
        isOfficial: true,
        // Series default; each parseTest branch overrides it (Math Prize is
        // computational, the Olympiad is proof-based).
        isComputational: false,
        // "2025_mathprize" -> "2025 Math Prize for Girls"          (series "MPFG")
        // "2025_olympiad"  -> "2025 Math Prize for Girls Olympiad" (series "MPFG Olympiad")
        // Names match the canonical form CleanupText.normalizeContestName folds
        // the AoPS scrape onto, so PDF rows merge on the (series, name, year) key.
        // The two contests differ on the computational axis (see isComputational).
        parseTest(folder) {
            const [yearStr, kind, ...extra] = folder.split("_");
            const year = Number(yearStr);
            if (!Number.isInteger(year) || extra.length > 0) return null;
            const k = kind?.toLowerCase();
            if (k === "mathprize") {
                return {
                    name: `${year} Math Prize for Girls`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "MPFG",
                    isComputational: true,
                    ...mpfgContestMetadata("mathprize"),
                };
            }
            if (k === "olympiad") {
                return {
                    name: `${year} Math Prize for Girls Olympiad`,
                    year,
                    section: -1,
                    sectionName: null,
                    seriesName: "MPFG Olympiad",
                    isComputational: false,
                    ...mpfgContestMetadata("olympiad"),
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
                    ...pumacDivisionMetadata("TEAM"),
                    ...pumacSubjectMetadata(null, null),
                };
            }
            if (L !== "A" && L !== "B") return null;
            const subj = PUMAC_SUBJECTS[subject?.toLowerCase()];
            if (!subj) return null;
            return {
                name: `${year} PUMaC ${L} ${subj.label}`,
                year,
                section: -1,
                sectionName: null,
                seriesName: "PUMAC",
                ...pumacDivisionMetadata(L),
                ...pumacSubjectMetadata(subj.label, subj.order),
            };
        },
    },
    bmt: {
        seriesName: "BMT",
        isOfficial: true,
        isComputational: true,
        // Folder is "<division>_<year>_<format>" (division may hyphenate, e.g.
        // "bmmt-online"). The division (BMT/BMMT/BMMT Online) rides on the
        // `division` axis; the round/subject rides on `format`.
        // "bmt_2024_algebra"      -> "2024 BMT Algebra"
        // "bmmt_2012_individual"  -> "2012 BMMT Individual"
        parseTest(folder) {
            const [divToken, yearStr, ...rest] = folder.split("_");
            const year = Number(yearStr);
            const fmtToken = rest.join("_");
            if (!Number.isInteger(year) || !fmtToken) return null;
            const div = bmtDivisionMetadata(divToken);
            const fmt = bmtFormatMetadata(fmtToken);
            if (!div.division || !fmt.format) return null;
            return {
                name: `${year} ${div.division} ${fmt.format}`,
                year,
                section: -1,
                sectionName: null,
                ...div,
                ...fmt,
            };
        },
    },
    smt: {
        seriesName: "SMT",
        isOfficial: true,
        isComputational: true,
        // Folder is "<DIVISION>_<year>_<format>". The division (ASMT/SM3/SMT)
        // rides on the `division` axis; the subject rides on `format`, and a
        // "<subject>-tiebreaker" folder becomes a "<Subject> Tiebreaker" format.
        // "SMT_2024_algebra"          -> "2024 SMT Algebra"
        // "ASMT_2015_algebra-tiebreaker" -> "2015 ASMT Algebra Tiebreaker"
        parseTest(folder) {
            const [divToken, yearStr, ...rest] = folder.split("_");
            const year = Number(yearStr);
            const fmtToken = rest.join("_");
            if (!Number.isInteger(year) || !fmtToken) return null;
            const div = smtDivisionMetadata(divToken);
            const fmt = smtFormatMetadata(fmtToken);
            if (!div.division || !fmt.format) return null;
            return {
                name: `${year} ${div.division} ${fmt.format}`,
                year,
                section: -1,
                sectionName: null,
                ...div,
                ...fmt,
            };
        },
    },
};

function titleCase(word) {
    return word ? word[0].toUpperCase() + word.slice(1) : word;
}

// Confidence policy for auto-linking duplicate groups (matches the plan):
//   similarity >= 1.0            -> auto-accept
//   0.85 <= similarity < 1.0     -> needs_review (a human accepts/rejects)
//   similarity < 0.85            -> ignored (no link)
const DUP_ACCEPT_THRESHOLD = 1.0;
const DUP_REVIEW_THRESHOLD = 0.85;

function linkStatusForSimilarity(similarity) {
    const sim = Number(similarity);
    if (!Number.isFinite(sim)) return "needs_review"; // unknown score -> be safe
    if (sim >= DUP_ACCEPT_THRESHOLD) return "accepted";
    if (sim >= DUP_REVIEW_THRESHOLD) return "needs_review";
    return null; // below review threshold: skip
}

// Trust rank of a problem row's resolved statement source (verified > pdf > wiki
// > aops), used to pick the canonical member of a duplicate group — the one whose
// content becomes the shared source of truth.
function statementSourceRank(row) {
    if (!row) return -1;
    if (row.verified) return 4;
    if (row.pdf_statement != null) return 3;
    if (row.wiki_statement != null) return 2;
    if (row.aops_statement != null) return 1;
    return 0;
}

function isDir(p) {
    return existsSync(p) && statSync(p).isDirectory();
}

function readJson(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

// OCR problem/solution keys are 1-based; DB `n` is 0-based. Returns the 0-based
// n, or null (with a warning) for a non-numeric key.
function ocrKeyToN(key, kind, where) {
    const n = Number(key) - 1;
    if (!Number.isInteger(n) || n < 0) {
        console.warn(`  skip non-numeric ${kind} key "${key}" in ${where}`);
        return null;
    }
    return n;
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
                // Series default, overridable per test where a single series
                // mixes formats (e.g. MPFG: computational Math Prize vs.
                // proof-based Olympiad). Mirrors the seriesName override above.
                const isComputational =
                    meta.isComputational ?? cfg.isComputational;
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
                        isComputational,
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
                    const n = ocrKeyToN(
                        key,
                        "problem",
                        `${seriesFolder}/${testFolder}`,
                    );
                    if (n === null) continue;
                    const problemId = upsertPdfProblem(
                        db,
                        {
                            n,
                            statement: problems[key],
                            answer: answers[key] ?? null,
                            source: `${seriesFolder}/${testFolder}`,
                            is_computational: isComputational,
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
                    const n = ocrKeyToN(
                        key,
                        "solution",
                        `${seriesFolder}/${testFolder}`,
                    );
                    if (n === null) continue;
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

// Resolve a comp-OCR duplicates.json member { test, problem } to an existing
// problems.id. Returns null (no error) when the member's series/test/problem row
// hasn't been imported yet — dup linking is additive and can run after imports.
function resolveDuplicateMember(db, cfg, seriesIdCache, member) {
    const meta = cfg.parseTest(member.test);
    if (meta == null) return null;
    const seriesName = meta.seriesName ?? cfg.seriesName;
    let seriesId = seriesIdCache.get(seriesName);
    if (seriesId === undefined) {
        const row = db
            .query(`SELECT id FROM series WHERE name = ?`)
            .get(seriesName);
        seriesId = row ? row.id : null;
        seriesIdCache.set(seriesName, seriesId);
    }
    if (seriesId == null) return null;
    const testId = resolveTestId(db, {
        aopsCategoryId: null,
        section: meta.section ?? -1,
        seriesId,
        year: meta.year ?? null,
        name: meta.name,
    });
    if (testId == null) return null;
    const n = ocrKeyToN(member.problem, "duplicate", member.test);
    if (n === null) return null;
    return resolveProblemId(db, { testId, n });
}

// Ingests comp-OCR `duplicates.json` files (out/<series>/duplicates.json) into
// problem_links. Each group's members are the same real-world problem appearing
// under different tests (e.g. Mandelbrot N/R versions, PUMAC A/B rounds). One
// member is chosen canonical (best statement source, then lowest test_id/n) and
// every other resolved member is linked to it. The group `similarity` drives the
// confidence policy (exact -> accepted, near -> needs_review, low -> skipped).
//
// Additive and idempotent: reuses upsertProblemLink, which preserves any manual
// curation. `options.series` narrows which OCR series folders are processed.
export function importDuplicates(db, outDir, options = {}) {
    if (!isDir(outDir)) {
        throw new Error(`OCR output dir not found: ${outDir}`);
    }
    const seriesFilter =
        options.series?.length > 0 ? new Set(options.series) : null;

    const summary = {
        files: 0,
        groups: 0,
        linked: 0,
        needsReview: 0,
        skipped: 0,
        unresolved: 0,
    };

    db.transaction(() => {
        for (const seriesFolder of readdirSync(outDir)) {
            if (seriesFolder.startsWith("_")) continue;
            if (seriesFilter && !seriesFilter.has(seriesFolder)) continue;
            const cfg = SERIES_CONFIG[seriesFolder];
            const seriesPath = join(outDir, seriesFolder);
            if (!cfg || !isDir(seriesPath)) continue;

            const dupPath = join(seriesPath, "duplicates.json");
            const doc = readJson(dupPath);
            if (!doc || !Array.isArray(doc.groups)) continue;
            summary.files++;

            const seriesIdCache = new Map(); // seriesName -> id | null
            const rankStmt = db.query(
                `SELECT id, test_id, n, verified, pdf_statement, wiki_statement, aops_statement
                 FROM problems WHERE id = ?`,
            );

            for (const group of doc.groups) {
                summary.groups++;
                const status = linkStatusForSimilarity(group.similarity);
                if (status === null) {
                    summary.skipped++;
                    continue;
                }

                // Resolve every member to a problem row (skipping the unresolved).
                const resolved = [];
                for (const member of group.members ?? []) {
                    const pid = resolveDuplicateMember(
                        db,
                        cfg,
                        seriesIdCache,
                        member,
                    );
                    if (pid == null) {
                        summary.unresolved++;
                        continue;
                    }
                    resolved.push(rankStmt.get(pid));
                }
                if (resolved.length < 2) {
                    // Nothing to link (0/1 members present in the DB).
                    if (resolved.length <= 1 && (group.members?.length ?? 0) >= 2)
                        summary.skipped++;
                    continue;
                }

                // Canonical = best statement source, then lowest (test_id, n).
                const canonical = resolved.slice().sort((a, b) => {
                    const dr = statementSourceRank(b) - statementSourceRank(a);
                    if (dr !== 0) return dr;
                    if (a.test_id !== b.test_id) return a.test_id - b.test_id;
                    return a.n - b.n;
                })[0];

                for (const row of resolved) {
                    if (row.id === canonical.id) continue;
                    const outcome = upsertProblemLink(db, {
                        problemId: row.id,
                        canonicalProblemId: canonical.id,
                        source: "pdf_duplicates",
                        similarity: group.similarity ?? null,
                        scope: group.scope ?? null,
                        status,
                    });
                    if (outcome === "inserted" || outcome === "updated") {
                        if (status === "accepted") summary.linked++;
                        else summary.needsReview++;
                    }
                }
            }
        }
    })();

    return summary;
}
