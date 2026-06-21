#!/usr/bin/env bun
import { input, confirm, select, search } from "@inquirer/prompts";
import { ENV } from "../.env.js";
import { ApiMethod, ForumSession } from "../src/ForumSession.js";
import { CONTEST_IDS } from "../contest_id.js";
import { CLIBarManager, CLICount } from "./progress.js";
import { CleanupText } from "../src/CleanupText.js";
import { initDB, upsertScrapeResults } from "../src/db.js";

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
    ].filter((c) => c.id && c.type !== "forum");

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
            session.debug = true;
            let id = await autoSearch("Enter id: ", ALL_CONTESTS);
            let method = await getMethod();
            if (!(await confirm({ message: `Confirm ${id}?` }))) {
                console.log("Exiting");
                break;
            }
            loader.add(new CLICount("Problems Collected:"));
            // loader.start();
            let loaderInterval = setInterval(() => {
                loader.calculate();
                // loader.render();
            }, 300);
            let startTime = Date.now();
            data = await method(session, id);
            let elapsedTime = Date.now() - startTime;
            clearInterval(loaderInterval);
            await sleep(100);
            // loader.clear();
            console.log(
                `Collected ${data.count} problems in ${elapsedTime}ms from ${id}`,
            );
            if (await confirm({ message: "Log Data?" })) {
                console.log(data);
            }
            let saveFile = await input({
                message: "Save to: ",
                default: "raw.json",
            });
            if (saveFile) {
                await Bun.write(saveFile, JSON.stringify(data, null, 2));
                console.log("Saved to file: ", saveFile);
            } else {
                console.log("Data not saved");
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

        case "save-to-db": {
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

        case "to-csv": {
            console.log("TO-CSV");
            data = await Bun.file("raw.json").json();
            if (!Array.isArray(data)) data = [data];
            await exportToCSV(data);
            console.log("Done!");
            break;
        }

        case "quick-fix": {
            data = await Bun.file("scrape_data/problems.json").json();
            for (let p of data) {
                if (p.answers.length === 0) {
                    p.answers = CleanupText.extractChoices(p.statement);
                }
                p.statement = CleanupText.cleanChoices(p.statement);
            }
            await Bun.write(
                "scrape_data/problems.json",
                JSON.stringify(data, null, 2),
            );
            await Bun.write("scrape_data/problems.csv", JSONToCSV(data));
            console.log("Saved!");
            break;
        }

        case "init-db": {
            const db = initDB(DB_PATH);
            db.close();
            console.log(`Database initialized at ${DB_PATH}`);
            break;
        }

        default:
            console.log(
                "Available commands: scrape, save-to-db, to-csv, quick-fix, init-db",
            );
            break;
    }
}

async function exportToCSV(seriesList) {
    let seriesRows = [];
    let testRows = [];
    let problemRows = [];
    let seriesId = 0,
        testId = 0,
        problemId = 0;

    let addProblem = (problem, test) => {
        problemRows.push({
            id: problemId,
            test_id: testId,
            statement: problem.statement,
            n: problem.n,
            answer_index:
                problem?.choices[0] === null
                    ? -1
                    : problem.answer === null
                      ? -1
                      : problem.answer,
            answers: problem.choices ?? [],
            difficulty: 0,
            quality: 0,
            verified: false,
            aops_id: problem["topic_id"],
            topic: CleanupText.inferACGN(problem.statement),
            is_computational: test.computational || false,
        });
    };

    for (let series of seriesList) {
        seriesRows.push({
            id: seriesId,
            name: series.name,
            is_official: false,
        });

        for (let test of series.tests) {
            if (test.sections.length > 0) {
                for (let i = 0; i < test.sections.length; i++) {
                    testRows.push({
                        id: testId,
                        series: seriesId,
                        name: `${test.name} ${test.sections[i]}`,
                        year:
                            test.year ??
                            CleanupText.extractYear(test.sections[i]),
                        links: [],
                        quality: 0,
                        difficulty: 0,
                        aops_id: test.id,
                        is_computational: test.computational,
                    });
                    for (let problem of test.problems[i]) {
                        addProblem(problem, test);
                        problemId++;
                    }
                    testId++;
                }
            } else {
                testRows.push({
                    id: testId,
                    series: seriesId,
                    name: test.name,
                    year: test.year ?? -1,
                    links: [],
                    quality: 0,
                    difficulty: 0,
                    aops_id: test.id,
                    is_computational: test.computational,
                });
                for (let problem of test.problems) {
                    addProblem(problem, test);
                    problemId++;
                }
                testId++;
            }
        }
        seriesId++;
    }

    await Bun.write(
        "scrape_data/problems.json",
        JSON.stringify(problemRows, null, 2),
    );
    await Bun.write("scrape_data/series.csv", JSONToCSV(seriesRows));
    await Bun.write("scrape_data/tests.csv", JSONToCSV(testRows));
    await Bun.write("scrape_data/problems.csv", JSONToCSV(problemRows));
}

function JSONToCSV(data) {
    let keys = Object.keys(data[0]);
    let text = keys.join(",") + "\n";
    for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < keys.length; j++) {
            let d = data[i][keys[j]];
            if (Array.isArray(d)) {
                text += `"[${d.map((a) => `""${a.replace(/\\/g, "\\\\")}""`).join(",")}]"`;
            } else if (d != null) {
                text += typeof d === "string" ? sanitizeStringCSV(d) : d;
            }
            if (j < keys.length - 1) text += ",";
        }
        if (i < data.length - 1) text += "\n";
    }
    return text;
}

function sanitizeStringCSV(content) {
    content = content.replace(/\r\n/g, "\n");
    if (/[",\n\r]/.test(content)) {
        return `"${content.replace(/"/g, '""')}"`;
    }
    return content;
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
                    name: `[${item.name}] ${item.id}`,
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
