import { CleanupText } from "./CleanupText.js";
import { CONTEST_IDS, TYPES } from "../contest_id.js";

export const ApiMethod = {
    TOPIC: 0,
    CATEGORY_DATA: 1,
    FORUM: 2,
    ITEMS_CATEGORIES: 3,
};

const MAA_COPYRIGHT_POST_ID = 4956172;
const CHMMC_MIXER_ITEM_TEXT = "Mixer";
const AIME_PROBLEM_COUNT = 15;

const MCQ_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

function addProblemToTest(problem, sectionCounter, test, onProblemAdd) {
    if (sectionCounter >= 0) {
        problem.section = sectionCounter;
        test.problems[test.problems.length - 1].push(problem);
    } else {
        test.problems.push(problem);
    }
    onProblemAdd(problem);
}

export class ForumSession {
    static payload(methodType, params) {
        switch (methodType) {
            case ApiMethod.TOPIC:
                return {
                    a: ["fetch_topic"],
                    topic_id: [params["id"].toString()],
                };
            case ApiMethod.CATEGORY_DATA:
                return {
                    a: ["fetch_category_data"],
                    category_id: [params["id"].toString()],
                };
            case ApiMethod.ITEMS_CATEGORIES:
                return {
                    sought_category_ids: "[]",
                    parent_category_id: [params["id"].toString()],
                    seek_items: ["1"],
                    start_num: [params["start_num"].toString()],
                    log_visit: ["0"],
                    a: ["fetch_items_categories"],
                };
            case ApiMethod.FORUM:
                return {
                    a: ["fetch_topics"],
                    category_type: ["forum"],
                    category_id: [params["id"].toString()],
                };
            default:
                console.error("Unknown ApiMethod:", methodType);
                break;
        }
    }

    static inferType(name, returnNull = false) {
        if (name.includes("OMMC")) {
            return name.includes("final") ? TYPES.AMO : TYPES.COMPUTE;
        }
        if (name.includes("Solstice Math Olympiad")) return TYPES.COMPUTE;
        if (name.includes("CUBRMC")) return TYPES.COMPUTE;
        if (name.includes("RML")) return TYPES.ARML;

        if (/[A-Z]MC/.test(name)) {
            let amcName = "AMC";
            if (/\b8\b/.test(name))       amcName = "AMC 8";
            else if (/\b10\b/.test(name) || /\b11\b/.test(name)) amcName = "AMC 10";
            else if (/\b12\b/.test(name)) amcName = "AMC 12";
            return { ...TYPES.AMC, name: amcName };
        }

        if (/\bHMMT\b/.test(name)) return TYPES.COLLEGE;

        for (let collegeName of CONTEST_IDS.CollegeComp) {
            if (name.toLowerCase().includes(collegeName.name.toLowerCase())) {
                return TYPES.COLLEGE;
            }
        }

        if (name.includes("IME") && !name.includes("(AIME level)")) return TYPES.AIME;
        if (name.includes("MO") || name.includes("USAMTS")) return TYPES.AMO;

        if (returnNull) return null;
        return TYPES.UNKNOWN;
    }

    static toSearchParams(formData) {
        const searchParams = new URLSearchParams();
        for (const key in formData) {
            if (Array.isArray(formData[key])) {
                formData[key].forEach((val) => searchParams.append(key, val));
            } else {
                searchParams.append(key, formData[key]);
            }
        }
        return searchParams;
    }

    static isPostDesc(item) {
        return (
            item.post_data.post_type === "view_posts_text" ||
            item.post_data.topic_id === 0
        );
    }

    constructor(loggedIn, userId, sessionId, headers = null, onProblemAdd = null) {
        this.loggedIn = loggedIn;
        this.userId = userId;
        this.sessionId = sessionId;
        this.headers = headers;
        this.debug = true;
        this.onProblemAdd = onProblemAdd ?? (() => {});
        this._permissionDenied = false;
    }

    log(message) {
        if (this.debug) {
            console.log(message);
        }
    }

    sendRequest(bodyInput) {
        const formData = {
            aops_logged_in: this.loggedIn ? "1" : "0",
            aops_user_id: this.userId.toString(),
            aops_session_id: this.sessionId,
            ...bodyInput,
        };
        let init = {
            method: "POST",
            body: ForumSession.toSearchParams(formData),
            credentials: "include",
        };
        if (this.headers) {
            Object.assign(init, { headers: this.headers });
        }
        return fetch("https://artofproblemsolving.com/m/community/ajax.php", init)
            .then((response) => response.json());
    }

    async getForum(id, checkToStop = null) {
        let r = await this.sendRequest(ForumSession.payload(ApiMethod.FORUM, { id }));
        let posts = [];
        let shouldStop = checkToStop ?? (() => false);
        while (!r["no_more_topics"]) {
            if (r.response["topics"].length === 0) break;
            posts.push(...r.response["topics"]);
            if (shouldStop(posts)) return posts;
            r = await this.sendRequest({
                ...ForumSession.payload(ApiMethod.FORUM, { id }),
                fetch_before: [
                    r.response.topics[r.response.topics.length - 1].last_post_time.toString(),
                ],
            });
        }
        return posts;
    }

    async getAllTests(id, type = null, shownDepth = 1, done = new Set(), returnDone = false) {
        let doneProblems = [];
        let fullResponse = await this.sendRequest(ForumSession.payload(ApiMethod.CATEGORY_DATA, { id }));
        if (fullResponse.error_code) {
            throw new Error(`API error for category ${id}: ${fullResponse.error_code}`);
        }
        let response = fullResponse.response;
        this.log(response);

        if (!response.category) {
            throw new Error(`No category data for id ${id}. Full response: ${JSON.stringify(fullResponse)}`);
        }

        let pCount = 0;
        let tests = [];
        let items = response.category.items;
        let name = response.category.category_name;

        if (type == null) {
            type = ForumSession.inferType(name, true);
        }

        while (!response.no_more_items) {
            response = (
                await this.sendRequest(
                    ForumSession.payload(ApiMethod.ITEMS_CATEGORIES, {
                        id,
                        start_num: items.length,
                    }),
                )
            ).response;
            if (response.no_more_items) break;
            items.push(...response.new_items);
        }

        items = items.filter((item) => {
            if (item.item_type === "forum" || item.item_type === "post") return false;
            if (CONTEST_IDS.IGNORE.includes(item.item_id) || done.has(item.item_id)) {
                this.log(`Ignoring: ${item.item_id}`);
                return false;
            }
            return true;
        });

        for (let i = 0; i < items.length; i++) {
            this.log(items[i]);
            switch (items[i].item_type) {
                case "folder": {
                    this.log("========");
                    done.add(items[i].item_id);
                    let subTests = await this.getAllTests(items[i].item_id, type, shownDepth - 1, done);
                    pCount += subTests.count;
                    if (subTests.count === 0) break;
                    if (shownDepth > 0) {
                        tests.push(subTests);
                    } else {
                        tests.push(...subTests["tests"]);
                    }
                    break;
                }
                case "view_posts": {
                    done.add(items[i].item_id);
                    let t = await this.getTest(items[i].item_id, type, doneProblems);
                    pCount += t.count;
                    if (t.count > 0) tests.push(t);
                    break;
                }
                default:
                    this.log("Unexpected item_type: " + items[i].item_type);
                    break;
            }
        }

        let result = { name, tests, count: pCount };
        if (returnDone) result["done"] = done;
        return result;
    }

    async getTest(id, testType = null, done = []) {
        let test = { sections: [], problems: [], id };
        let fullResponse = await this.sendRequest(ForumSession.payload(ApiMethod.CATEGORY_DATA, { id }));
        if (fullResponse.error_code) {
            throw new Error(`API error for category ${id}: ${fullResponse.error_code}`);
        }
        let response = fullResponse.response;
        this.log(response);

        if (!response.category) {
            throw new Error(`No category data for id ${id}. Full response: ${JSON.stringify(fullResponse)}`);
        }

        test.name = response.category.category_name;
        test.year = CleanupText.extractYear(test.name);

        let type = ForumSession.inferType(response.category.category_name, true);
        if (type == null) type = testType || TYPES.UNKNOWN;

        this.log(`Test ${id} | Type: ${type.name}`);

        let sectionCounter = -1;
        let problemIndex = 0;
        let isPrevMulti = false;
        let pCount = 0;
        let isOly = type.computational === false;
        let lastItem = null;

        for (let i = 0; i < response.category.items.length; ++i) {
            let item = response.category.items[i];
            lastItem = item;

            if (!isOly && ForumSession.isPostDesc(item)) {
                let isSameAs = /^same as ([a-zA-Z]+ ){1,3}(\d+)$/.test(
                    item.post_data.post_canonical,
                );
                if (
                    (i + 1 < response.category.items.length &&
                        ForumSession.isPostDesc(response.category.items[i + 1])) ||
                    isSameAs
                ) {
                    if (isSameAs) problemIndex++;
                    continue;
                }
                if (/^(?:[dD]ay)\s\d+$/.test(item.post_data.post_canonical)) {
                    type = TYPES.AMO;
                }
                if (item.post_data.post_canonical.trim() === "Mixer Round") {
                    continue;
                }
                test.sections.push(item.post_data.post_canonical.trim());
                sectionCounter++;
                problemIndex = 0;
                isPrevMulti = false;
                test.problems.push([]);

            } else if (
                item.post_data.post_type === "forum" &&
                item.item_type !== "post_hidden" &&
                item.post_data.post_id !== MAA_COPYRIGHT_POST_ID &&
                item.item_text !== CHMMC_MIXER_ITEM_TEXT &&
                !done.includes(item.post_data.topic_id)
            ) {
                let processed = CleanupText.toAsyLinks(
                    item.post_data.post_canonical,
                    item.post_data.post_rendered,
                );

                let isMulti;
                if (
                    (problemIndex === 0 || isPrevMulti) &&
                    (isMulti = CleanupText.checkContainsMultiple(processed, problemIndex + 1)).length > 1
                ) {
                    isPrevMulti = true;
                    let answers;
                    if (type.computational) {
                        answers = await this.searchTopicForAnswer(item.post_data.topic_id, true);
                    }
                    for (let j = 0; j < isMulti.length; ++j) {
                        let problem = {
                            statement: CleanupText.cleanChoices(isMulti[j]),
                            post_id: item.post_data.post_id,
                            topic_id: item.post_data.topic_id,
                            n: j + problemIndex,
                        };
                        if (type.computational) {
                            let answer = answers?.[(j + 1).toString()] ?? null;
                            if (type.choices) {
                                problem.choices = CleanupText.extractChoices(isMulti[j]);
                                problem.answer = problem.choices.indexOf(answer);
                            } else {
                                problem.choices = [answer];
                                problem.answer = 0;
                            }
                        }
                        addProblemToTest(problem, sectionCounter, test, this.onProblemAdd);
                        done.push(item.post_data.topic_id);
                        pCount++;
                    }
                    problemIndex += isMulti.length;

                } else {
                    let problem = await this.getProblem(processed, type, item.post_data.topic_id);
                    problem.post_id = item.post_data.post_id;
                    problem.topic_id = item.post_data.topic_id;
                    problem.n = problemIndex;
                    addProblemToTest(problem, sectionCounter, test, this.onProblemAdd);
                    done.push(problem.topic_id);
                    pCount++;
                    problemIndex++;
                }
            }
        }

        test.computational = type.computational;
        test.type = type.name;
        this._normalizeSections(test);
        this._applyAIMEAnswerKey(test, type, lastItem);
        test.count = pCount;
        this._permissionDenied = false;
        return test;
    }

    _normalizeSections(test) {
        if (test.sections.length === 2 && test.problems[1].length === 1) {
            test.sections.pop();
        }
        if (test.sections.length === 1) {
            test.sections.pop();
            test.problems = test.problems.flat();
        }
    }

    _applyAIMEAnswerKey(test, type, lastItem) {
        if (type.name !== "AIME") return;
        if (lastItem?.item_text?.toLowerCase() !== "answer key") return;
        const answerPattern = /(?:1[0-5]|[1-9])\.\s(\d{3})/g;
        if (!answerPattern.test(lastItem.post_data.post_canonical)) return;
        const answers = [...lastItem.post_data.post_canonical.matchAll(answerPattern)].map(m => m[1]);
        for (let i = 0; i < AIME_PROBLEM_COUNT; ++i) {
            test.problems[i].choices = [answers[i]];
        }
    }

    async getProblem(processed, type, topic_id) {
        let problem = { statement: CleanupText.cleanProblem(processed) };
        problem.answer = null;

        if (!type.computational) return problem;

        problem.answer = await this.searchTopicForAnswer(topic_id);

        if (type.choices) {
            problem.choices = CleanupText.extractChoices(problem.statement);
            problem.statement = CleanupText.cleanChoices(problem.statement).trim();
            if (problem.answer != null) {
                let parsed = CleanupText.parseMCQAns(problem.answer);
                if (parsed == null) {
                    problem.answer = -1;
                } else if (parsed.type === "letter") {
                    problem.answer = MCQ_LETTERS.indexOf(parsed.value);
                } else {
                    problem.answer = problem.choices.indexOf(parsed.value);
                }
            } else {
                problem.answer = -1;
            }
        } else {
            problem.choices = [problem.answer];
            problem.answer = 0;
        }

        return problem;
    }

    async searchTopicForAnswer(id, searchManyProblems = false) {
        if (this._permissionDenied) return null;

        let response = await this.sendRequest(ForumSession.payload(ApiMethod.TOPIC, { id }));

        if (response.error_code === "E_NO_PERMISSION") {
            this._permissionDenied = true;
            return null;
        }

        if (searchManyProblems) {
            let answers = {};
            let hideTag = /\[hide\s*=\s*(?:S|s)\s*(\d+)]([\s\S]*?)\[\/hide]/g;
            for (let post of response.response.topic.posts_data) {
                for (let matches of post["post_canonical"].matchAll(hideTag)) {
                    let answer = CleanupText.getBoxed(matches[2]);
                    if (answer) answers[matches[1]] = answer;
                }
            }
            return answers;
        }

        for (let post of response.response.topic.posts_data) {
            let a = CleanupText.getBoxed(post.post_canonical);
            if (a != null) return a;
        }
        return null;
    }
}
