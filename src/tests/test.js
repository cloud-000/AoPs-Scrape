import { ForumSession } from "../ForumSession";
import { input, confirm, select, search } from "@inquirer/prompts";
import { ENV } from "../../.env";

async function getUser(message = "Select user") {
    return await select({
        message,
        choices: Object.keys(ENV["AoPs-User"]).map((name) => ({
            name,
            value: ENV["AoPs-User"][name],
        })),
    });
}
let user = await getUser();

let session = new ForumSession(
    user["logged-in"],
    user["user-id"],
    user["session-id"],
    user["headers"] || null,
    () => {},
);
let mapy = await session._fetchStickyAnswerKey(763119, "popcorn");
console.log(mapy);
