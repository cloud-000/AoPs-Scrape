#!/usr/bin/env bun
import { confirm, select, search, checkbox, input } from "@inquirer/prompts";
import * as ENV_CONFIG from "../.env.js";
import { ApiMethod, ForumSession } from "../src/ForumSession.js";
import { WikiSession } from "../src/WikiSession.js";
import { ResponseCache } from "../src/ResponseCache.js";
import { CONTEST_IDS } from "../contest_id.js";
import { createScrapeProgress, formatDuration } from "./progress.js";
import {
    initDB,
    upsertScrapeResults,
    upsertWikiResults,
    buildProductionProblems,
} from "../src/db.js";
import {
    exportProductionCSV,
    exportProductionSQL,
    exportStagingSQL,
    exportRatingSeedsSQL,
} from "../src/export.js";
import { unlinkSync, existsSync } from "node:fs";

const { ENV, PDF_DATA_DIR, MODEL_URL, MODEL_ID, MODEL_REVISION, MODEL_API_KEY } =
    ENV_CONFIG;

const DB_PATH = process.env.AOPS_DB_PATH ?? "./aops_problems.sqlite";

function getArgFlag(name) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((a) => a.startsWith(prefix));
    if (hit) return hit.slice(prefix.length).trim();
    return null;
}

function hasArgFlag(name) {
    if (name === "yes") {
        return (
            process.argv.includes("--yes") ||
            process.argv.includes("-y") ||
            process.argv.includes("--non-interactive")
        );
    }
    return (
        process.argv.includes(`--${name}`) ||
        process.argv.includes(`-${name}`)
    );
}

async function promptConfirm(options) {
    if (hasArgFlag("yes")) {
        return options.default ?? true;
    }
    if (!process.stdin.isTTY) {
        return options.default ?? true;
    }
    return await confirm(options);
}

const command = process.argv[2];

let ALL_CONTESTS;
async function main() {
    ALL_CONTESTS = [
        ...CONTEST_IDS["MAA"],
        ...CONTEST_IDS["CollegeComp"],
        ...CONTEST_IDS["Other"],
        ...CONTEST_IDS["UserContestSeries"],
        ...CONTEST_IDS["UserMocks"],
    ].filter((c) => c.id); // only filter out entries without a plain .id (like ZeMC with ids[])

    let data;
    switch (command) {
        case "scrape": {
            let user = await getUser();
            let session = new ForumSession(
                user["logged-in"],
                user["user-id"],
                user["session-id"],
                user["headers"] || null,
            );
            // ForumSession.log() also dumps every forum item, so it stays off
            // unless asked for; retry/challenge warnings bypass it via onEvent.
            session.debug = hasArgFlag("debug") || hasArgFlag("verbose");
            const progress = attachProgress(session);
            const { contest: selectedContest, id } = await autoSearch(
                "Enter id: ",
                ALL_CONTESTS,
            );

            session.enableStickyAnswerKey = true;

            let method = await getMethod(selectedContest);
            const useResponseCache =
                hasArgFlag("cache") ||
                (!hasArgFlag("no-cache") &&
                    (await promptConfirm({
                        message: "Use response cache?",
                        default: false,
                    })));
            session.cache = new ResponseCache("./response_cache", {
                readEnabled: useResponseCache,
            });
            if (useResponseCache) {
                console.log("Response cache enabled (./response_cache)");
            } else {
                console.log(
                    "Response cache reads disabled; successful topic responses will still be archived.",
                );
            }
            if (!(await promptConfirm({ message: `Confirm ${id}?` }))) {
                console.log("Exiting");
                break;
            }
            // Collect any interactive input (e.g. picking one test out of a
            // series) BEFORE the progress region starts — its repaint otherwise
            // paints over these prompts. `gather` returning null signals a bail.
            const methodArgs = await method.gather(session, id);
            if (methodArgs === null) {
                console.log("Exiting");
                break;
            }
            progress.start();
            let startTime = Date.now();
            try {
                data = await method.run(session, id, methodArgs);
            } finally {
                // Always tear the region down, or a thrown error prints into
                // the live block and gets erased by the pending repaint.
                progress.stop();
            }
            let elapsedTime = Date.now() - startTime;
            console.log(
                `Collected ${data.count} problems in ${formatDuration(elapsedTime)} from ${id}`,
            );
            reportProgress(progress);
            if (!hasArgFlag("yes") && (await promptConfirm({ message: "Log Data?", default: false }))) {
                console.log(data);
            }
            // SQLite is the source of truth. A raw JSON dump is optional and only
            // for debugging / re-import — pass `--dump` or `--dump=<file>`.
            const dumpFile = parseDumpFlag();
            if (dumpFile) {
                await Bun.write(dumpFile, JSON.stringify(data, null, 2));
                console.log(`Dumped raw scrape to ${dumpFile}`);
            }
            if (
                await promptConfirm({
                    message: `Save to database (${DB_PATH})?`,
                    default: true,
                })
            ) {
                const db = initDB(DB_PATH);
                upsertScrapeResults(db, data);
                db.close();
                console.log("Saved to database.");
            }
            break;
        }

        case "wiki": {
            // Only contests that declare a `wiki` descriptor are scrapable here.
            const WIKI_CONTESTS = ALL_CONTESTS.filter((c) => c.wiki);
            let user = await getUser();
            let session = new WikiSession(
                user["logged-in"],
                user["user-id"],
                user["session-id"],
                user["headers"] || null,
            );
            // Unlike ForumSession, every WikiSession.log() is a real anomaly
            // (answer-key disagreement, missing choices), so keep them on — they
            // now land in scrollback instead of under the progress region.
            session.debug = true;
            const progress = attachProgress(session);
            const { contest, id } = await autoSearch(
                "Enter id: ",
                WIKI_CONTESTS,
            );
            if (!contest) {
                console.log(
                    `No wiki descriptor for ${id}. Add a \`wiki\` field in contest_id.js.`,
                );
                break;
            }

            let method = await getWikiMethod();
            // Collect all interactive input (variant/year/page) BEFORE the
            // progress region starts — its repaint otherwise paints over these prompts.
            const methodArgs = await method.gather(contest);
            if (
                hasArgFlag("cache") ||
                (!hasArgFlag("no-cache") &&
                    (await promptConfirm({
                        message: "Use response cache?",
                        default: false,
                    })))
            ) {
                session.cache = new ResponseCache("./response_cache");
                console.log("Response cache enabled (./response_cache)");
            }
            if (!(await promptConfirm({ message: `Confirm ${contest.name}?` }))) {
                console.log("Exiting");
                break;
            }
            progress.start();
            let startTime = Date.now();
            let tests;
            try {
                tests = await method.run(session, contest, methodArgs);
            } finally {
                progress.stop();
            }
            let elapsedTime = Date.now() - startTime;
            if (tests === null) break; // debug method already handled output/exit

            data = {
                name: contest.name,
                is_official: contest.is_official ?? false,
                tests,
            };
            const total = tests.reduce((s, t) => s + (t.count ?? 0), 0);
            console.log(
                `Collected ${total} problems across ${tests.length} tests in ${formatDuration(elapsedTime)} from ${contest.name}`,
            );
            reportProgress(progress);
            if (!hasArgFlag("yes") && (await promptConfirm({ message: "Log Data?", default: false }))) {
                console.log(JSON.stringify(data, null, 2));
            }
            const dumpFile = parseDumpFlag();
            if (dumpFile) {
                await Bun.write(dumpFile, JSON.stringify(data, null, 2));
                console.log(`Dumped raw wiki scrape to ${dumpFile}`);
            }
            if (
                await promptConfirm({
                    message: `Save to database (${DB_PATH})?`,
                    default: true,
                })
            ) {
                const db = initDB(DB_PATH);
                upsertWikiResults(db, data);
                db.close();
                console.log("Saved to database.");
            }
            break;
        }

        case "import": {
            const srcFile = process.argv[3] ?? "raw.json";
            data = await Bun.file(srcFile).json();
            const db = initDB(DB_PATH);
            upsertScrapeResults(db, data);
            const { c } = db.query("SELECT count(*) as c FROM problems").get();
            db.close();
            console.log(
                `Merged ${srcFile} into ${DB_PATH} (${c} total problems in DB).`,
            );
            break;
        }

        case "import-pdf": {
            const args = process.argv.slice(3);
            const flag = (name) => {
                const hit = args.find((a) => a.startsWith(`--${name}=`));
                return hit
                    ? hit
                          .slice(name.length + 3)
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : null;
            };
            const outDir =
                args.find((a) => !a.startsWith("--")) ??
                process.env.OCR_OUT_DIR ??
                PDF_DATA_DIR;
            let series = flag("series"); // OCR series folder(s), comma-separated
            let tests = flag("test"); // test folder(s), comma-separated
            const all = args.includes("--all");

            const { importPdfProblems, listPdfSeries, listPdfTests } =
                await import("../src/pdfImport.js");

            // No explicit filter and interactive: let the user pick series/tests.
            if (!series && !tests && !all && process.stdin.isTTY) {
                const available = listPdfSeries(outDir);
                if (available.length === 0) {
                    console.log(`No importable series found in ${outDir}.`);
                    break;
                }
                series = await checkbox({
                    message:
                        "Which series? (space to toggle, enter to confirm; none = all)",
                    choices: available.map((s) => ({ name: s, value: s })),
                });
                if (series.length === 0) series = null; // treat "none selected" as all
                const testChoices = (series ?? available).flatMap((s) =>
                    listPdfTests(outDir, s).map((t) => ({
                        name: `${s}/${t}`,
                        value: t,
                    })),
                );
                tests = await checkbox({
                    message: "Which tests? (none = all in the chosen series)",
                    choices: testChoices,
                });
                if (tests.length === 0) tests = null;
            }

            const db = initDB(DB_PATH);
            const s = importPdfProblems(db, outDir, { series, tests });
            const { c } = db.query("SELECT count(*) as c FROM problems").get();
            db.close();
            console.log(
                `Imported PDF problems from ${outDir}: ${s.problems} problems, ${s.solutions} solutions across ${s.tests} tests in ${s.series} series (${c} total problems in DB).`,
            );
            if (s.answersOnly > 0 || s.droppedAnswers > 0) {
                console.log(
                    `  Answer key beyond the OCR'd statements: ${s.answersOnly} applied to existing rows, ${s.droppedAnswers} dropped (no statement from any source).`,
                );
            }
            break;
        }

        case "link-duplicates": {
            const args = process.argv.slice(3);
            const flag = (name) => {
                const hit = args.find((a) => a.startsWith(`--${name}=`));
                return hit
                    ? hit
                          .slice(name.length + 3)
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : null;
            };
            const outDir =
                args.find((a) => !a.startsWith("--")) ??
                process.env.OCR_OUT_DIR ??
                PDF_DATA_DIR;
            const series = flag("series");

            const { importDuplicates } = await import("../src/pdfImport.js");
            const db = initDB(DB_PATH);
            const s = importDuplicates(db, outDir, { series });
            db.close();
            console.log(
                `Linked duplicates from ${outDir}: ${s.linked} accepted, ${s.needsReview} need review, ${s.skipped} skipped, ${s.unresolved} members unresolved (across ${s.groups} groups in ${s.files} duplicates.json files).`,
            );
            break;
        }

        case "preprocess": {
            const db = initDB(DB_PATH);
            const { runPreprocess } = await import("../src/preprocess.js");
            await runPreprocess(db);
            db.close();
            break;
        }

        case "build": {
            const db = initDB(DB_PATH);
            const n = buildProductionProblems(db);
            console.log(`Built production_problems: ${n} rows.`);
            db.close();
            break;
        }

        case "export": {
            const db = initDB(DB_PATH);
            const n = await exportProductionCSV(db);
            db.close();
            if (n > 0) console.log(`Exported ${n} problems to scrape_data/`);
            break;
        }

        case "export-sql": {
            const args = parseExportSQLArgs(process.argv.slice(3));
            const db = initDB(DB_PATH);
            const result = await exportProductionSQL(db, args.outFile, {
                includeSchema: args.includeSchema,
                includeInserts: args.includeInserts,
            });
            db.close();
            console.log(
                `Exported PostgreSQL SQL to ${result.file} (${result.counts.series} series, ${result.counts.tests} tests, ${result.counts.problems} problems; schema=${result.includeSchema}, inserts=${result.includeInserts}).`,
            );
            break;
        }

        case "sync-export": {
            const outFile = process.argv[3] ?? "scrape_data/staging_load.sql";
            const db = initDB(DB_PATH);
            const result = await exportStagingSQL(db, outFile);
            db.close();
            console.log(
                `Wrote staging load to ${result.file} (${result.counts.series} series, ${result.counts.tests} tests, ${result.counts.problems} problems)` +
                    (result.orphaned > 0
                        ? `; skipped ${result.orphaned} problem(s) whose test has no series.`
                        : "."),
            );
            console.log(
                "Next: run it against the cloud, then `select * from public.sync_scraped_content(true)` (dry run) / `(false)` (apply).",
            );
            break;
        }

        case "seed-ratings-export": {
            const rest = process.argv.slice(3);
            const overwrite = rest.includes("--overwrite-seeds");
            const outFile =
                rest.find((a) => !a.startsWith("--")) ??
                "scrape_data/seed_ratings.sql";
            const db = initDB(DB_PATH);
            const result = await exportRatingSeedsSQL(db, outFile, {
                overwrite,
            });
            db.close();
            console.log(
                `Wrote rating seeds to ${result.file} (${result.matched} problems seeded, ` +
                    `${result.unmatchedTests} tests unmatched; mode=${overwrite ? "overwrite" : "seed-then-lock"}).`,
            );
            console.log(
                `Next: run it against the cloud:  psql "$DB_URL" -f ${result.file}`,
            );
            break;
        }

        case "audit": {
            const args = parseAuditArgs(process.argv.slice(3));
            const { auditDatabaseFile, writeAuditReports } =
                await import("../src/textAudit.js");
            const report = auditDatabaseFile(DB_PATH, {
                entities: args.entities,
                sources: args.sources,
            });
            const written = writeAuditReports(report, {
                jsonFile: args.jsonFile,
                csvFile: args.csvFile,
            });
            const summary = report.summary;
            console.log(
                `Audited ${summary.totalAuditedTexts} stored texts: ` +
                    `${summary.flaggedAuditedTexts} flagged, ${summary.totalFindings} findings ` +
                    `(${summary.findingsBySeverity.error ?? 0} errors, ` +
                    `${summary.findingsBySeverity.warning ?? 0} warnings).`,
            );
            if (written.jsonFile) console.log(`  JSON: ${written.jsonFile}`);
            if (written.csvFile) console.log(`  CSV:  ${written.csvFile}`);
            break;
        }

        case "llm": {
            const action = process.argv[3] ?? "plan";
            const { DEFAULT_OPERATION, getOperation } = await import("../src/llm/operations.js");
            const operation = getArgFlag("operation") ?? DEFAULT_OPERATION;
            const handler = getOperation(operation);
            const { OpenAICompatibleClient } = await import("../src/llm/client.js");
            const {
                listLLMProposals,
                planLLMOperation,
                runLLMOperation,
                showLLMProposal,
            } = await import("../src/llm/service.js");
            const { acceptLLMProposal, rejectLLMProposal } = await import("../src/db.js");
            const modelId = process.env.MODEL_ID ?? MODEL_ID;
            const modelRevision = process.env.MODEL_REVISION ?? MODEL_REVISION ?? null;
            const cachePath = process.env.LLM_CACHE_PATH ?? "./llm_cache.sqlite";
            const limitFlag = getArgFlag("limit");
            const options = {
                operation,
                cachePath,
                responseCacheDir: process.env.RESPONSE_CACHE_DIR ?? "./response_cache",
                modelId,
                modelRevision,
                // Inference budgets are per operation: a one-label classifier and
                // a full solution rewrite do not need the same ceiling.
                maxTokens: Number(
                    getArgFlag("max-tokens") ??
                        process.env.LLM_MAX_TOKENS ??
                        handler.defaultMaxTokens,
                ),
                maxInputChars: Number(
                    getArgFlag("max-input-chars") ??
                        process.env.LLM_MAX_INPUT_CHARS ??
                        handler.defaultMaxInputChars,
                ),
                seed: getArgFlag("seed") == null ? null : Number(getArgFlag("seed")),
                limit: limitFlag == null ? null : Number(limitFlag),
            };
            const db = initDB(DB_PATH);
            try {
                if (action === "plan") {
                    const plan = await planLLMOperation(db, options);
                    printLLMPlan(plan);
                } else if (action === "run") {
                    const modelURL = process.env.MODEL_URL ?? MODEL_URL;
                    options.client = new OpenAICompatibleClient({
                        modelURL,
                        modelId,
                        apiKey: process.env.MODEL_API_KEY ?? MODEL_API_KEY ?? null,
                        timeoutMs: Number(
                            getArgFlag("timeout-ms") ?? process.env.LLM_TIMEOUT_MS ?? 120000,
                        ),
                    });
                    const result = await runLLMOperation(db, options);
                    printLLMPlan(result.plan);
                    printLLMRun(result);
                } else if (action === "proposals") {
                    console.table(
                        listLLMProposals(db, {
                            status: getArgFlag("status"),
                            operation: getArgFlag("operation"),
                        }).map((row) => ({
                            id: row.id,
                            problem: `${row.test_name} #${row.n + 1}`,
                            operation: row.operation,
                            source: row.source_key,
                            review: row.review_status,
                            currency: row.currency_status,
                        })),
                    );
                } else if (action === "show") {
                    const proposal = showLLMProposal(db, Number(process.argv[4]));
                    if (!proposal) throw new Error(`LLM proposal ${process.argv[4]} does not exist`);
                    console.log(JSON.stringify(proposal, null, 2));
                } else if (action === "accept") {
                    const valueFile = getArgFlag("value-file");
                    const materialization = acceptLLMProposal(db, Number(process.argv[4]), {
                        approvedValue: valueFile ? await Bun.file(valueFile).text() : null,
                        reviewer: getArgFlag("reviewer") ?? process.env.USER ?? "cli",
                        notes: getArgFlag("notes"),
                    });
                    console.log(
                        `Accepted proposal ${process.argv[4]} as ${materialization.entity_type} ${materialization.entity_id}.`,
                    );
                } else if (action === "reject") {
                    const proposal = rejectLLMProposal(db, Number(process.argv[4]), {
                        reviewer: getArgFlag("reviewer") ?? process.env.USER ?? "cli",
                        notes: getArgFlag("notes"),
                    });
                    console.log(`Rejected proposal ${proposal.id}.`);
                } else {
                    throw new Error(`Unknown llm action: ${action}`);
                }
            } finally {
                db.close();
            }
            break;
        }

        case "init-db": {
            const db = initDB(DB_PATH);
            db.close();
            console.log(`Database initialized at ${DB_PATH}`);
            break;
        }

        case "clear-db": {
            const force =
                process.argv.includes("--yes") ||
                process.argv.includes("-y") ||
                process.argv[3] === "--yes" ||
                process.argv[3] === "-y";
            if (
                force ||
                (await confirm({
                    message: `Are you sure you want to clear the database (${DB_PATH})? This will delete all tables and data.`,
                    default: false,
                }))
            ) {
                try {
                    if (existsSync(DB_PATH)) {
                        unlinkSync(DB_PATH);
                    }
                    if (existsSync(`${DB_PATH}-wal`)) {
                        unlinkSync(`${DB_PATH}-wal`);
                    }
                    if (existsSync(`${DB_PATH}-shm`)) {
                        unlinkSync(`${DB_PATH}-shm`);
                    }
                    console.log("Database file deleted.");
                } catch (err) {
                    console.error(
                        "Failed to delete database files:",
                        err.message,
                    );
                }
                const db = initDB(DB_PATH);
                db.close();
                console.log(
                    `Database cleared and re-initialized at ${DB_PATH}`,
                );
            } else {
                console.log("Database clear cancelled.");
            }
            break;
        }

        default:
            console.log(
                "Available commands:\n" +
                "  scrape [--series=NAME|--contest=ID] [--yes|-y] [--cache] [--user=NAME] [--method=all|test|forum|topic] [--dump[=file]] [--debug] [--no-counter]\n" +
                "  wiki [--series=NAME|--contest=ID] [--yes|-y] [--cache] [--user=NAME] [--method=whole|single|debug] [--dump[=file]] [--debug] [--no-counter]\n" +
                "  import [file]\n" +
                "  import-pdf [dir] [--series=a,b] [--test=x,y] [--all]\n" +
                "  link-duplicates [dir] [--series=a,b]\n" +
                "  preprocess\n" +
                "  build\n" +
                "  export\n" +
                "  export-sql [file] [--schema-only|--data-only|--no-schema|--no-inserts]\n" +
                "  sync-export [file]\n" +
                "  seed-ratings-export [file] [--overwrite-seeds]\n" +
                "  audit [--entity=statements,choices,solutions,solution-sources] [--source=aops,wiki,pdf,import,manual,canonical] [--json=file] [--csv=file] [--no-json|--no-csv]\n" +
                "  llm plan [--operation=extract_solution_from_post|repair_solution_format] [--limit=N]\n" +
                "  llm run [--operation=...] [--limit=N] [--timeout-ms=N] [--max-tokens=N]\n" +
                "  llm proposals [--status=needs_review] [--operation=...]\n" +
                "  llm show <proposal-id>\n" +
                "  llm accept <proposal-id> [--value-file=file] [--reviewer=name] [--notes=text]\n" +
                "  llm reject <proposal-id> [--reviewer=name] [--notes=text]\n" +
                "  init-db\n" +
                "  clear-db [--yes|-y]"
            );
            break;
    }
}

const RUN_NOOP_REASONS = {
    proposal_exists: "already had a proposal awaiting review",
    materialized: "already applied to the database",
    valid_empty: "cached result found nothing usable",
    blocked: "skipped by a deterministic gate",
    missing_source: "required source is not archived",
};

function countList(counts) {
    return Object.entries(counts)
        .map(([key, value]) => `${value} ${key}`)
        .join(", ");
}

function printLLMRun(result) {
    const { statuses, noops, modelCalls, cacheReuse, acted } = result.summary;
    console.log(
        `Run: ${modelCalls} model call(s), ${cacheReuse} reused from cache, ` +
            `${acted} entr(ies) acted on.`,
    );
    console.log(`  Results: ${acted ? countList(statuses) : "nothing created"}`);
    if (Object.keys(noops).length) {
        // Without this an all-cached rerun printed an empty object, which reads
        // like a failure rather than "there was nothing left to do".
        console.log("  No action needed:");
        for (const [disposition, count] of Object.entries(noops)) {
            const reason = RUN_NOOP_REASONS[disposition] ?? "no run behavior defined";
            console.log(`    ${count} ${disposition} — ${reason}`);
        }
    }
}

function printLLMPlan(plan) {
    const { summary } = plan;
    const drifted = plan.entries.filter((entry) => entry.materializationDrift).length;
    console.log(
        `LLM plan (${plan.operation}): ${summary.candidates} candidates across ` +
            `${summary.scanned ?? summary.problems} ${plan.scanUnit ?? "problems"}; ` +
            `${summary.trueCallsRequired} model calls; ` +
            `~${summary.estimatedCallTokens ?? summary.estimatedInputTokens} input tokens to send.`,
    );
    console.log("Dispositions:", summary.dispositions);
    if (summary.omittedCandidates > 0) {
        console.log(
            `Limit: selected the first ${summary.candidates} of ${summary.totalCandidates} deterministic candidates; ${summary.omittedCandidates} omitted.`,
        );
    }
    if (Object.keys(summary.skips).length) console.log("Skips:", summary.skips);
    if (drifted) {
        console.log(
            `Materialization drift: ${drifted} accepted value(s) were edited after promotion; they remain materialized.`,
        );
    }
}

function parseAuditArgs(args) {
    const commaSet = (name) => {
        const flag = args.find((arg) => arg.startsWith(`--${name}=`));
        if (!flag) return new Set(["all"]);
        const values = flag
            .slice(name.length + 3)
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
        return new Set(values.length ? values : ["all"]);
    };
    const pathFlag = (name, fallback) => {
        const flag = args.find((arg) => arg.startsWith(`--${name}=`));
        return flag ? flag.slice(name.length + 3).trim() || fallback : fallback;
    };
    return {
        entities: commaSet("entity"),
        sources: commaSet("source"),
        jsonFile: args.includes("--no-json")
            ? null
            : pathFlag("json", "scrape_data/text_audit.json"),
        csvFile: args.includes("--no-csv")
            ? null
            : pathFlag("csv", "scrape_data/text_audit.csv"),
    };
}

function parseExportSQLArgs(args) {
    const outFile =
        args.find((arg) => !arg.startsWith("--")) ??
        "scrape_data/production_export.sql";
    let includeSchema = true;
    let includeInserts = true;

    if (args.includes("--schema-only")) {
        includeSchema = true;
        includeInserts = false;
    }
    if (args.includes("--data-only") || args.includes("--inserts-only")) {
        includeSchema = false;
        includeInserts = true;
    }
    if (args.includes("--no-schema")) {
        includeSchema = false;
    }
    if (args.includes("--no-inserts") || args.includes("--no-insert")) {
        includeInserts = false;
    }

    return { outFile, includeSchema, includeInserts };
}

// Returns the raw-dump file path if `--dump` / `--dump=<file>` was passed to
// `scrape`, else null. The dump is a debug artifact; SQLite is the source of truth.
function parseDumpFlag() {
    const flag = process.argv.find(
        (a) => a === "--dump" || a.startsWith("--dump="),
    );
    if (!flag) return null;
    return flag.includes("=") ? flag.split("=")[1] || "raw.json" : "raw.json";
}

/**
 * Builds the live progress display for a scrape/wiki run and binds `session` to
 * it. The region is disabled (log lines still print, nothing is repainted) for
 * --no-counter, non-TTY stdout, and non-interactive runs; --debug/--verbose adds
 * a line per request, which is the fastest way to tell a throttled run from a
 * stalled one.
 */
function attachProgress(session) {
    const enabled =
        !process.argv.includes("--no-counter") &&
        Boolean(process.stdout.isTTY) &&
        !hasArgFlag("yes");
    const progress = createScrapeProgress({
        enabled,
        verbose: hasArgFlag("debug") || hasArgFlag("verbose"),
    });
    progress.attach(session);
    return progress;
}

/** Prints the request accounting a run produced, if any. */
function reportProgress(progress) {
    for (const line of progress.summary()) console.log(line);
}

async function getUser(message = "Select user") {
    const userFlag = getArgFlag("user");
    if (userFlag && ENV["AoPs-User"][userFlag]) {
        return ENV["AoPs-User"][userFlag];
    }
    if (hasArgFlag("yes") || !process.stdin.isTTY) {
        const firstKey = Object.keys(ENV["AoPs-User"])[0];
        return ENV["AoPs-User"][firstKey];
    }
    return await select({
        message,
        choices: Object.keys(ENV["AoPs-User"]).map((name) => ({
            name,
            value: ENV["AoPs-User"][name],
        })),
    });
}

// Forum scrape methods. Each option value is `{ gather, run }`, mirroring the
// wiki path: `gather(session, id)` collects any interactive input and MUST run
// before the progress region starts (its repaint otherwise clobbers the
// prompt); returning null signals a bail. `run(session, id, args)` does the
// fetching and returns the scrape result to upsert.
async function getMethod(contest, message = "Select method") {
    const choices = [
        {
            name: "Test",
            value: {
                gather: async () => ({}),
                run: (session, id) => session.getTest(id),
            },
            description: "Get single test",
        },
        {
            name: "All Tests",
            value: {
                gather: async () => ({}),
                run: (session, id) =>
                    session.getAllTests(id, null, 0, new Set(), false),
            },
            description: "Get all tests from a collection",
        },
        {
            name: "Add single test to series",
            value: {
                gather: async (session, id) => {
                    console.log("Fetching tests in series...");
                    const { seriesName, tests } =
                        await session.listTests(id);
                    if (tests.length === 0) {
                        console.log(
                            `No sub-tests found under ${id} — it may be a single test itself. Use the "Test" method instead.`,
                        );
                        return null;
                    }
                    const testId = await select({
                        message: `Which test to add to "${seriesName}"?`,
                        choices: tests.map((t) => ({
                            name: `${t.name} (${t.id})`,
                            value: t.id,
                        })),
                    });
                    return { seriesName, testId };
                },
                run: async (session, id, { seriesName, testId }) => {
                    const t = await session.getTest(testId);
                    return {
                        id: Number(id),
                        name: seriesName,
                        is_official: contest?.is_official ?? false,
                        tests: [t],
                        count: t.count,
                    };
                },
            },
            description: "Pick one test out of a series and add just it",
        },
        {
            name: "Forum",
            value: {
                gather: async () => ({}),
                run: (session, id) => session.getForum(id),
            },
            description: "Gets all posts from a forum",
        },
        {
            name: "Topic (debug)",
            value: {
                gather: async () => ({}),
                run: async (session, id) => {
                    let r = (
                        await session.sendRequest(
                            ForumSession.payload(ApiMethod.TOPIC, { id }),
                        )
                    ).response;
                    console.log(r);
                    process.exit(0);
                },
            },
            description: "Log raw topic response and exit",
        },
    ];

    const methodArg = getArgFlag("method");
    if (methodArg) {
        if (methodArg === "test" || methodArg === "single") return choices[0].value;
        if (methodArg === "all" || methodArg === "all-tests") return choices[1].value;
        if (methodArg === "forum") return choices[3].value;
        if (methodArg === "topic") return choices[4].value;
    }
    if (hasArgFlag("yes") || !process.stdin.isTTY) {
        return choices[1].value;
    }

    return await select({
        message,
        choices,
    });
}

// Wiki scrape methods. Each option value is `{ gather, run }`: `gather(contest)`
// collects any interactive input (variant, year, page title) and MUST run before
// the progress region starts, otherwise its repaint clobbers the prompt.
// `run(session, contest, args)` does the fetching and returns an array of
// ScrapedTest objects (or null for the debug method, which logs and skips the DB).
async function getWikiMethod(message = "Select method") {
    const choices = [
        {
            name: "Single contest-year",
            value: {
                gather: async (contest) => {
                    const yearArg = getArgFlag("year");
                    const variant = await pickVariant(contest);
                    const year = yearArg ?? (await input({ message: "Year:" }));
                    return { variant, year };
                },
                run: async (session, _contest, { variant, year }) => [
                    await session.getContest(variant.page, year, {
                        testName: variant.testName,
                    }),
                ],
            },
            description: "One variant + year, e.g. 2021 AMC 10A",
        },
        {
            name: "Whole contest (all years)",
            value: {
                gather: async () => ({}),
                run: async (session, contest) => {
                    const tests = [];
                    for (const variant of resolveWikiVariants(contest)) {
                        // A variant may narrow the contest's year range to the
                        // years it actually ran (see resolveWikiVariant).
                        const [start, end] = variant.years;
                        for (let year = start; year <= end; year++) {
                            try {
                                const t = await session.getContest(
                                    variant.page,
                                    year,
                                    { testName: variant.testName },
                                );
                                if (t && t.count > 0) tests.push(t);
                            } catch (e) {
                                // Routed as an event so the live status region
                                // places it in scrollback; a bare console.log
                                // here is erased by the next repaint.
                                session._emit("warn", {
                                    message: `Skipped ${year} ${variant.page}: ${e.message}`,
                                });
                            }
                        }
                    }
                    return tests;
                },
            },
            description: "Every variant across the configured year range",
        },
        {
            name: "Single page (debug)",
            value: {
                gather: async () => ({
                    page: await input({
                        message: "Page title:",
                        default: "2021 AMC 10A Problems/Problem 1",
                    }),
                }),
                run: async (session, _contest, { page }) => {
                    const problem = await session.getProblemPage(page);
                    console.log(JSON.stringify(problem, null, 2));
                    return null;
                },
            },
            description: "Log a single parsed problem page and skip the DB",
        },
    ];

    const methodArg = getArgFlag("method");
    if (methodArg) {
        if (methodArg === "single") return choices[0].value;
        if (methodArg === "whole" || methodArg === "all") return choices[1].value;
        if (methodArg === "debug") return choices[2].value;
    }
    if (hasArgFlag("yes") || !process.stdin.isTTY) {
        return choices[1].value;
    }

    return await select({
        message,
        choices,
    });
}

/**
 * Normalizes one `wiki.variants` entry into `{ page, testName, years }`.
 *
 * An entry is either a bare page-title base ("AMC 12A") or an object that
 * overrides some axis of it:
 *
 * - `years` — the variant only ran for part of the contest's range. The 2021
 *   Fall AMC and the 2002 AMC P administrations are one-off page families:
 *   sweeping them across the whole range would be ~100 requests that can only
 *   404.
 * - `testName` — the wiki publishes the contest under a title the forum does
 *   not use, so the test must be *stored* under a different base than it is
 *   *fetched* under. AHSME is the motivating case (fetched as "1950 AHSME",
 *   stored as "1950 AMC 12"); see WikiSession.getContest for why conflating the
 *   two both breaks the merge and mis-types the contest.
 *
 * `testName` defaults to the page base, so every other variant is unchanged.
 */
function resolveWikiVariant(contest, entry) {
    if (typeof entry === "string") {
        return { page: entry, testName: entry, years: contest.wiki.years };
    }
    return {
        page: entry.name,
        testName: entry.testName ?? entry.name,
        years: entry.years ?? contest.wiki.years,
    };
}

function resolveWikiVariants(contest) {
    return (contest.wiki?.variants ?? [contest.name]).map((entry) =>
        resolveWikiVariant(contest, entry),
    );
}

/**
 * Resolves which variant to scrape, as a descriptor rather than a bare string —
 * a string would drop `testName` and silently reintroduce the AHSME bug.
 */
async function pickVariant(contest) {
    const variants = resolveWikiVariants(contest);
    const variantArg = getArgFlag("variant");
    if (variantArg) {
        // A listed --variant must resolve to its entry so `testName`/`years`
        // survive; an unlisted one is still honored as an ad-hoc page base.
        return (
            variants.find((v) => v.page === variantArg) ??
            resolveWikiVariant(contest, variantArg)
        );
    }
    if (variants.length === 1) return variants[0];
    if (hasArgFlag("yes") || !process.stdin.isTTY) return variants[0];
    return await select({
        message: "Which variant?",
        choices: variants.map((v) => ({ name: v.page, value: v })),
    });
}

/**
 * Prompts for a contest and returns `{ contest, id }` — the resolved registry
 * entry (null for an ad-hoc id the user typed) alongside its id.
 *
 * It deliberately returns the entry itself rather than just an id. Returning an
 * id forced every caller into an `id → find()` round trip, and `find` returns
 * the *first* match: when two registry entries shared an id (AHSME and AMC 12
 * both sat on category 3415), picking either one always resolved to whichever
 * was listed first, silently scraping the wrong contest.
 */
async function autoSearch(message = "Search", choices = []) {
    const contestArg = getArgFlag("contest") ?? getArgFlag("series") ?? getArgFlag("id");
    if (contestArg) {
        const found = choices.find(
            (item) =>
                item.id.toString() === contestArg ||
                item.name.toLowerCase() === contestArg.toLowerCase(),
        );
        return found
            ? { contest: found, id: found.id }
            : { contest: null, id: contestArg };
    }
    const selection = await search({
        message,
        source: async (input = "") => {
            input = input.trim();
            let matches = choices
                .filter(
                    (item) =>
                        item.id.toString().includes(input) ||
                        item.name.toLowerCase().includes(input.toLowerCase()),
                )
                .map((item) => ({
                    name:
                        item.type === "forum"
                            ? `[forum] [${item.name}] ${item.id}`
                            : `[${item.name}] ${item.id}`,
                    value: item,
                }));
            if (input.length > 0) {
                matches.push({ name: `Use custom: ${input}`, value: input });
            }
            return matches;
        },
    });
    // A registry entry is an object; "Use custom: …" yields the raw string.
    return typeof selection === "object"
        ? { contest: selection, id: selection.id }
        : { contest: null, id: selection };
}

try {
    await main();
} catch (error) {
    if (error.name === "ExitPromptError") {
        console.log("Exiting ...");
    } else {
        throw error;
    }
}
