#!/usr/bin/env node
import {input, confirm, select, number, search} from '@inquirer/prompts';
import {ENV} from "../env.js"
import {ForumSession} from "../src/ForumSession.js"
import { promises as fs } from 'node:fs';
import {CONTEST_IDS} from "../contest_id.js";
import {CLIBar, CLIBarManager} from "./tests/test.js";

const command = process.argv[2];
ForumSession.onProblemAdd = (data) => {
    loader.bars[loader.bars.length - 1].current ++
}
ForumSession.onTotalCount = (data, name) => {
    loader.addBar(new CLIBar(data.items.length, data["category_name"]));
}
let loader = new CLIBarManager()
async function main() {
    let contests = [
        ...CONTEST_IDS["MAA"],
        ...CONTEST_IDS["CollegeComp"],
        ...CONTEST_IDS["Other"],
        ...CONTEST_IDS["UserContestSeries"],
        ...CONTEST_IDS["UserMocks"]
    ]
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
            let id = await autoSearch("Enter id: ", contests)
            let method = await getMethod()
            if (!(await confirm({message: `Confirm ${id}?`}))) {
                console.log("Exiting")
                break;
            }
            loader.start()
            console.time("scrape-time")
            let loaderInterval = setInterval(() => {
                loader.calculate()
                loader.render()
            }, 500)
            let data = await method.apply(null, [f, id]);
            console.timeEnd("scrape-time")
            clearInterval(loaderInterval)
            loader.calculate()
            loader.render()
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

        default:
            console.log("test")
            break;
    }

}

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
                    return await f.getForum(id)
                }),
                description: "Gets all posts from a forum",
            },
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