import { CleanupText } from "./CleanupText.js";
import { CONTEST_IDS, TYPES, SOLUTIONS_USERS } from "../contest_id.js";
import { foldedSectionMetadata } from "./testMetadata.js";

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

// A problem's own label as AoPS shows it in the category listing: "7", "B1",
// "12a". Section headers carry either no item_text at all or a non-label one
// ("2022-23"), which is what separates the two kinds of non-forum item.
const PROBLEM_LABEL = /^[A-Za-z]{0,2}\d+[a-z]?$/;

// A slot whose body only says the statement isn't there: a redacted problem or
// a pointer at the problem it duplicates. It still owns its number.
const PLACEHOLDER_SLOT = /^(?:redacted|removed|voided?|n\/?a|same as\b.*)$/i;

// Some problems are posted as plain text instead of a forum topic — redacted
// problems, "Same as A5" duplicate markers, joke problems. They reach us as
// view_posts_text items just like section headers do, and are told apart by
// AoPS's own label rather than by matching their body against a phrase list.
function isProblemSlot(item) {
   return PROBLEM_LABEL.test((item.item_text ?? "").trim());
}

// Whether an item can open a section, used both to route it and to look ahead
// from the item before it. Deliberately ignores packed-post detection: that
// depends on how many problems have been walked so far, which is unknown for
// an item we haven't reached yet.
function isHeaderItem(item, isOly) {
   return !isOly && isPostDesc(item) && !isProblemSlot(item);
}

// A section header naming the day a test was administered ("March 13th",
// "February 7th, 2023"). AoPS heads each half of an AIME category with a roman
// numeral followed by its date, and the date is the header the walk keeps.
const ADMINISTRATION_DATE =
   /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

// The one place that resolves `problems`' flat-or-sectioned union. Safe only
// because _normalizeSections materializes the shape before any consumer runs,
// so the array is never a mix of problems and section buckets.
function allProblems(test) {
   return test.problems.length > 0 && Array.isArray(test.problems[0])
      ? test.problems.flat()
      : test.problems;
}

function isInCategoryAnswerKey(item) {
   return (
      item.item_type === "post_hidden" &&
      /answers?\s*key/i.test(item.item_text ?? "")
   );
}

// Single source of truth for the scraped-problem shape. Both the single- and
// multi-problem paths build through this so every problem has identical fields.
// See ScrapedProblem in src/types.js.
export function makeProblem(fields) {
   return {
      statement: "",
      n: 0,
      section: -1,
      topicId: null,
      postId: null,
      choices: null, // MCQ options; null for numeric
      answerIndex: -1, // index into choices for MCQ; -1 if numeric/unknown
      answerValue: null, // literal answer: letter for MCQ, number for numeric
      solutions: [],
      posts: [], // all discussion posts (used for OLY solution curation)
      ...fields,
   };
}

// Problems always land in the current bucket — never straight into
// `test.problems`, so a header arriving mid-test can't leave that array a mix
// of problems and section buckets. `problem.section` is stamped later, by
// _normalizeSections, once the surviving buckets are known.
function addProblemToTest(problem, ctx, onProblemAdd) {
   ctx.buckets[ctx.buckets.length - 1].problems.push(problem);
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
                  (this.requestDelay[1] - this.requestDelay[0]) * Math.random(),
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
         const responseParent = await this.sendRequest(
            ForumSession.payload(ApiMethod.ITEMS_CATEGORIES, {
               id,
               start_num: items.length,
            }),
         );
         response = responseParent.response;
         if (responseParent.error_msg || response.no_more_items) break;

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
      seenCategoryIds = new Set(),
      returnSeen = false,
   ) {
      const seenTopicIds = [];
      const { name: rawName, items: allItems } = await this._fetchCategory(id);
      const name = CleanupText.normalizeContestName(rawName);

      if (type == null) {
         type = ForumSession.inferType(name, true);
      }

      let problemCount = 0;
      const tests = [];

      const items = allItems.filter((item) => {
         if (item.item_type === "forum" || item.item_type === "post")
            return false;
         if (
            CONTEST_IDS.IGNORE.includes(item.item_id) ||
            seenCategoryIds.has(item.item_id)
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
               seenCategoryIds.add(item.item_id);
               const subTests = await this.getAllTests(
                  item.item_id,
                  type,
                  shownDepth - 1,
                  seenCategoryIds,
               );
               problemCount += subTests.count;
               if (subTests.count === 0) break;
               if (shownDepth > 0) {
                  tests.push(subTests);
               } else {
                  tests.push(...subTests["tests"]);
               }
               break;
            }
            case "view_posts": {
               seenCategoryIds.add(item.item_id);
               const t = await this.getTest(item.item_id, type, seenTopicIds);
               problemCount += t.count;
               if (t.count > 0) tests.push(t);
               break;
            }
            default:
               this.log("Unexpected item_type: " + item.item_type);
               break;
         }
      }

      const result = { id: Number(id), name, tests, count: problemCount };
      if (returnSeen) result["seenCategoryIds"] = seenCategoryIds;
      return result;
   }

   async getAllTestsMulti(ids, name, type = null) {
      const allTests = [];
      let totalCount = 0;
      const seenCategoryIds = new Set();

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
         const subResult = await this.getAllTests(
            id,
            type,
            0,
            seenCategoryIds,
            false,
         );
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

   // Metadata-only walk of a series/folder: mirrors getAllTests' traversal but
   // does NOT fetch any problems. Returns the parent series name (normalized from
   // the top-level folder) plus a flat list of the leaf tests inside it, so a
   // caller can let the user pick one leaf id to feed into getTest and attach it
   // to the same series a full getAllTests scrape would produce.
   async listTests(id, seenCategoryIds = new Set(), _isRoot = true) {
      const { name: rawName, items: allItems } = await this._fetchCategory(id);
      const seriesName = CleanupText.normalizeContestName(rawName);

      const items = allItems.filter((item) => {
         if (item.item_type === "forum" || item.item_type === "post")
            return false;
         if (
            CONTEST_IDS.IGNORE.includes(item.item_id) ||
            seenCategoryIds.has(item.item_id)
         ) {
            return false;
         }
         return true;
      });

      const tests = [];
      for (const item of items) {
         switch (item.item_type) {
            case "folder": {
               seenCategoryIds.add(item.item_id);
               const sub = await this.listTests(
                  item.item_id,
                  seenCategoryIds,
                  false,
               );
               tests.push(...sub.tests);
               break;
            }
            case "view_posts": {
               seenCategoryIds.add(item.item_id);
               tests.push({
                  id: item.item_id,
                  name: CleanupText.normalizeContestName(item.item_text),
               });
               break;
            }
            default:
               break;
         }
      }

      return { seriesName, tests };
   }

   async getTest(id, testType = null, seenTopicIds = []) {
      this._currentForumCategoryId = null;
      const { name: rawName, items } = await this._fetchCategory(id);
      const name = CleanupText.normalizeContestName(rawName);
      const test = { sections: [], problems: [], id, name };
      test.year = CleanupText.extractYear(name);

      let type =
         ForumSession.inferType(name, true) ?? testType ?? TYPES.UNKNOWN;
      this.log(`Test ${id} | Type: ${type.name}`);

      const isOly = type.computational === false;
      // Hidden in-category answer keys are metadata, not structural content.
      // Parse the key now, then keep every matching item out of the problem /
      // section walk so a view_posts_text key cannot become a fake section.
      // The parsed answers are still applied only after answer resolution.
      const inCategoryKey = !isOly
         ? this._extractInCategoryAnswerKey(items, name)
         : null;
      const contentItems = items.filter((item) => !isInCategoryAnswerKey(item));
      // Problems accumulate into buckets — one implicit unnamed bucket up
      // front, one more per section header — and _normalizeSections turns the
      // surviving buckets into the flat-or-sectioned `problems` shape once the
      // whole category has been walked.
      const ctx = {
         buckets: [{ name: "", problems: [] }],
         problemIndex: 0,
         isPrevMulti: false,
         problemCount: 0,
      };

      for (let i = 0; i < contentItems.length; i++) {
         const item = contentItems[i];

         if (!isOly && isPostDesc(item)) {
            // A view_posts_text item is normally a section/description marker,
            // but two kinds of problem arrive this way too: a contest that
            // packs its whole problem set into one numbered post ("1. … 2. …"),
            // and a single problem posted as text rather than as a forum topic.
            if (this._isPackedProblemPost(item, ctx)) {
               await this._handleProblemItem(item, type, ctx, seenTopicIds);
            } else if (isProblemSlot(item)) {
               this._handleProblemSlot(item, type, ctx);
            } else {
               type = this._handleSectionMarker(
                  item,
                  contentItems[i + 1],
                  ctx,
                  type,
                  isOly,
               );
            }
         } else if (this._isProblemItem(item, seenTopicIds)) {
            await this._handleProblemItem(item, type, ctx, seenTopicIds);
         }
      }

      // Materialize `sections`/`problems` before anything reads them, so every
      // consumer below sees a settled flat-or-sectioned shape.
      this._normalizeSections(test, ctx);

      test.type = type.name;
      if (type.computational) {
         // Computational test: decide MCQ vs numeric from the problems' own
         // evidence (a majority vote), then resolve every \boxed{} answer.
         this._finalizeComputationalAnswers(test, type);
         test.computational = true;
      } else {
         // Proof (or unknown) test: no boxed-answer resolution.
         test.computational = type.computational;
         test.answerKind = type.computational === false ? "proof" : null;
      }

      // Prefer an answer key embedded directly in the test category — it
      // ships with the data we already fetched, no extra request. Fall back
      // to the stickied forum lookup only when none is present.
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

      // AIME quirk: AoPS files a year's two AIME administrations as one
      // category with two date-labeled sections ("March 16th"/"March 31st").
      // Rename them to the canonical "I"/"II" (in administration order) so the
      // section tests become "<year> AIME I"/"<year> AIME II", matching the
      // wiki series (which lists AIME I/II as separate tests) so they merge.
      // Only date-labeled sections are that pair: a mock AIME split into two
      // named rounds ("Individual Round"/"Team Round") or followed by an
      // appendix (an unnamed lead section plus a shortlist) is not, and must
      // keep its own labels.
      if (
         type.name === "AIME" &&
         test.sections.length === 2 &&
         test.sections.every(
            (s) => ADMINISTRATION_DATE.test(s) || /^I{1,2}$/.test(s),
         )
      ) {
         test.sections = ["I", "II"];
      }

      // AMC 10/12 quirk, the same shape as the AIME one above: AoPS files a
      // year's two administrations (three, in 2002) as one category and labels
      // the sections inconsistently — sometimes the bare version letter, more
      // often the administration date ("February 3rd", "November 16, 2022").
      // The wiki lists each version as its own test ("2015 AMC 10A"), so unless
      // these resolve to version letters the two sources never meet on the
      // (series, name, year) natural key and every AMC 10/12 lands twice.
      // resolveVersionSections returns null for anything that is not a version
      // split, so a mock AMC's named rounds keep their own labels.
      if (/^AMC\b/.test(type.name ?? "")) {
         const versions = CleanupText.resolveVersionSections(test.sections);
         if (versions) test.sections = versions;
      }

      test.count = ctx.problemCount;
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

   _isProblemItem(item, seenTopicIds) {
      return (
         item.post_data.post_type === "forum" &&
         item.item_type !== "post_hidden" &&
         item.post_data.post_id !== MAA_COPYRIGHT_POST_ID &&
         item.item_text !== CHMMC_MIXER_ITEM_TEXT &&
         !seenTopicIds.includes(item.post_data.topic_id)
      );
   }

   _handleSectionMarker(item, nextItem, ctx, type, isOly) {
      const body = item.post_data.post_canonical.trim();
      // An unlabeled "same as" note is a problem slot AoPS didn't label; it
      // holds a number but contributes no statement. (A labeled one never
      // reaches here — isProblemSlot catches it first.)
      if (PLACEHOLDER_SLOT.test(body)) {
         ctx.problemIndex++;
         return type;
      }
      // Runs of consecutive headers are one header plus its subtitle, and the
      // last one wins ("I" then "March 13th"). Only headers count for this:
      // a problem slot after a header is that header's first problem.
      if (nextItem && isHeaderItem(nextItem, isOly)) return type;
      if (/^(?:[dD]ay)\s\d+$/.test(body)) {
         type = TYPES.AMO;
      }
      if (body === "Mixer Round") {
         return type;
      }
      ctx.buckets.push({ name: body, problems: [] });
      ctx.problemIndex = 0;
      ctx.isPrevMulti = false;
      return type;
   }

   // A problem posted as plain text rather than as a forum topic, recognized by
   // the problem label AoPS gives it. A placeholder body ("redacted", "Same as
   // A5") only reserves the number, so later problems keep their real numbering
   // and the answer key still lines up; any other body is the statement itself.
   _handleProblemSlot(item, type, ctx) {
      const body = (item.post_data.post_canonical ?? "").trim();
      if (!PLACEHOLDER_SLOT.test(body)) {
         const problem = makeProblem({
            statement: CleanupText.cleanProblem(body),
            postId: item.post_data.post_id,
            topicId: item.post_data.topic_id || null,
            n: ctx.problemIndex,
         });
         // No topic means no discussion to mine, so there are no answer posts.
         if (type.computational) problem._answerPosts = [];
         addProblemToTest(problem, ctx, this.onProblemAdd);
         ctx.problemCount++;
      }
      ctx.problemIndex++;
      ctx.isPrevMulti = false;
   }

   async _handleProblemItem(item, type, ctx, seenTopicIds) {
      const processed = CleanupText.toAsyLinks(
         item.post_data.post_canonical,
         item.post_data.post_rendered,
      );

      const nonProblem = CleanupText.nonProblemPostDisposition(processed);
      if (nonProblem) {
         seenTopicIds.push(item.post_data.topic_id);
         if (nonProblem === "reserve") ctx.problemIndex++;
         ctx.isPrevMulti = false;
         return;
      }

      let isMulti;
      if (
         (ctx.problemIndex === 0 || ctx.isPrevMulti) &&
         (isMulti = CleanupText.checkContainsMultiple(
            processed,
            ctx.problemIndex + 1,
         )).length > 1
      ) {
         await this._handleMultiProblem(isMulti, item, type, ctx, seenTopicIds);
      } else {
         await this._handleSingleProblem(
            processed,
            item,
            type,
            ctx,
            seenTopicIds,
         );
      }
   }

   async _handleMultiProblem(isMulti, item, type, ctx, seenTopicIds) {
      ctx.isPrevMulti = true;
      let answerPostsByProblem = {};
      let topicSolutions = [];
      if (type.computational) {
         const topicData = await this.searchTopicForSolutions(
            item.post_data.topic_id,
            true,
            false,
         );
         // Each problem's answers live in [hide=S<n>] blocks; keep them raw so
         // _finalizeComputationalAnswers can pick the right \boxed{} per problem.
         answerPostsByProblem = topicData.answerPostsByProblem;
         topicSolutions = topicData.solutions;
      }
      for (let j = 0; j < isMulti.length; j++) {
         const problem = makeProblem({
            // Keep the raw statement (choices still attached); the resolve pass
            // extracts/strips choices once the test's kind is known.
            statement: CleanupText.cleanProblem(isMulti[j]),
            postId: item.post_data.post_id,
            topicId: item.post_data.topic_id,
            n: j + ctx.problemIndex,
            solutions: j === 0 ? topicSolutions : [],
         });
         if (type.computational) {
            problem._answerPosts =
               answerPostsByProblem[(j + 1).toString()] ?? [];
         }
         addProblemToTest(problem, ctx, this.onProblemAdd);
         seenTopicIds.push(item.post_data.topic_id);
         ctx.problemCount++;
      }
      ctx.problemIndex += isMulti.length;
   }

   async _handleSingleProblem(processed, item, type, ctx, seenTopicIds) {
      const problem = await this._buildProblem(
         processed,
         type,
         item.post_data.topic_id,
      );
      problem.postId = item.post_data.post_id;
      problem.topicId = item.post_data.topic_id;
      problem.n = ctx.problemIndex;
      addProblemToTest(problem, ctx, this.onProblemAdd);
      seenTopicIds.push(problem.topicId);
      ctx.problemCount++;
      ctx.problemIndex++;
   }

   // Turns the walk's buckets into the public `sections`/`problems` shape. This
   // is the only place that shape is decided, and it runs before any consumer
   // reads it, so `problems` is always either flat or fully sectioned.
   _normalizeSections(test, ctx) {
      // A logistics header ("10 problems for 75 minutes") introduces the test
      // itself, not a part of it, so the bucket it opened is an unnamed lead
      // section just like the implicit one.
      for (const bucket of ctx.buckets) {
         if (CleanupText.isLogisticsHeader(bucket.name)) bucket.name = "";
      }

      // A bucket no problem landed in was never a section: a trailing header,
      // or the implicit lead bucket of a test that opens with one.
      const buckets = ctx.buckets.filter((b) => b.problems.length > 0);

      if (buckets.length <= 1) {
         const lone = buckets[0];
         // A lone section is folded into a flat test. If its header carries
         // identifying info (High School / Middle School / A / B), append it
         // to the test name; otherwise the header is noise (problem count,
         // time limit, …) and is dropped.
         const label = lone?.name
            ? CleanupText.extractSectionLabel(lone.name)
            : null;
         if (label) {
            test.name = `${test.name} ${label}`;
            const metadata = foldedSectionMetadata(label);
            if (metadata) Object.assign(test, metadata);
         }
         test.sections = [];
         test.problems = lone ? lone.problems : [];
         for (const problem of test.problems) problem.section = -1;
         return;
      }

      // Several sections survive. The lead bucket keeps its empty name: its
      // problems are the test proper, and the named buckets that follow it
      // (a shortlist, a tiebreaker round) are what the headers introduced.
      test.sections = buckets.map((b) => b.name);
      test.problems = buckets.map((b) => b.problems);
      buckets.forEach((bucket, i) => {
         for (const problem of bucket.problems) problem.section = i;
      });
   }

   _extractInCategoryAnswerKey(items, name = null) {
      // Some tests carry their answer key as a hidden post right inside the
      // category (item_text like "answer key"). The same predicate also keeps
      // it out of getTest's structural item walk.
      const keyItem = items.find(isInCategoryAnswerKey);
      if (!keyItem) return null;

      const answerMap = CleanupText.parseAnswerKey(
         keyItem.post_data?.post_canonical ?? "",
         name,
      );
      return answerMap && Object.keys(answerMap).length > 0 ? answerMap : null;
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
      const apply = (problem) => {
         // Keyed by the problem's own number, not by arrival order: a slot that
         // reserved a number without producing a problem (a redacted item) must
         // not shift every later answer, and each section restarts at 1.
         const ans = answerMap[String(problem.n + 1)];
         if (ans == null) return;
         // Branch on the problem's own resolved kind (a mixed test has both),
         // not the contest-level prior.
         const isMcq =
            Array.isArray(problem.choices) && problem.choices.length > 0;
         if (isMcq) {
            // MCQ: answer key is authoritative — override \boxed{} result
            const idx = CleanupText.choiceIndexOfAnswer(
               ans,
               problem.choices ?? [],
            );
            if (idx >= 0) {
               problem.answerIndex = idx;
               problem.answerValue = MCQ_LETTERS[idx];
            } else {
               problem.answerValue = ans;
               problem.answerIndex = -1;
            }
         } else if (problem.answerValue == null) {
            // Numeric: only fill when \boxed{} found nothing
            this._setNumericAnswer(problem, ans);
         }
      };

      for (const problem of allProblems(test)) apply(problem);
   }

   _setNumericAnswer(problem, rawAnswer) {
      // Numeric problems have no MCQ choices. The known answer lives in
      // answerValue; choices stays null and answerIndex stays -1.
      problem.answerValue = rawAnswer ?? null;
      problem.choices = null;
      problem.answerIndex = -1;
   }

   async _buildProblem(processed, type, topicId) {
      const problem = makeProblem({
         statement: CleanupText.cleanProblem(processed),
      });

      if (!type.computational) {
         // OLY — fetch all posts for potential solutions
         const topicData = await this.searchTopicForSolutions(
            topicId,
            false,
            true,
         );
         problem.solutions = topicData.solutions;
         problem.posts = topicData.posts;
         return problem;
      }

      // Computational: fetch the discussion and stash the raw reply contents.
      // Choice extraction and \boxed{} selection are deferred to the resolve
      // pass (_finalizeComputationalAnswers), which runs once the whole test's
      // answer kind is known.
      const topicData = await this.searchTopicForSolutions(
         topicId,
         false,
         false,
      );
      problem.solutions = topicData.solutions;
      problem._answerPosts = topicData.answerPosts;
      return problem;
   }

   // Resolve pass: with all problems fetched, decide the test's answer kind from
   // its own problems (MCQ-vs-other majority; a tie/off-by-one stays mixed and
   // each problem keeps its detected kind), then resolve every \boxed{} answer.
   _finalizeComputationalAnswers(test, type) {
      const all = allProblems(test);
      if (all.length === 0) {
         test.answerKind = type.answerKind ?? "numeric";
         return;
      }

      // Detect MCQ-ness structurally, independent of the (possibly wrong) prior.
      for (const p of all) {
         p._hasChoices = CleanupText.extractChoices(p.statement).length >= 3;
      }
      const mcqCount = all.filter((p) => p._hasChoices).length;
      const otherCount = all.length - mcqCount;
      // The non-MCQ kind for a computational test is always numeric here (proof
      // contests never reach this pass).
      const otherKind = "numeric";
      const decision = CleanupText.preserveMixedPracticeAnswerKinds(test.name)
         ? { mixed: true, kind: null }
         : CleanupText.decideTestKind(mcqCount, otherCount, otherKind);

      for (const p of all) {
         const kind = decision.mixed
            ? p._hasChoices
               ? "mcq"
               : otherKind
            : decision.kind;
         this._resolveProblemAnswer(p, kind);
         delete p._hasChoices;
         delete p._answerPosts;
      }
      test.answerKind = decision.mixed ? "mixed" : decision.kind;
   }

   _resolveProblemAnswer(problem, kind) {
      const posts = problem._answerPosts ?? [];
      if (kind === "mcq") {
         problem.choices = CleanupText.extractChoices(problem.statement);
         problem.statement = CleanupText.cleanChoices(problem.statement).trim();
         if (problem.choices.length < 3) {
            this.log(
               `  ⚠️  Problem ${problem.n + 1}: test resolved as MCQ but only ${problem.choices.length} choice(s) were extractable`,
            );
         }
         const raw = CleanupText.selectBoxedAnswer(posts, {
            answerKind: "mcq",
            choices: problem.choices,
         });
         problem.answerValue = null;
         problem.answerIndex = -1;
         if (raw != null) {
            const idx = CleanupText.choiceIndexOfAnswer(raw, problem.choices);
            if (idx >= 0) {
               problem.answerIndex = idx;
               problem.answerValue = MCQ_LETTERS[idx]; // MCQ answer is a letter
            }
         } else if (posts.some((c) => /\\boxed\s*\{/.test(c ?? ""))) {
            this.log(
               `  ⚠️  Problem ${problem.n + 1}: boxed answer(s) present but none matched a choice`,
            );
         }
      } else {
         // Numeric: any string is a valid answer (LaTeX, fractions, words).
         const raw = CleanupText.selectBoxedAnswer(posts, {
            answerKind: "numeric",
         });
         this._setNumericAnswer(problem, raw);
      }
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
         return {
            answerPosts: [],
            answerPostsByProblem: {},
            solutions: [],
            posts: [],
         };
      }

      const response = await this.sendRequest(
         ForumSession.payload(ApiMethod.TOPIC, { id }),
      );

      if (response.error_code === "E_NO_PERMISSION") {
         this._permissionDenied = true;
         return {
            answerPosts: [],
            answerPostsByProblem: {},
            solutions: [],
            posts: [],
         };
      }

      const topic = response.response.topic;
      if (topic?.category_id && !this._currentForumCategoryId) {
         this._currentForumCategoryId = topic.category_id;
      }
      const rawPosts = topic.posts_data ?? [];
      const solutions = [];
      const posts = [];
      // Raw candidate material for answer selection (done later by the caller):
      // single-problem => the reply contents in order; multi-problem => each
      // problem's [hide=S<n>] blocks, keyed by problem number.
      const answerPosts = [];
      const answerPostsByProblem = {};

      for (const post of rawPosts) {
         const content = post.post_canonical;

         // Collect answer candidates
         if (searchManyProblems) {
            const hideTag = /\[hide\s*=\s*(?:S|s)\s*(\d+)]([\s\S]*?)\[\/hide]/g;
            for (const match of content.matchAll(hideTag)) {
               (answerPostsByProblem[match[1]] ??= []).push(match[2]);
            }
         } else {
            answerPosts.push(content);
         }

         // Collect all posts for OLY
         if (isOly) {
            posts.push({
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

      return { answerPosts, answerPostsByProblem, solutions, posts };
   }

   async searchTopicForAnswer(id, searchManyProblems = false) {
      const result = await this.searchTopicForSolutions(
         id,
         searchManyProblems,
         false,
      );
      // No test context here, so resolve as numeric (accept any boxed value).
      if (searchManyProblems) {
         const out = {};
         for (const [num, contents] of Object.entries(
            result.answerPostsByProblem,
         )) {
            out[num] = CleanupText.selectBoxedAnswer(contents, {
               answerKind: "numeric",
            });
         }
         return out;
      }
      return CleanupText.selectBoxedAnswer(result.answerPosts, {
         answerKind: "numeric",
      });
   }
}
