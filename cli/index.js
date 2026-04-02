#!/usr/bin/env node
import {input, confirm, select, number, search} from '@inquirer/prompts';
import {ENV} from "../env.js"
import {ForumSession} from "../src/ForumSession.js"
import { promises as fs } from 'node:fs';
import {CONTEST_IDS} from "../contest_id.js";
import {CLIBar, CLIBarManager, CLICount} from "./tests/test.js";

const command = process.argv[2];
ForumSession.onProblemAdd = (data) => {
    loader.bars[0].count ++
}

let loader = new CLIBarManager()
let ALL_CONTESTS
async function main() {
    ALL_CONTESTS = [
        ...CONTEST_IDS["MAA"],
        ...CONTEST_IDS["CollegeComp"],
        ...CONTEST_IDS["Other"],
        ...CONTEST_IDS["UserContestSeries"],
        ...CONTEST_IDS["UserMocks"]
    ].filter(c => c.id && c.type !== "forum") // forum's not implemented yet
    let data;
    switch (command) {
        case "scrape":
            let user = await getUser()
            let f = new ForumSession(
                user["logged-in"],
                user["user-id"],
                user["session-id"],
                user["headers"] || null
            )
            f.debug = false
            let id = await autoSearch("Enter id: ", ALL_CONTESTS)
            let method = await getMethod()
            if (!(await confirm({message: `Confirm ${id}?`}))) {
                console.log("Exiting")
                break;
            }
            loader.add(new CLICount("Problem's Collected:"))
            loader.start()
            let loaderInterval = setInterval(() => {
                loader.calculate()
                loader.render()
            }, 300)
            let startTime = Date.now()
            data = await method.apply(null, [f, id]);
            let elapsedTime = Date.now() - startTime;
            clearInterval(loaderInterval)
            await sleep(100)
            loader.clear()
            console.log(`Collected ${data.count} problems in ${elapsedTime}ms from ${id}`)
            if (await confirm({message: "Log Data?"})) {
                console.log(data)
            }
            let saveFile = await input({message: "Save to: ", default: "raw.json"})
            if (saveFile) {
                await fs.writeFile(saveFile, JSON.stringify(data, null, 2))
                console.log("Saved to file: ", saveFile)
            } else {
                console.log("Data not saved")
                break;
            }
            break;
        case "to-csv": // normalize data
            console.log("TO - CSV")
            data = await fs.readFile("raw.json")
            data = JSON.parse(data)
            let series_data = []
            let tests_data = []
            let problems_data = []
            let s_id = 0, t_id = 0, p_id = 0
            for (let series of data) {
                series_data.push({
                    id: s_id,
                    name: series.name,
                    // is_computational: series.is_computational,
                    is_official: false,
                })
                for (let test of series.tests) {// remember single no section
                    for (let i = 0; i < test.sections.length; i++) {
                        tests_data.push({
                            id: t_id,
                            series: s_id,
                            name: `${test.name} + ${test.sections[i]}`,
                            year: test.year,
                            links: [],
                            quality: 0,
                            difficulty: 0,
                            // user_id: null
                            aops_id: test.id,
                            is_computational: test.computational,
                        })
                        for (let problem of test.problems[i]) {
                            problems_data.push({
                                id: p_id,
                                test_id: t_id,
                                // series_id: s_id,
                                // redirect: null
                                // created_at
                                statement: problem.statement,
                                n: problem.n,
                                answer_index: (problem.answer === null) ? -1 : problem.answer,
                                answers: problem.choices ? problem.choices : [],
                                difficulty: 0,
                                quality: 0,
                                verified: false,
                                aops_id: problem["topic_id"],
                                topic: "O",
                                is_computational: test.computational || false,
                            })
                            p_id++
                        }
                        t_id++
                    }
                }
                s_id++
            }
            fs.writeFile("scrape_data/series.csv", JSONToCSV(series_data))
            fs.writeFile("scrape_data/tests.csv", JSONToCSV(tests_data))
            fs.writeFile("scrape_data/problems.csv", JSONToCSV(problems_data))
            console.log("Done!")
            break;
        default:
            console.log("test")
            break;
    }

}

function JSONToCSV(data) {
    let keys = Object.keys(data[0])
    let text = keys.join(",") + "\n"
    for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < keys.length; j++) {
            let d = data[i][keys[j]]
            if (Array.isArray(d)) {
                text += `"${d.join(",")}"`
            } else {
                if (d != null) {
                    text += `"${d}"`
                }
            }
            if (j < keys.length - 1) {
                text += ","
            }
        }
        if (i < data.length - 1) {
            text += "\n"
        }
    }
    return text
}

async function sleep(time) {await new Promise(resolve => setTimeout(resolve, time));}

async function getUser(message="Select user") {
    return await select({
        message: message,
        choices: Object.keys(ENV["AoPs-User"]).map(name => ({
            name: name,
            value: ENV["AoPs-User"][name],
        }))
    })
}

async function getMethod(message="Select method") {
    return await select({
        message: message,
        choices: [
            {
                name: "Test",
                value: (async (f, id) => {
                    return await f.getTest(id)
                }),
                description: "Get single test",
            },
            {
                name: "All Tests",
                value: (async (f, id) => {
                    return await f.getAllTests(id, null, 0, [], false)
                }),
                description: "Get all tests from a collection",
            },
            {
                name: "Forum",
                value: (async (f, id) => {
                    throw new Error("Forums scrape not completed...")
                    // return await f.getForum(id)
                }),
                description: "Gets all posts from a forum",
            },
            {
                name: "All",
                value: (async (f, id) => {
                    if (!await confirm({message: "Are you sure?", default: false})) {
                        process.exit(0)
                    }
                    /*for (let contest of ALL_CONTESTS) {
                    }*/
                }),
                description: "Get ALL (Use with caution)",
            }
        ],
    });
}

async function autoSearch(message="Search", choices=[]) {
    return await search({
        message: message,
        source: async (input = "") => {
            input = input.trim();

            let matches = choices
                .filter(item =>
                    item.id.toString().includes(input) ||
                    item.name.toLowerCase().includes(input.toLowerCase())
                )
                .map(item => ({
                    name: `[${item.name}] ${item.id}`,
                    value: item.id
                }));

            // Add custom option if user typed something
            if (input.length > 0) {
                matches.push({
                    name: `Use custom: ${input}`,
                    value: input
                });
            }
            return matches;
        }
    });
}

try {
    await main()
} catch (error) {
    if (error.name === "ExitPromptError") {
        console.log("Exiting ...")
    } else {
        throw error;
    }
}