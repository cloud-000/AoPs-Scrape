import {ENV} from '../env.js';
import {ForumSession} from "../src/ForumSession.js";
import {CONTEST_IDS} from "../contest_id.js";

let f;
async function main() {
    f = new ForumSession(
        ENV["AoPs-User"]["Anonymous"]["logged-in"],
        ENV["AoPs-User"]["Anonymous"]["user-id"],
        ENV["AoPs-User"]["Anonymous"].sessionId
    )
    // console.log(await f.getTest(1035157))
    // console.log(await f.getTest)
}
document.getElementById("uh-oh-scrape").onclick = () => {
    if (window.confirm("Are you sure?")) {
        scrapeAoPs()
    }
}
// DO NOT EXECUTE
// they will prob ban me
async function scrapeAoPs() {
    let done = []
    let tests = []
    let button = document.getElementById("uh-oh-scrape")
    let prog = 0;
    let num_p = 0;
    let alright;
    button.text = "Scraping..."
    // f.getAllTests()
    for (const contest of CONTEST_IDS["UserContestSeries"]) {
        if (contest.id) {
            alright = await f.getAllTests(contest.id, null, 0, done, false)
            tests.push(...alright["tests"])
            // save progress
            // localStorage.setItem("tests", JSON.stringify(tests))
            num_p += alright.count
            button.textContent = `Scraping...${prog}% || ${num_p} total problems`
            await sleep(Math.random() * 200 + 100)
            prog++
        }
    }
    console.log(`END total ${tests.length} tests ${"#".repeat(tests.length)}`)
    console.log(`END total ${num_p} problems`)
    console.log(tests)
}

function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

document.getElementById("get-button").addEventListener("click", async () => {
    let sigma = await ({
        "test": async (id) => {
            return (await f.getTest(id))
        },
        "forum": async (id) => {
            return (await f.getForum(id))
        },
        "all-tests": async (id) => {
            return (await f.getAllTests(id))
        }
    })[document.getElementById("some-meths").value](document.getElementById("id-input").value)
    console.log(sigma)
    // document.getElementById("why-duh").innerHTML = `<json-viewer>${JSON.stringify(sigma)}</json-viewer>`
    document.getElementById("why-duh").children[0].data = sigma
})

function moreLikeCSV(test) {
    if (test.sections) {

    }
}

onload = () => main()