import {CleanupText} from "./CleanupText.js";
import {CONTEST_IDS, TYPES} from "../contest_id.js";

export const FETCH_ = {
    TOPIC: 0,
    CATEGORY_DATA: 1,
    FORUM: 2,
    ITEMS_CATEGORIES: 3,
}
// Spaghetti
let addProblem = (p, sectionCounter, test) => {
    if (sectionCounter >= 0) {
        p.section = sectionCounter
        test.problems[test.problems.length - 1].push(p)
    } else {
        test.problems.push(p)
    }
    ForumSession.onProblemAdd(p)
}

export class ForumSession {
    static MORE_INFO = null
    static onProblemAdd(data) {}
    static payload(f_type, params) {
        switch (f_type) {
            case FETCH_.TOPIC:
                return {
                    "a": ["fetch_topic"],
                    "topic_id": [params["id"].toString()]
                }
            case FETCH_.CATEGORY_DATA:
                return {
                    "a": ["fetch_category_data"],
                    "category_id": [params["id"].toString()]
                }
            case FETCH_.ITEMS_CATEGORIES:
                return {
                    "sought_category_ids": "[]",
                    "parent_category_id": [params["id"].toString()],
                    "seek_items": ["1"],
                    "start_num": [params["start_num"].toString()],
                    "log_visit": ["0"],
                    "a": ["fetch_items_categories"]
                }
            case FETCH_.FORUM:
                return {
                    "a": ["fetch_topics"],
                    "category_type": ["forum"],
                    "category_id": [params["id"].toString()]
                }
            default:
                console.error(":( !!! :(")
                break;
        }
    }

    static inferType(name, returnNull=false) {
        if (name.includes("OMMC")) {
            if (name.includes("final")) {
                return TYPES.AMO
            }
            return TYPES.OMMC
        }
        if (name.includes("RML")) {
            return TYPES.ARML
        }
        if (/[A-Z]MC/.test(name)) {
            if (/\b8\b/.test(name)) {
                TYPES.AMC.name = "AMC 8"
            } else if (/\b10\b/.test(name) || /\b11\b/.test("name")) {
                TYPES.AMC.name = "AMC 10"
            } else if (/\b12\b/.test(name)) {
                TYPES.AMC.name = "AMC 12"
            } else {
                TYPES.AMC.name = "AMC"
            }
            return TYPES.AMC
        }
        if (/\bHMMT\b/.test(name)) {
            return TYPES.HMMT
        }
        if (name.includes("IME") && !(name.includes("(AIME level)"))) {
            // why c3676367 are you name liked that
            return TYPES.AIME
        }
        if (name.includes("MO")) {
            return TYPES.AMO
        }
        if (name.toLowerCase().includes("pumac")) {
            return TYPES.COMPUTE
        }
        if (returnNull) {
            return null
        }
        return TYPES.UNKNOWN
    }

    static toSearchParams(formData) {
        const searchParams = new URLSearchParams();

        for (const key in formData) {
            if (Array.isArray(formData[key])) {
                // Append each array element with the same key name (no brackets)
                formData[key].forEach(val => searchParams.append(key, val));
            } else {
                searchParams.append(key, formData[key]);
            }
        }
        return searchParams;
    }

    constructor(loggedIn, userId, sessionId, headers=null) {
        this.loggedIn = loggedIn;
        this.userId = userId;
        this.sessionId = sessionId;
        this.headers = headers;
        this.debug = true
    }

    log(message) {
        if (this.debug) {
            console.log(message);
        }
    }

    /**
     * @param {Object} bodyInput - A map of keys to arrays of strings
     */
    sendRequest(bodyInput) {
        // 1. Prepare base data
        // Note: AoPS usually expects 1/0 for booleans in ajax.php
        const formData = {
            "aops_logged_in": this.loggedIn ? "1" : "0",
            "aops_user_id": this.userId.toString(),
            "aops_session_id": this.sessionId,
            ...bodyInput
        };
        let init = {
            method: "POST",
            body: ForumSession.toSearchParams(formData),
            credentials: "include"
        }
        if (this.headers) {
            Object.assign(init, {headers: this.headers});
        }
        return fetch("https://artofproblemsolving.com/m/community/ajax.php", init).then(response => {
            return response.json();
        })
    }

    /**
     *
     * @param {number} id
     */
    async getForum(id) {
        let r = await this.sendRequest(ForumSession.payload(FETCH_.FORUM, {id: id}))
        let posts = []
        while (!r.no_more_topics) {
            if (r.response.topics.length === 0) {
                break;
            }
            posts.push(...r.response.topics)
            r = await this.sendRequest({
                ...ForumSession.payload(FETCH_.FORUM, {id: id}),
                ...{
                    "fetch_before": [r.response.topics[r.response.topics.length - 1].last_post_time.toString()]
                }
            })
        }
        return posts
    }

    async getAllTests(id, type=null, shownDepth=1, done=[], returnDone=false) {
        let response = (await this.sendRequest(
            ForumSession.payload(FETCH_.CATEGORY_DATA, {"id": id})
        )).response;
        this.log(response);

        let pCount = 0
        let tests = []
        let items = response.category.items
        let name = response.category.category_name

        if (type == null) {
            type = ForumSession.inferType(name, true)
        }
        while (!response.no_more_items) {
            response = (await this.sendRequest(
                ForumSession.payload(FETCH_.ITEMS_CATEGORIES, {
                    "id": id,
                    "start_num": items.length
                })
            )).response
            if (response.no_more_items) {
                break;
            }
            items.push(...response.new_items)
        }
        for (let i=0; i <items.length; ++i) {
            if (
                items[i].item_type === "forum" ||
                items[i].item_type === "post"
            ) {
                // ignore forums
                items[i] = null
                continue;
            }
            if (CONTEST_IDS.IGNORE.includes(items[i].item_id) || done.includes(items[i].item_id)) {
                // ignore already done things
                this.log(`Ignoring: ${items[i].item_id}`)
                items[i] = null
                continue;
            }
        }
        items = items.filter(item => (item !== null))
        for (let i = 0; i < items.length; i++) {
            this.log(items[i])
            switch (items[i].item_type) {
                case "folder":
                    this.log("========")
                    let subTests = await this.getAllTests(items[i].item_id, type, shownDepth - 1, done)
                    pCount += subTests.count
                    if (shownDepth > 0) {
                        tests.push(subTests)
                    } else {
                        tests.push(...(subTests["tests"]))
                    }
                    done.push(items[i].item_id)
                    break;
                case "view_posts": // Test
                    done.push(items[i].item_id)
                    let t = (await this.getTest(items[i].item_id, type))
                    pCount += t.count
                    tests.push(t)
                    break;
                default:
                    this.log("What da " + items[i].item_type)
                    break;
            }
        }
        let all = {
            "name": name,
            "tests": tests,
            "count": pCount,
        }
        if (returnDone) {
            all["done"] = done
        }
        return all
    }

    static isPostDesc(item) {
        return (
            item.post_data.post_type === "view_posts_text" ||
            item.post_data.topic_id === 0
        )
    }

    /**
     * Spaghetti, refactor later
     * @param {number} id
     * @param {number | null} testType Type of Test (AMC, etc) or infer type
     */
    async getTest(id, testType=null) {
        let test = {
            sections: [],
            problems: [],
            id: id
        }
        let response = (await this.sendRequest(
            ForumSession.payload(FETCH_.CATEGORY_DATA, {"id": id})
        )).response
        this.log(response)
        test.name = response.category.category_name;
        test.year = CleanupText.extractYear(test.name)
        let type = ForumSession.inferType(response.category.category_name, true)
        if (type == null) {
            type = testType || TYPES.UNKNOWN
        }

        this.log(`Test ${id} | Type: ${type.name}`)
        let sectionCounter = -1;
        let n = 0;
        let isPrevMulti = false;
        let pCount = 0;

        let item;
        let isOly = (type.computational === false)
        for (let i = 0; i < response.category.items.length; ++i) {
            item = response.category.items[i]
            // day 1, day 2 oly is treated no as separate
            if (!isOly && ForumSession.isPostDesc(item)) {
                // multi-section header OR just problems
                let isSameAs = (/^same as ([a-zA-Z]+ ){1,3}(\d+)$/).test(item.post_data.post_canonical)
                if (
                    (
                        i + 1 < response.category.items.length &&
                        ForumSession.isPostDesc(response.category.items[i + 1])
                    ) || (
                        isSameAs
                    )
                ) {
                    if (isSameAs) {
                        n++
                    }
                    continue;
                }
                if (/^(?:[dD]ay)\s\d+$/.test(item.post_data.post_canonical)) {
                    // isOly = true, but since we already ...
                    type = TYPES.AMO
                }
                test.sections.push(item.post_data.post_canonical)
                sectionCounter++
                n = 0
                isPrevMulti = false
                test.problems.push([])
            } else if (
                item.post_data.post_type === "forum"
                && item.item_type !== "post_hidden"
            ) {
                let processed = CleanupText.toAsyLinks(item.post_data.post_canonical, item.post_data.post_rendered)
                let isMulti;
                if ((n === 0 || isPrevMulti) && (isMulti = CleanupText.checkContainsMultiple(processed, n + 1)).length > 1) {
                    isPrevMulti = true
                    for (let j = 0; j < isMulti.length; ++j) {
                        let problem = {
                            statement: CleanupText.cleanChoices(isMulti[j]),
                            post_id: item.post_data.post_id,
                            topic_id: item.post_data.topic_id
                        }
                        if (type.choices) {
                            problem.choices = CleanupText.extractChoices(isMulti[j])
                        }
                        addProblem(problem, sectionCounter, test)
                        pCount++
                    }
                    n += isMulti.length
                } else {
                    let problem = {
                        statement: CleanupText.cleanProblem(processed),
                        post_id: item.post_data.post_id,
                        topic_id: item.post_data.topic_id,
                    }
                    problem.n = n
                    problem.answer = null
                    if (type.computational) {
                        // Look for answer
                        problem.answer =
                            (ForumSession.MORE_INFO === "NO_PERMISSION") ? null : (await this.searchTopicForAnswer(problem.topic_id))
                        if (type.choices) {
                            problem.choices = CleanupText.extractChoices(problem.statement)
                            problem.statement = CleanupText.cleanChoices(problem.statement).trim()
                            if (problem.answer != null) {
                                let bruh = CleanupText.parseMCQAns(problem.answer)
                                if (bruh == null) {
                                    problem.answer = -1
                                } else {
                                    if (bruh.type === "letter") {
                                        problem.answer = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].indexOf(bruh.value)
                                    } else {
                                        problem.answer = problem.choices.indexOf(bruh.value)
                                    }
                                }
                                // problem.answer = problem.choices.indexOf(problem.answer)
                            } else {
                                problem.answer = -1
                            }
                        } else {
                            problem.choices = [problem.answer]
                            problem.answer = 0
                        }
                    }
                    addProblem(problem, sectionCounter, test)
                    pCount++
                    n++
                }
            }
        }
        test.computational = type.computational
        test.type = type.name
        if (test.sections.length === 2) { // why c3676367
            if (test.problems[1].length === 1) {
                test.sections.pop()
            }
        }
        if (test.sections.length === 1) {
            test.sections.pop()
            let np = []
            for (let i = 0; i < test.problems.length; i++) {
                if (Array.isArray(test.problems[i])) {
                    np.push(...test.problems[i])
                } else {
                    np.push(test.problems[i])
                }
            }
            test.problems = np
        }
        if (type.name === "AIME") {
            if (item.item_text.toLowerCase() === "answer key") {
                let r = /(?:1[0-5]|[1-9])\.\s(\d{3})/g
                if (r.test(item.post_data.post_canonical)) {
                    let ansy = [...item.post_data.post_canonical.matchAll(r)].map(m => m[1])
                    for (let i = 0; i < 15; ++i) {
                        test.problems[i].choices = [ansy[i]]
                    }
                }
            }
        }
        test.count = pCount
        ForumSession.MORE_INFO = null
        return test
    }

    async searchTopicForAnswer(id) {
        let response = await this.sendRequest(
            ForumSession.payload(FETCH_.TOPIC, {"id": id})
        )
        if (response.error_code === "E_NO_PERMISSION") {
            ForumSession.MORE_INFO = "NO_PERMISSION"
            return null;
        }
        for (let post of (response.response.topic.posts_data) ) {
            let a = CleanupText.getBoxed(post.post_canonical)
            if (a != null) {
                return a
            }
        }
        return null
    }
}