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
    upsertPdfAnswerOnly,
    upsertSolutionCandidate,
    resolveTestId,
    resolveProblemId,
    upsertProblemLink,
} from "./db.js";
import {
    readTestProfile,
    readProblemCoverage,
    resolveCoverage,
} from "./coverage.js";
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
    splitBmtRegion,
    smtDivisionMetadata,
    smtFormatMetadata,
    cmimcDivisionMetadata,
    cmimcFormatMetadata,
    chmmcSeasonMetadata,
    chmmcFormatMetadata,
} from "./testMetadata.js";

const PURPLE_LEVELS = { HS: "High School", MS: "Middle School" };

const HMMT_MONTHS = { feb: "February", nov: "November" };

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
        // "2000_national_cdr" / "2024_state_countdown" -> "… Countdown"
        // The name is built from the resolved labels rather than the raw folder
        // tokens, so the two Countdown spellings land on one test name (and one
        // test) instead of a "Cdr"/"Countdown" pair.
        parseTest(folder) {
            const [year, division, format] = folder.split("_");
            const meta = mathcountsTestMetadata(division, format);
            if (!Number.isInteger(Number(year))) return null;
            if (!meta.division || !meta.format) return null;
            return {
                name: `${year} MATHCOUNTS ${meta.division} ${meta.format}`,
                year: Number(year),
                section: -1,
                sectionName: null,
                ...meta,
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
                    ...hmmtRoundMetadata(null),
                };
            }
            const month = HMMT_MONTHS[monthOrKind?.toLowerCase()];
            const roundMeta = hmmtRoundMetadata(round);
            if (!month || !roundMeta.format) return null;
            const seriesName = month === "November" ? "HMMT November" : "HMMT";
            return {
                name: `${year} HMMT ${month} ${roundMeta.format}`,
                year,
                section: -1,
                sectionName: null,
                seriesName,
                ...hmmtSeasonMetadata(monthOrKind),
                ...roundMeta,
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
                    ...pumacSubjectMetadata(null),
                };
            }
            if (L !== "A" && L !== "B") return null;
            const subj = pumacSubjectMetadata(subject);
            if (!subj.format) return null;
            return {
                name: `${year} PUMaC ${L} ${subj.format}`,
                year,
                section: -1,
                sectionName: null,
                seriesName: "PUMAC",
                ...pumacDivisionMetadata(L),
                ...subj,
            };
        },
    },
    bmt: {
        seriesName: "BMT",
        isOfficial: true,
        isComputational: true,
        // Folder is "<division>_<year>_<format>" (division may hyphenate, e.g.
        // "bmmt-online"). The division (BMT/BMMT/BMMT Online) rides on the
        // `division` axis; the round/subject rides on `format`. The format token
        // may carry a "-tiebreaker" and/or a trailing regional edition, the
        // latter folding into the division (see splitBmtRegion).
        // "bmt_2024_algebra"           -> "2024 BMT Algebra"
        // "bmmt_2012_individual"       -> "2012 BMMT Individual"
        // "bmt_2020_calculus-tiebreaker" -> "2020 BMT Calculus Tiebreaker"
        // "bmmt_2019_team-us-iran"     -> "2019 BMMT US/Iran Team"
        parseTest(folder) {
            const [divToken, yearStr, ...rest] = folder.split("_");
            const year = Number(yearStr);
            const { formatToken, regionToken } = splitBmtRegion(rest.join("_"));
            if (!Number.isInteger(year) || !formatToken) return null;
            const div = bmtDivisionMetadata(divToken, regionToken);
            const fmt = bmtFormatMetadata(formatToken);
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
    cmimc: {
        seriesName: "CMIMC",
        isOfficial: true,
        isComputational: true,
        parseTest(folder) {
            const [yearToken, divisionToken, formatToken] = folder.split("_");
            const year = Number(yearToken);
            const div = cmimcDivisionMetadata(divisionToken);
            const fmt = cmimcFormatMetadata(formatToken);

            if (!Number.isInteger(year) || !div.division || !fmt.format)
                return null;

            return {
                name: `${year} CMIMC ${div.division} ${fmt.format}`,
                year,
                section: -1,
                sectionName: null,
                ...div,
                ...fmt,
            };
        },
    },
    chmm: {
        seriesName: "CHMMC",
        isOfficial: true,
        isComputational: true,
        parseTest(folder) {
            const [yearToken, seasonToken, formatToken, ...rest] =
                folder.split("_");
            const year = Number(yearToken);
            const sea = chmmcSeasonMetadata(seasonToken);
            const formatKey = [formatToken, ...rest].join("-");
            const fmt = chmmcFormatMetadata(formatKey);

            if (!Number.isInteger(year) || !sea.division || !fmt.format)
                return null;

            return {
                name: `${year} ${sea.division} CHMMC ${fmt.format}`,
                year,
                section: -1,
                sectionName: null,
                ...sea,
                ...fmt,
            };
        },
    },
};

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

// Resolve one field from an optional authoritative coverage snapshot. Absent or
// invalid files preserve stored state; an omitted entry in a present map clears
// it; an invalid field value preserves only that field.
function coverageSnapshotField({
    file,
    entry,
    field,
    existingValue,
}) {
    if (file.state !== "present") {
        return { value: existingValue ?? null, update: false };
    }
    if (entry == null) return { value: null, update: true };
    if (entry[field] === undefined) {
        return { value: existingValue ?? null, update: false };
    }
    return { value: entry[field], update: true };
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
// transaction. Returns a summary { series, tests, problems, answersOnly,
// droppedAnswers, solutions } of what was upserted. `answersOnly` counts answers
// applied to rows the OCR produced no statement for; `droppedAnswers` counts
// those that had no row to land on at all (see the answer-only pass below).
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

    const summary = {
        series: 0,
        tests: 0,
        problems: 0,
        answersOnly: 0,
        droppedAnswers: 0,
        solutions: 0,
    };

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

                // Source-backed coverage semantics. The profile DECLARES the
                // test (present only for proof families); coverage is a sparse
                // per-problem exception map. Both are stored as-is, on their
                // own tier — resolving them into a single per-problem verdict
                // is buildProductionProblems' job. See src/coverage.js.
                const where = `${seriesFolder}/${testFolder}`;
                const profileFile = readTestProfile(testPath, where);
                const coverageFile = readProblemCoverage(testPath, where);

                const seriesName = meta.seriesName ?? cfg.seriesName;
                // Series default, overridable per test where a single series
                // mixes formats (e.g. MPFG: computational Math Prize vs.
                // proof-based Olympiad). Mirrors the seriesName override above.
                // This stays the RAW config value. The coverage-aware value is
                // derived at read time by isComputationalFor(), so a later
                // AoPS re-scrape writing its own guess here cannot regress it.
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
                        // Only pass these when a profile was actually read —
                        // upsertTest keys off presence, so an absent profile
                        // must leave any existing value alone rather than
                        // asserting NULL over it.
                        ...(profileFile.state === "present" &&
                        profileFile.value.response_kind !== undefined
                            ? {
                                  responseKind:
                                      profileFile.value.response_kind,
                              }
                            : {}),
                        ...(profileFile.state === "present" &&
                        profileFile.value.answer_status !== undefined
                            ? {
                                  answerStatus:
                                      profileFile.value.answer_status,
                              }
                            : {}),
                        // Section structure is scraper-owned; PDF import must
                        // not rewrite section/section_name on an existing row.
                        updateSection: false,
                    },
                    seriesId,
                );
                summary.tests++;

                // Resolve against state after the profile upsert. This matters
                // when the current file is absent/invalid: its stored declaration
                // remains authoritative for answer retraction.
                const declaration = db
                    .query(
                        `SELECT response_kind, answer_status FROM tests WHERE id = ?`,
                    )
                    .get(testId);
                const existingCoverageByN = new Map(
                    db
                        .query(
                            `SELECT n, coverage_response_kind, coverage_answer_status
                             FROM problems WHERE test_id = ? AND section = -1`,
                        )
                        .all(testId)
                        .map((row) => [row.n, row]),
                );

                // Coverage keys are the OCR's 1-based numbers, same as
                // `problems`/`answers`, so they index by `key` not `n`.
                const coverageFor = (key, n) => {
                    const existingCoverage = existingCoverageByN.get(n);
                    const snapshotEntry =
                        coverageFile.state === "present"
                            ? coverageFile.value[key]
                            : undefined;
                    const responseKind = coverageSnapshotField({
                        file: coverageFile,
                        entry: snapshotEntry,
                        field: "response_kind",
                        existingValue:
                            existingCoverage?.coverage_response_kind,
                    });
                    const answerStatus = coverageSnapshotField({
                        file: coverageFile,
                        entry: snapshotEntry,
                        field: "answer_status",
                        existingValue:
                            existingCoverage?.coverage_answer_status,
                    });
                    const resolved = resolveCoverage({
                        overrideResponseKind: responseKind.value,
                        declarationResponseKind:
                            declaration?.response_kind ?? null,
                        overrideAnswerStatus: answerStatus.value,
                        declarationAnswerStatus:
                            declaration?.answer_status ?? null,
                        rawIsComputational: isComputational,
                    });
                    return {
                        // Stored on the override tier only: NULL here means no
                        // source named this problem, never "it inherited the
                        // test's declaration".
                        ...(responseKind.update
                            ? { coverage_response_kind: responseKind.value }
                            : {}),
                        ...(answerStatus.update
                            ? { coverage_answer_status: answerStatus.value }
                            : {}),
                        // Clearing a stale answer must follow the RESOLVED
                        // verdict, since the claim usually lives on the test
                        // row (a proof profile) rather than the override.
                        answerNotApplicable:
                            resolved.answerStatus === "not_applicable",
                    };
                };

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
                            ...coverageFor(key, n),
                        },
                        testId,
                    );
                    problemIdByN.set(n, problemId);
                    count++;
                }

                // An answer key covers the whole test, so it routinely names
                // problems the OCR dropped a statement for. Those answers are
                // still good, and another tier (usually an AoPS scrape) has
                // often already supplied the statement, so apply them to the
                // existing row instead of letting them fall on the floor.
                // Update-only: with no statement there is nothing to insert.
                let answerOnly = 0;
                const orphanedAnswers = [];
                for (const key of Object.keys(answers)) {
                    if (key in problems) continue;
                    const answer = answers[key];
                    if (answer == null || answer === "") continue;
                    const n = ocrKeyToN(
                        key,
                        "answer",
                        `${seriesFolder}/${testFolder}`,
                    );
                    if (n === null) continue;
                    const problemId = upsertPdfAnswerOnly(
                        db,
                        {
                            n,
                            answer,
                            source: `${seriesFolder}/${testFolder}`,
                            is_computational: isComputational,
                            ...coverageFor(key, n),
                        },
                        testId,
                    );
                    if (problemId == null) {
                        orphanedAnswers.push(key);
                        continue;
                    }
                    problemIdByN.set(n, problemId);
                    answerOnly++;
                }
                if (answerOnly > 0) {
                    console.warn(
                        `  ${meta.name}: applied ${answerOnly} answer(s) with no OCR statement — problems.json is missing them, check the OCR`,
                    );
                }
                if (orphanedAnswers.length > 0) {
                    console.warn(
                        `  ${meta.name}: dropped ${orphanedAnswers.length} answer(s) with no statement from any source (problems ${orphanedAnswers.join(", ")}) — re-run the OCR for this test`,
                    );
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
                summary.answersOnly += answerOnly;
                summary.droppedAnswers += orphanedAnswers.length;
                summary.solutions += solCount;
                console.log(
                    `  ${meta.name}: ${count} problems, ${solCount} solutions` +
                        (answerOnly > 0 ? `, ${answerOnly} answers-only` : ""),
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
