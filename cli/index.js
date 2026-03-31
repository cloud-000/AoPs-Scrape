#!/usr/bin/env node
import { input, confirm, select } from '@inquirer/prompts';
import {ENV} from "../env.js"
import {ForumSession} from "../src/ForumSession.js"
import { promises as fs } from 'node:fs';
import {CONTEST_IDS} from "../contest_id.js";

const command = process.argv[2];

async function main() {
    switch (command) {
        case "scrape":
            let user = await input({
                message: "Select user",
                default: "Anonymous"
            })
            let f = new ForumSession(
                ENV["AoPs-User"][user]["logged-in"],
                ENV["AoPs-User"][user]["user-id"],
                ENV["AoPs-User"][user].sessionId,
                ENV["AoPs-User"][user]["headers"] || null,
            )
            f.debug = false
            const method = await select({
                message: "Select the method",
                choices: [
                    {
                        name: "Test",
                        value: "test",
                        description: "Get single test",
                    },
                    {
                        name: "All Tests",
                        value: "all-tests",
                        description: "Get all tests from a collection",
                    },
                    {
                        name: "Forum",
                        value: "forum",
                        description: "Gets all posts from a forum",
                    },
                ],
            });
            let id = await getNumber("Enter id: ")
            let data;
            if (!(await confirm({message: `Confirm ${method} | ${id}?`}))) {
                console.log("Exiting")
                break;
            }
            console.time("scrape-time")
            switch (method) {
                case "test":
                    data = await f.getTest(id)
                    break
                case "all-tests":
                    data = await f.getAllTests(id, null, 0, [], false)
                    break
                case "forum":
                    data = await f.getForum(id)
                    break
            }
            console.timeEnd("scrape-time")
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

async function getNumber(message) {
    return await input({
        message: message,
        transformer: (value) => {
            return value.replace(/\D/g, '');
        }
    });
}

main()