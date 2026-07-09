#!/usr/bin/env bun
import { confirm, select, search, checkbox, input } from "@inquirer/prompts";
import { ENV, PDF_DATA_DIR } from "../.env.js";
import { ApiMethod, ForumSession } from "../src/ForumSession.js";
import { WikiSession } from "../src/WikiSession.js";
import { ResponseCache } from "../src/ResponseCache.js";
import { CONTEST_IDS } from "../contest_id.js";
import { CLIBarManager, CLICount } from "./progress.js";
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
} from "../src/export.js";
import { unlinkSync, existsSync } from "node:fs";

const DB_PATH = process.env.AOPS_DB_PATH ?? "./aops_problems.sqlite";

const command = process.argv[2];

let loader = new CLIBarManager();
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
                () => {
                    if (loader.bars[0]) loader.bars[0].count++;
                },
            );
            session.debug = false;
            let id = await autoSearch("Enter id: ", ALL_CONTESTS);
            const selectedContest = ALL_CONTESTS.find(
                (c) => c.id === id || c.id === Number(id),
            );

            // session.enableStickyAnswerKey = selectedContest != null && !selectedContest.is_official;
            session.enableStickyAnswerKey = true;

            let method = await getMethod(selectedContest);
            if (
                await confirm({
                    message: "Use response cache?",
                    default: false,
                })
            ) {
                session.cache = new ResponseCache("./response_cache");
                console.log("Response cache enabled (./response_cache)");
            }
            if (!(await confirm({ message: `Confirm ${id}?` }))) {
                console.log("Exiting");
                break;
            }
            // Collect any interactive input (e.g. picking one test out of a
            // series) BEFORE the loader starts — its 300ms re-render otherwise
            // paints over these prompts. `gather` returning null signals a bail.
            const methodArgs = await method.gather(session, id);
            if (methodArgs === null) {
                console.log("Exiting");
                break;
            }
            const showCounter = !process.argv.includes("--no-counter");
            let loaderInterval;
            if (showCounter) {
                loader.add(new CLICount("Problems Collected:"));
                loader.start();
                loaderInterval = setInterval(() => {
                    loader.calculate();
                    loader.render();
                }, 300);
            }
            let startTime = Date.now();
            data = await method.run(session, id, methodArgs);
            let elapsedTime = Date.now() - startTime;
            if (loaderInterval) {
                clearInterval(loaderInterval);
                await sleep(100);
                loader.clear();
            }
            console.log(
                `Collected ${data.count} problems in ${elapsedTime}ms from ${id}`,
            );
            if (await confirm({ message: "Log Data?" })) {
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
                await confirm({
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
                () => {
                    if (loader.bars[0]) loader.bars[0].count++;
                },
            );
            session.debug = false;
            let id = await autoSearch("Enter id: ", WIKI_CONTESTS);
            const contest = WIKI_CONTESTS.find(
                (c) => c.id === id || c.id === Number(id),
            );
            if (!contest) {
                console.log(
                    `No wiki descriptor for ${id}. Add a \`wiki\` field in contest_id.js.`,
                );
                break;
            }

            let method = await getWikiMethod();
            // Collect all interactive input (variant/year/page) BEFORE the loader
            // starts — its 300ms re-render otherwise paints over these prompts.
            const methodArgs = await method.gather(contest);
            if (
                await confirm({
                    message: "Use response cache?",
                    default: false,
                })
            ) {
                session.cache = new ResponseCache("./response_cache");
                console.log("Response cache enabled (./response_cache)");
            }
            if (!(await confirm({ message: `Confirm ${contest.name}?` }))) {
                console.log("Exiting");
                break;
            }
            const showCounter = !process.argv.includes("--no-counter");
            let loaderInterval;
            if (showCounter) {
                loader.add(new CLICount("Problems Collected:"));
                loader.start();
                loaderInterval = setInterval(() => {
                    loader.calculate();
                    loader.render();
                }, 300);
            }
            let startTime = Date.now();
            const tests = await method.run(session, contest, methodArgs);
            let elapsedTime = Date.now() - startTime;
            if (loaderInterval) {
                clearInterval(loaderInterval);
                await sleep(100);
                loader.clear();
            }
            if (tests === null) break; // debug method already handled output/exit

            data = {
                name: contest.name,
                is_official: contest.is_official ?? false,
                tests,
            };
            const total = tests.reduce((s, t) => s + (t.count ?? 0), 0);
            console.log(
                `Collected ${total} problems across ${tests.length} tests in ${elapsedTime}ms from ${contest.name}`,
            );
            if (await confirm({ message: "Log Data?" })) {
                console.log(JSON.stringify(data, null, 2));
            }
            const dumpFile = parseDumpFlag();
            if (dumpFile) {
                await Bun.write(dumpFile, JSON.stringify(data, null, 2));
                console.log(`Dumped raw wiki scrape to ${dumpFile}`);
            }
            if (
                await confirm({
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
                "Available commands: scrape [--dump[=file]], wiki [--dump[=file]], import [file], import-pdf [dir] [--series=a,b] [--test=x,y] [--all], preprocess, build, export, export-sql [file] [--schema-only|--data-only|--no-schema|--no-inserts], sync-export [file], init-db, clear-db",
            );
            break;
    }
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

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUser(message = "Select user") {
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
// before the progress loader starts (its 300ms re-render otherwise clobbers the
// prompt); returning null signals a bail. `run(session, id, args)` does the
// fetching and returns the scrape result to upsert.
async function getMethod(contest, message = "Select method") {
    return await select({
        message,
        choices: [
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
        ],
    });
}

// Wiki scrape methods. Each option value is `{ gather, run }`: `gather(contest)`
// collects any interactive input (variant, year, page title) and MUST run before
// the progress loader starts, otherwise its 300ms re-render clobbers the prompt.
// `run(session, contest, args)` does the fetching and returns an array of
// ScrapedTest objects (or null for the debug method, which logs and skips the DB).
async function getWikiMethod(message = "Select method") {
    return await select({
        message,
        choices: [
            {
                name: "Single contest-year",
                value: {
                    gather: async (contest) => {
                        const variant = await pickVariant(contest);
                        const year = await input({ message: "Year:" });
                        return { variant, year };
                    },
                    run: async (session, _contest, { variant, year }) => [
                        await session.getContest(variant, year),
                    ],
                },
                description: "One variant + year, e.g. 2021 AMC 10A",
            },
            {
                name: "Whole contest (all years)",
                value: {
                    gather: async () => ({}),
                    run: async (session, contest) => {
                        const [start, end] = contest.wiki.years;
                        const tests = [];
                        for (const variant of contest.wiki.variants) {
                            for (let year = start; year <= end; year++) {
                                try {
                                    const t = await session.getContest(
                                        variant,
                                        year,
                                    );
                                    if (t.count > 0) tests.push(t);
                                } catch (e) {
                                    console.log(
                                        `\nSkipped ${year} ${variant}: ${e.message}`,
                                    );
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
        ],
    });
}

async function pickVariant(contest) {
    const variants = contest.wiki?.variants ?? [contest.name];
    if (variants.length === 1) return variants[0];
    return await select({
        message: "Which variant?",
        choices: variants.map((v) => ({ name: v, value: v })),
    });
}

async function autoSearch(message = "Search", choices = []) {
    return await search({
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
                    value: item.id,
                }));
            if (input.length > 0) {
                matches.push({ name: `Use custom: ${input}`, value: input });
            }
            return matches;
        },
    });
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
