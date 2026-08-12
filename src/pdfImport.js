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
import { normalizePdfStatement } from "./textAudit.js";
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
    farmlFormatMetadata,
    omoSeasonMetadata,
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
    omo: {
        seriesName: "OMO",
        isOfficial: true,
        isComputational: true,
        // "2014_spring" -> "2014 OMO Spring"; "2012_fall" -> "2012 OMO Fall".
        // One OCR folder is one contest, and the season is the only axis: each
        // OMO is a single undivided round of numeric-answer problems, so
        // `format` stays NULL (and topicPolicy keeps the per-statement
        // heuristic, there being no round whose subject could be declared).
        //
        // The folder year is the year the contest was ADMINISTERED, matching the
        // packet headers ("September/October 2012 — Fall OMO 2012-2013",
        // "January 2013 — Winter OMO 2012-2013"), not the school year those
        // headers span. The January contests are 50 problems, Fall/Spring 30;
        // that is not encoded anywhere because nothing keys off it.
        parseTest(folder) {
            const [yearStr, season, ...extra] = folder.split("_");
            const year = Number(yearStr);
            if (!Number.isInteger(year) || extra.length > 0) return null;
            const sea = omoSeasonMetadata(season);
            if (!sea.division) return null;
            return {
                name: `${year} OMO ${sea.division}`,
                year,
                section: -1,
                sectionName: null,
                ...sea,
            };
        },
    },
    farml: {
        seriesName: "FARML",
        // A mock ARML (the 2018 packet's own footnote: "F for Fake"), so the
        // series sits with the other mocks. Its solutions are still written by
        // the contest author and shipped in the packet, so they auto-accept —
        // the two facts diverge here, which is why they are separate keys.
        isOfficial: false,
        solutionsOfficial: true,
        isComputational: true,
        // "2024" -> the 2024 packet; "2016_team"/"2016_indy"/"2016_relay" are
        // the 2016 packet OCR'd as three folders. All of them carry the SAME
        // global problem numbering (2016_indy is keyed 11-20), so the year is
        // the only thing the folder name has to yield — which round a problem
        // belongs to comes from its number, via splitTests below.
        parseTest(folder) {
            const year = Number(folder.split("_")[0]);
            if (!Number.isInteger(year)) return null;
            return {
                name: `${year} FARML`,
                year,
                section: -1,
                sectionName: null,
            };
        },
        splitTests(folder) {
            const base = this.parseTest(folder);
            if (base == null) return null;
            return FARML_ROUNDS.map((round) => ({
                meta: {
                    ...base,
                    name: `${base.year} FARML ${farmlFormatMetadata(round.token).format}`,
                    ...farmlFormatMetadata(round.token),
                },
                offset: round.from - 1,
                owns: (key) => {
                    const num = Number(key);
                    return (
                        Number.isInteger(num) &&
                        num >= round.from &&
                        num <= round.to
                    );
                },
                coverageForKey: round.coverageForKey,
            }));
        },
    },
};

// FARML's events, keyed by the packet's global problem numbering (verified
// stable across 2016-2026): T1-T10 -> 1-10, I1-I10 -> 11-20, R1/1-R2/3 ->
// 21-26, Tiebreaker 1/2 -> 27-28. Each round's problems are renumbered from its
// own `from`, so Individual's I1 lands on n = 0 like any other test's first
// problem. The tiebreaker round is open-ended because some years print one and
// some print two.
const FARML_RELAY_FIRST = 21;
const FARML_RELAY_CHAIN = 3;
const FARML_ROUNDS = [
    { token: "team", from: 1, to: 10 },
    { token: "individual", from: 11, to: 20 },
    {
        token: "relay",
        from: FARML_RELAY_FIRST,
        to: 26,
        // Every relay problem but the head of its chain begins "Let T = TNYWR"
        // — its answer depends on the previous link's, which a problem served
        // on its own does not have. That is a structural fact about the round
        // (positions 2 and 3 of each 3-problem chain), NOT something to detect
        // in the statement: the 2023 OCR lost the TNYWR prefix on #22, which
        // still reads "$\sec A = T$" and is just as unanswerable alone.
        // The answer stays (it is correct, and answer_status resolves to
        // `known`); `interactive` is what tells a grader to skip it.
        coverageForKey(key) {
            const chainPosition = (Number(key) - FARML_RELAY_FIRST) % FARML_RELAY_CHAIN;
            return chainPosition === 0 ? null : { response_kind: "interactive" };
        },
    },
    { token: "tiebreaker", from: 27, to: Infinity },
];

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

                const folderMeta = cfg.parseTest(testFolder);
                if (folderMeta == null) {
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

                // An OCR folder is normally one test. A series whose packet
                // bundles several rounds under one cover (FARML) supplies
                // `splitTests`, slicing the folder's problem numbering into one
                // group per round; `wholeFolderGroup` is the identity slice
                // every other series gets, so one import path serves both.
                const groups = cfg.splitTests?.(testFolder) ?? [
                    wholeFolderGroup(folderMeta),
                ];

                for (const group of groups) {
                    const meta = group.meta;
                    // A round can be absent from a packet (FARML's second
                    // tiebreaker in a 27-problem year) and the 2016 folders each
                    // hold one round's slice, so most groups are empty for most
                    // folders. Skip them instead of materializing a test row
                    // with nothing in it.
                    const ownsAny =
                        Object.keys(problems).some((key) => group.owns(key)) ||
                        Object.keys(answers).some((key) => group.owns(key));
                    if (!ownsAny) continue;

                    const seriesName = meta.seriesName ?? cfg.seriesName;
                    // Series default, overridable per test where a single series
                    // mixes formats (e.g. MPFG: computational Math Prize vs.
                    // proof-based Olympiad). Mirrors the seriesName override
                    // above. This stays the RAW config value. The coverage-aware
                    // value is derived at read time by isComputationalFor(), so a
                    // later AoPS re-scrape writing its own guess here cannot
                    // regress it.
                    const isComputational =
                        meta.isComputational ?? cfg.isComputational;
                    let seriesId = seriesIds.get(seriesName);
                    if (seriesId == null) {
                        seriesId = upsertSeries(
                            db,
                            seriesName,
                            -1,
                            cfg.isOfficial,
                        );
                        seriesIds.set(seriesName, seriesId);
                        summary.series++;
                    }

                    const counts = importTestGroup(db, {
                        cfg,
                        group,
                        where,
                        problems,
                        answers,
                        solutions,
                        profileFile,
                        coverageFile,
                        seriesId,
                        isComputational,
                    });

                    summary.tests++;
                    summary.problems += counts.problems;
                    summary.answersOnly += counts.answersOnly;
                    summary.droppedAnswers += counts.droppedAnswers;
                    summary.solutions += counts.solutions;
                }
            }
        }
    })();

    return summary;
}

// The identity slice: one OCR folder is one test, keeping the folder's own
// 1-based problem numbering. Used for every series that does not define
// `splitTests`.
function wholeFolderGroup(meta) {
    return { meta, offset: 0, owns: () => true, coverageForKey: null };
}

// Imports one test's worth of an OCR folder: the whole folder for most series,
// one round of a bundled packet for a `splitTests` series. `group.owns(key)`
// selects the OCR keys that belong to this test and `group.offset` shifts them
// onto its own 0-based `n`, so a round that starts at the packet's problem 11
// still stores its first problem as n = 0.
//
// Returns the counts the caller folds into the run summary.
function importTestGroup(db, ctx) {
    const {
        cfg,
        group,
        where,
        problems,
        answers,
        solutions,
        profileFile,
        coverageFile,
        seriesId,
        isComputational,
    } = ctx;
    const meta = group.meta;

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
            // Only pass these when a profile was actually read — upsertTest keys
            // off presence, so an absent profile must leave any existing value
            // alone rather than asserting NULL over it.
            ...(profileFile.state === "present" &&
            profileFile.value.response_kind !== undefined
                ? { responseKind: profileFile.value.response_kind }
                : {}),
            ...(profileFile.state === "present" &&
            profileFile.value.answer_status !== undefined
                ? { answerStatus: profileFile.value.answer_status }
                : {}),
            // Section structure is scraper-owned; PDF import must not rewrite
            // section/section_name on an existing row.
            updateSection: false,
        },
        seriesId,
    );

    // Resolve against state after the profile upsert. This matters when the
    // current file is absent/invalid: its stored declaration remains
    // authoritative for answer retraction.
    const declaration = db
        .query(`SELECT response_kind, answer_status FROM tests WHERE id = ?`)
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

    // The OCR key -> this test's 0-based n. Non-numeric keys warn and drop.
    const nFor = (key, kind) => {
        const n = ocrKeyToN(key, kind, where);
        return n === null ? null : n - group.offset;
    };

    // Coverage keys are the OCR's 1-based numbers, same as `problems`/`answers`,
    // so they index by `key` not `n`.
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
            existingValue: existingCoverage?.coverage_response_kind,
        });
        const answerStatus = coverageSnapshotField({
            file: coverageFile,
            entry: snapshotEntry,
            field: "answer_status",
            existingValue: existingCoverage?.coverage_answer_status,
        });
        // A structural declaration (a FARML relay link, whose statement depends
        // on the previous link's answer) is a property of the round, known from
        // the problem's position in the packet. It applies only where the OCR
        // folder's coverage file says nothing: that file is a claim about this
        // specific problem and outranks a rule about its round.
        const structural = group.coverageForKey?.(key) ?? null;
        for (const [field, resolved] of [
            ["response_kind", responseKind],
            ["answer_status", answerStatus],
        ]) {
            if (resolved.value == null && structural?.[field] != null) {
                resolved.value = structural[field];
                resolved.update = true;
            }
        }
        const resolvedCoverage = resolveCoverage({
            overrideResponseKind: responseKind.value,
            declarationResponseKind: declaration?.response_kind ?? null,
            overrideAnswerStatus: answerStatus.value,
            declarationAnswerStatus: declaration?.answer_status ?? null,
            rawIsComputational: isComputational,
        });
        return {
            // Stored on the override tier only: NULL here means no source named
            // this problem, never "it inherited the test's declaration".
            ...(responseKind.update
                ? { coverage_response_kind: responseKind.value }
                : {}),
            ...(answerStatus.update
                ? { coverage_answer_status: answerStatus.value }
                : {}),
            // Clearing a stale answer must follow the RESOLVED verdict, since
            // the claim usually lives on the test row (a proof profile) rather
            // than the override.
            answerNotApplicable:
                resolvedCoverage.answerStatus === "not_applicable",
        };
    };

    let count = 0;
    const problemIdByN = new Map(); // n -> problem id, for attaching solutions
    for (const key of Object.keys(problems)) {
        if (!group.owns(key)) continue;
        const n = nFor(key, "problem");
        if (n === null) continue;
        const problemId = upsertPdfProblem(
            db,
            {
                n,
                statement: normalizePdfStatement(problems[key]),
                answer: answers[key] ?? null,
                source: where,
                is_computational: isComputational,
                ...coverageFor(key, n),
            },
            testId,
        );
        problemIdByN.set(n, problemId);
        count++;
    }

    // An answer key covers the whole test, so it routinely names problems the
    // OCR dropped a statement for. Those answers are still good, and another
    // tier (usually an AoPS scrape) has often already supplied the statement, so
    // apply them to the existing row instead of letting them fall on the floor.
    // Update-only: with no statement there is nothing to insert.
    let answerOnly = 0;
    const orphanedAnswers = [];
    for (const key of Object.keys(answers)) {
        if (!group.owns(key)) continue;
        if (key in problems) continue;
        const answer = answers[key];
        if (answer == null || answer === "") continue;
        const n = nFor(key, "answer");
        if (n === null) continue;
        const problemId = upsertPdfAnswerOnly(
            db,
            {
                n,
                answer,
                source: where,
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

    // Attach OCR'd solutions to the problems just upserted. Keys are 1-based
    // like problems; each value is an array of solution strings. Dedup (exact +
    // near) is handled downstream by upsertSolutionCandidate / classifySolutions.
    let solCount = 0;
    for (const key of Object.keys(solutions)) {
        if (!group.owns(key)) continue;
        const n = nFor(key, "solution");
        if (n === null) continue;
        const problemId = problemIdByN.get(n);
        if (problemId == null) continue; // solution with no matching problem
        const list = solutions[key];
        if (!Array.isArray(list)) continue;
        for (const solStr of list) {
            if (typeof solStr !== "string" || !solStr.trim()) continue;
            upsertSolutionCandidate(db, {
                problemId,
                source: "import",
                content: solStr,
                content_format: "markdown_latex",
                // Contests whose packet ships author-written solutions
                // auto-accept; others enter as candidates for the classifier to
                // score-gate. Defaults to the series' own official flag, which a
                // series overrides where the two diverge (FARML: a mock contest,
                // but its solutions are the author's).
                is_official: cfg.solutionsOfficial ?? cfg.isOfficial,
                // sourceKey omitted -> getSourceKey falls back to
                // `import:<contentHash>`, deduping identical source rows and
                // making re-import idempotent.
            });
            solCount++;
        }
    }

    console.log(
        `  ${meta.name}: ${count} problems, ${solCount} solutions` +
            (answerOnly > 0 ? `, ${answerOnly} answers-only` : ""),
    );

    return {
        problems: count,
        answersOnly: answerOnly,
        droppedAnswers: orphanedAnswers.length,
        solutions: solCount,
    };
}

// Resolve a comp-OCR duplicates.json member { test, problem } to an existing
// problems.id. Returns null (no error) when the member's series/test/problem row
// hasn't been imported yet — dup linking is additive and can run after imports.
function resolveDuplicateMember(db, cfg, seriesIdCache, member) {
    const folderMeta = cfg.parseTest(member.test);
    if (folderMeta == null) return null;
    // A duplicates.json member names an OCR folder plus a problem number. For a
    // series whose folder holds several rounds, the number is what picks the
    // test, so route it through the same groups the import used — otherwise this
    // resolves the folder-level name, which is not a row that exists.
    const group = cfg.splitTests
        ? cfg
              .splitTests(member.test)
              ?.find((g) => g.owns(String(member.problem)))
        : wholeFolderGroup(folderMeta);
    if (group == null) return null;
    const meta = group.meta;
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
    return resolveProblemId(db, { testId, n: n - group.offset });
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
