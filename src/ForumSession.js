import { CleanupText } from "./CleanupText.js";
import { CONTEST_IDS, TYPES, SOLUTIONS_USERS } from "../contest_id.js";

export const ApiMethod = {
    TOPIC: 0,
    CATEGORY_DATA: 1,
    FORUM: 2,
    ITEMS_CATEGORIES: 3,
};

const MAA_COPYRIGHT_POST_ID = 4956172;
const CHMMC_MIXER_ITEM_TEXT = "Mixer";
const MCQ_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

function toSearchParams(formData) {
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

function isPostDesc(item) {
    return (
        item.post_data.post_type === "view_posts_text" ||
        item.post_data.topic_id === 0
    );
}

function addProblemToTest(problem, ctx, test, onProblemAdd) {
    if (ctx.sectionCounter >= 0) {
        problem.section = ctx.sectionCounter;
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

    static inferType(name, returnNull = false, explicitType = null) {
        if (explicitType && TYPES[explicitType]) return TYPES[explicitType];

        if (name.includes("OMMC")) {
            return name.includes("final") ? TYPES.AMO : TYPES.COMPUTE;
        }
        if (name.includes("Solstice Math Olympiad")) return TYPES.COMPUTE;
        if (name.includes("CUBRMC")) return TYPES.COMPUTE;
        if (name.includes("RML")) return TYPES.ARML;

        if (/[A-Z]MC/.test(name)) {
            let amcName = "AMC";
            if (/\b8\b/.test(name)) amcName = "AMC 8";
            else if (/\b10\b/.test(name) || /\b11\b/.test(name))
                amcName = "AMC 10";
            else if (/\b12\b/.test(name)) amcName = "AMC 12";
            return { ...TYPES.AMC, name: amcName };
        }

        if (/\bHMMT\b/.test(name)) return TYPES.COLLEGE;

        for (const collegeName of CONTEST_IDS.CollegeComp) {
            if (name.toLowerCase().includes(collegeName.name.toLowerCase())) {
                return TYPES.COLLEGE;
            }
        }

        if (name.includes("IME") && !name.includes("(AIME level)"))
            return TYPES.AIME;
        if (name.includes("MO") || name.includes("USAMTS")) return TYPES.AMO;

        if (returnNull) return null;
        return TYPES.UNKNOWN;
    }

    constructor(
        loggedIn,
        userId,
        sessionId,
        headers = null,
        onProblemAdd = null,
    ) {
        this.loggedIn = loggedIn;
        this.userId = userId;
        this.sessionId = sessionId;
        this.headers = headers;
        this.debug = true;
        this.onProblemAdd = onProblemAdd ?? (() => {});
        this._permissionDenied = false;
        this._currentForumCategoryId = null;
        this.enableStickyAnswerKey = false;
        this.requestDelay = [100, 250];
        this.cache = null;
    }

    log(message) {
        if (this.debug) {
            console.log(message);
        }
    }

    async sendRequest(bodyInput) {
        if (this.cache && this.cache.has(bodyInput)) {
            return await this.cache.get(bodyInput);
        }

        const formData = {
            aops_logged_in: this.loggedIn ? "1" : "0",
            aops_user_id: this.userId.toString(),
            aops_session_id: this.sessionId,
            ...bodyInput,
        };
        const init = {
            method: "POST",
            credentials: "include",
        };
        if (this.headers) {
            Object.assign(init, { headers: this.headers });
        }

        if (this.requestDelay[0] > 0) {
            await new Promise((r) =>
                setTimeout(
                    r,
                    this.requestDelay[0] +
                        (this.requestDelay[1] - this.requestDelay[0]) *
                            Math.random(),
                ),
            );
        }

        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const response = await fetch(
                "https://artofproblemsolving.com/m/community/ajax.php",
                {
                    ...init,
                    body: toSearchParams(formData),
                },
            );
            const text = await response.text();
            if (text.includes("challenges.cloudflare.com")) {
                if (attempt === MAX_RETRIES) {
                    throw new Error(
                        "Cloudflare challenge page returned after all retries. If this keeps happening, copy fresh headers from your browser's DevTools and update .env.js.",
                    );
                }
                const delay = 5000 * (attempt + 1);
                console.log(
                    `\nCloudflare challenge (attempt ${attempt + 1}/${MAX_RETRIES + 1}), waiting ${delay / 1000}s...`,
                );
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            try {
                const parsed = JSON.parse(text);
                if (this.cache) await this.cache.set(bodyInput, parsed);
                return parsed;
            } catch (e) {
                if (attempt === MAX_RETRIES) {
                    console.error(
                        `\nFailed to parse JSON after ${MAX_RETRIES + 1} attempts. Response: ${text.slice(0, 500)}`,
                    );
                    throw e;
                }
                const delay = 1000 * 2 ** attempt;
                console.log(
                    `\nJSON parse failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`,
                );
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    async _fetchCategory(id) {
        const fullResponse = await this.sendRequest(
            ForumSession.payload(ApiMethod.CATEGORY_DATA, { id }),
        );
        if (fullResponse.error_code) {
            throw new Error(
                `API error for category ${id}: ${fullResponse.error_code}`,
            );
        }
        let response = fullResponse.response;
        this.log(response);

        if (!response.category) {
            throw new Error(
                `No category data for id ${id}. Full response: ${JSON.stringify(fullResponse)}`,
            );
        }

        const name = response.category.category_name;
        const items = [...response.category.items];

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

        return { name, items };
    }

    async getForum(id, checkToStop = null) {
        let r = await this.sendRequest(
            ForumSession.payload(ApiMethod.FORUM, { id }),
        );
        const posts = [];
        const shouldStop = checkToStop ?? (() => false);
        while (!r["no_more_topics"]) {
            if (r.response["topics"].length === 0) break;
            posts.push(...r.response["topics"]);
            if (shouldStop(posts)) return posts;
            r = await this.sendRequest({
                ...ForumSession.payload(ApiMethod.FORUM, { id }),
                fetch_before: [
                    r.response.topics[
                        r.response.topics.length - 1
                    ].last_post_time.toString(),
                ],
            });
        }
        return posts;
    }

    async getAllTests(
        id,
        type = null,
        shownDepth = 1,
        done = new Set(),
        returnDone = false,
    ) {
        const doneProblems = [];
        const { name, items: allItems } = await this._fetchCategory(id);

        if (type == null) {
            type = ForumSession.inferType(name, true);
        }

        let pCount = 0;
        const tests = [];

        const items = allItems.filter((item) => {
            if (item.item_type === "forum" || item.item_type === "post")
                return false;
            if (
                CONTEST_IDS.IGNORE.includes(item.item_id) ||
                done.has(item.item_id)
            ) {
                this.log(`Ignoring: ${item.item_id}`);
                return false;
            }
            return true;
        });

        for (const item of items) {
            this.log(item);
            switch (item.item_type) {
                case "folder": {
                    this.log("========");
                    done.add(item.item_id);
                    const subTests = await this.getAllTests(
                        item.item_id,
                        type,
                        shownDepth - 1,
                        done,
                    );
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
                    done.add(item.item_id);
                    const t = await this.getTest(
                        item.item_id,
                        type,
                        doneProblems,
                    );
                    pCount += t.count;
                    if (t.count > 0) tests.push(t);
                    break;
                }
                default:
                    this.log("Unexpected item_type: " + item.item_type);
                    break;
            }
        }

        const result = { id: Number(id), name, tests, count: pCount };
        if (returnDone) result["done"] = done;
        return result;
    }

    async getAllTestsMulti(ids, name, type = null) {
        const allTests = [];
        let totalCount = 0;
        const done = new Set();

        for (const id of ids) {
            const { items } = await this._fetchCategory(id);
            // Check if this category is forum-type
            const hasForum = items.some((item) => item.item_type === "forum");
            if (hasForum) {
                // Route to getForum behavior — skip for now, forum handling is separate
                this.log(
                    `Category ${id} appears to be forum-type, skipping in getAllTestsMulti`,
                );
                continue;
            }
            // Otherwise, treat as a regular test collection
            const subResult = await this.getAllTests(id, type, 0, done, false);
            allTests.push(...subResult.tests);
            totalCount += subResult.count;
        }

        return {
            ids: ids.map(Number),
            name,
            tests: allTests,
            count: totalCount,
        };
    }

    async getTest(id, testType = null, done = []) {
        this._currentForumCategoryId = null;
        const { name, items } = await this._fetchCategory(id);
        const test = { sections: [], problems: [], id, name };
        test.year = CleanupText.extractYear(name);

        let type =
            ForumSession.inferType(name, true) ?? testType ?? TYPES.UNKNOWN;
        this.log(`Test ${id} | Type: ${type.name}`);

        const isOly = type.computational === false;
        const ctx = {
            sectionCounter: -1,
            problemIndex: 0,
            isPrevMulti: false,
            pCount: 0,
        };
        let lastItem = null;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            lastItem = item;

            if (!isOly && isPostDesc(item)) {
                // Normally a view_posts_text item is a section/description
                // marker. But some contests pack the entire problem set into
                // a single such post (numbered "1. … 2. …" with choices) and
                // expose no per-problem forum topics. Detect that and route it
                // through the problem path instead of dropping it as a title.
                if (this._isPackedProblemPost(item, ctx)) {
                    await this._handleProblemItem(item, type, ctx, test, done);
                } else {
                    type = this._handleSectionMarker(
                        item,
                        items[i + 1],
                        ctx,
                        test,
                        type,
                    );
                }
            } else if (this._isProblemItem(item, done)) {
                await this._handleProblemItem(item, type, ctx, test, done);
            }
        }

        test.computational = type.computational;
        test.type = type.name;

        // Prefer an answer key embedded directly in the test category — it
        // ships with the data we already fetched, no extra request. Fall back
        // to the stickied forum lookup only when none is present.
        const inCategoryKey = !isOly
            ? this._extractInCategoryAnswerKey(items, name)
            : null;
        if (inCategoryKey) {
            this._applyForumAnswerKey(test, inCategoryKey, type);
        } else if (
            this.enableStickyAnswerKey &&
            !isOly &&
            this._currentForumCategoryId
        ) {
            const answerMap = await this._fetchStickyAnswerKey(
                this._currentForumCategoryId,
                name,
            );
            if (answerMap) this._applyForumAnswerKey(test, answerMap, type);
        }

        this._normalizeSections(test);
        test.count = ctx.pCount;
        this._permissionDenied = false;
        return test;
    }

    _isPackedProblemPost(item, ctx) {
        // Only the first content item (or right after a multi-post) can begin
        // a numbered set — this mirrors the multi-detection guard in
        // _handleProblemItem so a match always routes to _handleMultiProblem.
        if (ctx.problemIndex !== 0 && !ctx.isPrevMulti) return false;
        const processed = CleanupText.toAsyLinks(
            item.post_data.post_canonical,
            item.post_data.post_rendered,
        );
        return (
            CleanupText.checkContainsMultiple(processed, ctx.problemIndex + 1)
                .length > 1
        );
    }

    _isProblemItem(item, done) {
        return (
            item.post_data.post_type === "forum" &&
            item.item_type !== "post_hidden" &&
            item.post_data.post_id !== MAA_COPYRIGHT_POST_ID &&
            item.item_text !== CHMMC_MIXER_ITEM_TEXT &&
            !done.includes(item.post_data.topic_id)
        );
    }

    _handleSectionMarker(item, nextItem, ctx, test, type) {
        const isSameAs = /^same as ([a-zA-Z]+ ){1,3}(\d+)$/.test(
            item.post_data.post_canonical,
        );
        if ((nextItem && isPostDesc(nextItem)) || isSameAs) {
            if (isSameAs) ctx.problemIndex++;
            return type;
        }
        if (/^(?:[dD]ay)\s\d+$/.test(item.post_data.post_canonical)) {
            type = TYPES.AMO;
        }
        if (item.post_data.post_canonical.trim() === "Mixer Round") {
            return type;
        }
        test.sections.push(item.post_data.post_canonical.trim());
        ctx.sectionCounter++;
        ctx.problemIndex = 0;
        ctx.isPrevMulti = false;
        test.problems.push([]);
        return type;
    }

    async _handleProblemItem(item, type, ctx, test, done) {
        const processed = CleanupText.toAsyLinks(
            item.post_data.post_canonical,
            item.post_data.post_rendered,
        );

        let isMulti;
        if (
            (ctx.problemIndex === 0 || ctx.isPrevMulti) &&
            (isMulti = CleanupText.checkContainsMultiple(
                processed,
                ctx.problemIndex + 1,
            )).length > 1
        ) {
            await this._handleMultiProblem(
                isMulti,
                item,
                type,
                ctx,
                test,
                done,
            );
        } else {
            await this._handleSingleProblem(
                processed,
                item,
                type,
                ctx,
                test,
                done,
            );
        }
    }

    async _handleMultiProblem(isMulti, item, type, ctx, test, done) {
        ctx.isPrevMulti = true;
        let answers = null;
        let topicSolutions = [];
        if (type.computational) {
            const topicData = await this.searchTopicForSolutions(
                item.post_data.topic_id,
                true,
                false,
            );
            answers = topicData.answers; // for multi-problem, returns a map
            topicSolutions = topicData.solutions;
        }
        for (let j = 0; j < isMulti.length; j++) {
            const problem = {
                statement: CleanupText.cleanChoices(isMulti[j]),
                post_id: item.post_data.post_id,
                topic_id: item.post_data.topic_id,
                n: j + ctx.problemIndex,
                choices: null,
                raw_answer: null,
                answer: -1,
                solutions: j === 0 ? topicSolutions : [],
                all_posts: [],
            };
            if (type.computational) {
                const answer = answers?.[(j + 1).toString()] ?? null;
                if (type.choices) {
                    problem.raw_answer = answer;
                    problem.choices = CleanupText.extractChoices(isMulti[j]);
                    problem.answer = problem.choices.indexOf(answer);
                } else {
                    this._setNumericAnswer(problem, answer);
                }
            }
            addProblemToTest(problem, ctx, test, this.onProblemAdd);
            done.push(item.post_data.topic_id);
            ctx.pCount++;
        }
        ctx.problemIndex += isMulti.length;
    }

    async _handleSingleProblem(processed, item, type, ctx, test, done) {
        const problem = await this._buildProblem(
            processed,
            type,
            item.post_data.topic_id,
        );
        problem.post_id = item.post_data.post_id;
        problem.topic_id = item.post_data.topic_id;
        problem.n = ctx.problemIndex;
        addProblemToTest(problem, ctx, test, this.onProblemAdd);
        done.push(problem.topic_id);
        ctx.pCount++;
        ctx.problemIndex++;
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

    _extractInCategoryAnswerKey(items, name = null) {
        // Some tests carry their answer key as a hidden post right inside the
        // category (item_text like "answer key"). It is dropped from the
        // problem list by _isProblemItem, so parse it here separately.
        const keyItem = items.find(
            (item) =>
                item.item_type === "post_hidden" &&
                /answers?\s*key/i.test(item.item_text ?? ""),
        );
        if (!keyItem) return null;

        const answerMap = CleanupText.parseAnswerKey(
            keyItem.post_data?.post_canonical ?? "",
            name,
        );
        return answerMap && Object.keys(answerMap).length > 0
            ? answerMap
            : null;
    }

    async _fetchStickyAnswerKey(forumCategoryId, testName) {
        const fullResponse = await this.sendRequest(
            ForumSession.payload(ApiMethod.CATEGORY_DATA, {
                id: forumCategoryId,
            }),
        );

        if (fullResponse.error_code) return null;
        const topicsData = fullResponse.response.category?.topics_data ?? {};

        const candidates = Object.values(topicsData).filter(
            (t) =>
                t.announce_type === "local" &&
                /answer\s*key/i.test(t.topic_title ?? ""),
        );

        if (candidates.length === 0) return null;

        let best = candidates[0];

        if (candidates.length > 1) {
            const testWords = new Set(testName.toLowerCase().split(/\s+/));
            let bestScore = -1;
            for (const c of candidates) {
                const stripped = (c.topic_title ?? "")
                    .toLowerCase()
                    .replace(/\banswer\b|\bkey\b/g, "")
                    .trim();
                const score = stripped
                    .split(/\s+/)
                    .filter((w) => w && testWords.has(w)).length;
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
            if (bestScore === 0) return null;
        }

        const answerMap = {};
        const parsePosts = (posts) => {
            for (const post of posts) {
                // If fetching sticky answers turn wrong, it might be parseAnswerKey not parsing correctly.
                const parsed = CleanupText.parseAnswerKey(
                    post.post_canonical,
                    testName,
                );
                if (!parsed) continue;
                for (const [num, ans] of Object.entries(parsed)) {
                    if (!answerMap[num]) answerMap[num] = ans;
                }
            }
        };

        parsePosts(best.posts_data ?? []);

        // Fall back to fetch_topic if topics_data only included a subset of posts
        // Ignore for now
        /*if (Object.keys(answerMap).length === 0) {
            const topicResponse = await this.sendRequest(
                ForumSession.payload(ApiMethod.TOPIC, { id: best.topic_id }),
            );
            if (!topicResponse.error_code) {
                parsePosts(topicResponse.response.topic.posts_data ?? []);
            }
        }*/

        return Object.keys(answerMap).length > 0 ? answerMap : null;
    }

    _applyForumAnswerKey(test, answerMap, type) {
        let counter = 0;
        const apply = (problem) => {
            counter++;
            const ans = answerMap[String(counter)];
            if (ans == null) return;
            if (type.choices) {
                // MCQ: answer key is authoritative — override \boxed{} result
                problem.raw_answer = ans;
                const parsed = CleanupText.parseMCQAns(ans);
                if (parsed?.type === "letter") {
                    problem.answer = MCQ_LETTERS.indexOf(parsed.value);
                } else if (parsed) {
                    problem.answer = (problem.choices ?? []).indexOf(
                        parsed.value,
                    );
                }
            } else if (problem.raw_answer == null) {
                // Numeric: only fill when \boxed{} found nothing
                this._setNumericAnswer(problem, ans);
            }
        };

        if (test.problems.length > 0 && Array.isArray(test.problems[0])) {
            for (const section of test.problems) {
                for (const problem of section) apply(problem);
            }
        } else {
            for (const problem of test.problems) apply(problem);
        }
    }

    _setNumericAnswer(problem, rawAnswer) {
        // Numeric problems have no MCQ choices, but a known answer is still
        // representable as a single-element choice list with the index at 0 —
        // matching how the CSV/DB layer normalizes them. When no answer is
        // known, leave choices null / answer -1 to signal "unresolved".
        problem.raw_answer = rawAnswer ?? null;
        if (rawAnswer != null) {
            problem.choices = [rawAnswer];
            problem.answer = 0;
        } else {
            problem.choices = null;
            problem.answer = -1;
        }
    }

    async _buildProblem(processed, type, topic_id) {
        const problem = {
            statement: CleanupText.cleanProblem(processed),
            answer: -1,
            choices: null,
            raw_answer: null,
            solutions: [],
            all_posts: [],
        };

        if (!type.computational) {
            // OLY — fetch all posts for potential solutions
            const topicData = await this.searchTopicForSolutions(
                topic_id,
                false,
                true,
            );
            problem.solutions = topicData.solutions;
            problem.all_posts = topicData.all_posts;
            return problem;
        }

        const topicData = await this.searchTopicForSolutions(
            topic_id,
            false,
            false,
        );
        const rawAnswer = topicData.answer;
        problem.solutions = topicData.solutions;
        problem.raw_answer = rawAnswer;

        if (type.choices) {
            // MCQ (e.g. AMC)
            problem.choices = CleanupText.extractChoices(problem.statement);
            problem.statement = CleanupText.cleanChoices(
                problem.statement,
            ).trim();
            if (rawAnswer != null) {
                const parsed = CleanupText.parseMCQAns(rawAnswer);
                if (parsed == null) {
                    problem.answer = -1;
                } else if (parsed.type === "letter") {
                    problem.raw_answer = parsed.value; // normalize to just the letter
                    problem.answer = MCQ_LETTERS.indexOf(parsed.value);
                } else {
                    problem.answer = problem.choices.indexOf(parsed.value);
                }
            }
        } else {
            // Numeric (AIME, COMP, COLLEGE, etc.)
            this._setNumericAnswer(problem, rawAnswer);
        }

        return problem;
    }

    _isSolutionPost(post, content) {
        // Rule 1: [hide=...solution...]
        if (/\[hide\s*=[^\]]*solution[^\]]*\]/i.test(content)) return true;
        // Rule 2: QED markers
        if (/Q\.?E\.?D\.?|\\blacksquare|\\square/.test(content)) return true;
        // Rule 3: known solution poster
        if (
            post.poster_id &&
            (SOLUTIONS_USERS ?? []).some((u) => u.id === post.poster_id)
        )
            return true;
        // Rule 4: contains \boxed{} (computational answer marker)
        if (/\\boxed\s*\{/.test(content)) return true;
        // Rule 5: starts with "Proof", "Solution", "Sol."
        if (/^\s*(?:proof|solution|sol\.)/i.test(content.slice(0, 50)))
            return true;
        return false;
    }

    async searchTopicForSolutions(
        id,
        searchManyProblems = false,
        isOly = false,
    ) {
        // id 0 means the problems came from a packed view_posts_text post that
        // has no backing discussion topic — nothing to fetch.
        if (!id || this._permissionDenied) {
            return { answer: null, answers: {}, solutions: [], all_posts: [] };
        }

        const response = await this.sendRequest(
            ForumSession.payload(ApiMethod.TOPIC, { id }),
        );

        if (response.error_code === "E_NO_PERMISSION") {
            this._permissionDenied = true;
            return { answer: null, answers: {}, solutions: [], all_posts: [] };
        }

        const topic = response.response.topic;
        if (topic?.category_id && !this._currentForumCategoryId) {
            this._currentForumCategoryId = topic.category_id;
        }
        const posts = topic.posts_data ?? [];
        const solutions = [];
        const all_posts = [];
        let answer = null;
        const answers = {};

        for (const post of posts) {
            const content = post.post_canonical;

            // Extract answers
            if (searchManyProblems) {
                const hideTag =
                    /\[hide\s*=\s*(?:S|s)\s*(\d+)]([\s\S]*?)\[\/hide]/g;
                for (const match of content.matchAll(hideTag)) {
                    const boxed = CleanupText.getBoxed(match[2]);
                    if (boxed) answers[match[1]] = boxed;
                }
            } else if (answer == null) {
                answer = CleanupText.getBoxed(content);
            }

            // Collect all posts for OLY
            if (isOly) {
                all_posts.push({
                    post_id: post.post_id,
                    user_id: post.poster_id ?? null,
                    username: post.username ?? null,
                    content,
                    posted_at: post.post_time
                        ? new Date(post.post_time * 1000).toISOString()
                        : null,
                });
            }

            // Classify solution posts (skip post_type === 'view_posts_text' which is the problem statement)
            if (post.post_type === "view_posts_text") continue;
            if (this._isSolutionPost(post, content)) {
                solutions.push({
                    post_id: post.post_id,
                    topic_id: id,
                    user_id: post.poster_id ?? null,
                    username: post.username ?? null,
                    content,
                    posted_at: post.post_time
                        ? new Date(post.post_time * 1000).toISOString()
                        : null,
                });
            }
        }

        return { answer, answers, solutions, all_posts };
    }

    async searchTopicForAnswer(id, searchManyProblems = false) {
        const result = await this.searchTopicForSolutions(
            id,
            searchManyProblems,
            false,
        );
        if (searchManyProblems) return result.answers;
        return result.answer;
    }
}
