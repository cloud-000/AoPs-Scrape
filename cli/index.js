#!/usr/bin/env bun
import { confirm, select, search } from "@inquirer/prompts";
import { ENV } from "../.env.js";
import { ApiMethod, ForumSession } from "../src/ForumSession.js";
import { ResponseCache } from "../src/ResponseCache.js";
import { CONTEST_IDS } from "../contest_id.js";
import { CLIBarManager, CLICount } from "./progress.js";
import {
    initDB,
    upsertScrapeResults,
    buildProductionProblems,
} from "../src/db.js";
import { exportProductionCSV } from "../src/export.js";
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
                    loader.bars[0].count++;
                },
            );
            session.debug = false;
            let id = await autoSearch("Enter id: ", ALL_CONTESTS);
            const selectedContest = ALL_CONTESTS.find(
                (c) => c.id === id || c.id === Number(id),
            );

            // session.enableStickyAnswerKey = selectedContest != null && !selectedContest.is_official;
            session.enableStickyAnswerKey = true;

            let method = await getMethod();
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
            loader.add(new CLICount("Problems Collected:"));
            loader.start();
            let loaderInterval = setInterval(() => {
                loader.calculate();
                loader.render();
            }, 300);
            let startTime = Date.now();
            data = await method(session, id);
            let elapsedTime = Date.now() - startTime;
            clearInterval(loaderInterval);
            await sleep(100);
            loader.clear();
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
                "Available commands: scrape [--dump[=file]], import [file], preprocess, build, export, init-db, clear-db",
            );
            break;
    }
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

async function getMethod(message = "Select method") {
    return await select({
        message,
        choices: [
            {
                name: "Test",
                value: (session, id) => session.getTest(id),
                description: "Get single test",
            },
            {
                name: "All Tests",
                value: (session, id) =>
                    session.getAllTests(id, null, 0, new Set(), false),
                description: "Get all tests from a collection",
            },
            {
                name: "Forum",
                value: (session, id) => session.getForum(id),
                description: "Gets all posts from a forum",
            },
            {
                name: "Topic (debug)",
                value: async (session, id) => {
                    let r = (
                        await session.sendRequest(
                            ForumSession.payload(ApiMethod.TOPIC, { id }),
                        )
                    ).response;
                    console.log(r);
                    process.exit(0);
                },
                description: "Log raw topic response and exit",
            },
        ],
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
