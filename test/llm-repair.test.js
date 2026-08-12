import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    acceptLLMProposal,
    classifySolutions,
    hashText,
    initDB,
    rejectLLMProposal,
    upsertSolutionCandidate,
} from "../src/db.js";
import {
    interpretRepairResponse,
    parseRepairResponse,
    repairSignals,
    REPAIR_OPERATION,
} from "../src/llm/repairSolutionFormat.js";
import { buildExtractionRequest } from "../src/llm/extractSolutionFromPost.js";
import { buildRepairRequest } from "../src/llm/repairSolutionFormat.js";
import { normalizeSolutionText } from "../src/textAudit.js";
import {
    listLLMProposals,
    planLLMOperation,
    runLLMOperation,
    showLLMProposal,
} from "../src/llm/service.js";

const temporaryPaths = [];
afterEach(() => {
    for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const NOISY = [
    '[quote="alice"]I do not get step two.[/quote]',
    "hi everyone",
    "",
    "Since $x+1=8$, we get $x=7$. So the answer is $\\boxed{7}$.",
    "",
    "Thanks!",
].join("\n");

const CLEAN = "Since $x+1=8$, we get $x=7$. So the answer is $\\boxed{7}$.";

const RAW_POST = `${NOISY}\n[i]sent from my phone[/i]`;

function goodResponse(replacement = CLEAN) {
    return JSON.stringify({
        replacement,
        change_summary: ["Removed a quoted reply and a greeting."],
        removed_non_solution_content: ['[quote="alice"]I do not get step two.[/quote]'],
        mathematical_meaning_changed: false,
        confidence: 0.9,
    });
}

function fixture({
    content = NOISY,
    solutionCount = 1,
    responseText = goodResponse(),
    withSource = true,
} = {}) {
    const directory = mkdtempSync(join(tmpdir(), "aops-llm-repair-"));
    temporaryPaths.push(directory);
    const db = initDB(join(directory, "main.sqlite"));
    db.run("INSERT INTO series (name) VALUES ('Fixture')");
    db.run(
        `INSERT INTO tests (series_id, name, year, aops_category_id, is_computational)
         VALUES (1, '2026 Fixture', 2026, '55', 1)`,
    );
    db.run(
        `INSERT INTO problems (
            test_id, n, aops_topic_id, aops_post_id, aops_statement,
            statement, answer_value, is_computational
         ) VALUES (1, 0, 123, 10, 'Find x.', 'Find x.', '7', 1)`,
    );
    for (let index = 0; index < solutionCount; index++) {
        const body = index === 0 ? content : `${content}\n[i]variant ${index}[/i]`;
        if (withSource) {
            upsertSolutionCandidate(db, {
                problemId: 1,
                source: "aops",
                sourceKey: `post:${20 + index}`,
                content: body,
                raw_content: index === 0 ? RAW_POST : `${RAW_POST} ${index}`,
                aops_topic_id: 123,
                aops_post_id: 20 + index,
                aops_username: "solver",
            });
        } else {
            db.run(
                `INSERT INTO solutions (problem_id, content, normalized_hash)
                 VALUES (1, ?, ?)`,
                [body, hashText(`sourceless-${index}`)],
            );
        }
    }

    let calls = 0;
    const client = {
        async complete() {
            calls++;
            return {
                status: "success",
                rawResponse: { id: "r1", model: "served", choices: [] },
                responseText:
                    typeof responseText === "function" ? responseText(calls) : responseText,
                providerModelId: "served",
                providerResponseId: "r1",
                latencyMs: 1,
            };
        },
    };
    const options = {
        operation: REPAIR_OPERATION,
        cachePath: join(directory, "llm.sqlite"),
        responseCacheDir: join(directory, "responses"),
        modelId: "fixture-model",
        modelRevision: "r1",
        client,
    };
    return { db, options, directory, getCalls: () => calls };
}

// --- deterministic eligibility ------------------------------------------------

test("eligibility comes only from the text audit", () => {
    expect(repairSignals(CLEAN).eligible).toBe(false);

    const noisy = repairSignals(NOISY);
    expect(noisy.eligible).toBe(true);
    const rules = noisy.findings.map((item) => item.rule_id);
    expect(rules).toContain("content.quote_block");
    expect(rules).toContain("content.greeting_or_signoff");

    const broken = repairSignals("Since $x+1=8, we get x=7.");
    expect(broken.eligible).toBe(true);
    expect(broken.findings.some((item) => item.severity === "error")).toBe(true);
});

test("noise the deterministic normalizer can fix never reaches the model", () => {
    // A [hide] wrapper is audited, but normalizeSolutionText strips it, so the
    // stored content the planner sees is already clean.
    const wrapped = `[hide="Solution"]${CLEAN}[/hide]`;
    expect(repairSignals(wrapped).findings.map((item) => item.rule_id)).toContain(
        "content.hide_wrapper",
    );
    expect(repairSignals(normalizeSolutionText(wrapped)).eligible).toBe(false);
});

test("a clean solution is skipped as no_repair_signal and never planned", async () => {
    const { db, options } = fixture({ content: CLEAN });
    const plan = await planLLMOperation(db, options);
    expect(plan.summary.candidates).toBe(0);
    expect(plan.summary.skips.no_repair_signal).toBe(1);
    db.close();
});

test("solutions without source provenance are skipped", async () => {
    const { db, options } = fixture({ withSource: false });
    const plan = await planLLMOperation(db, options);
    expect(plan.summary.candidates).toBe(0);
    expect(plan.summary.skips.no_source_provenance).toBe(1);
    db.close();
});

test("duplicate, inactive, empty, and oversized solutions are skipped with distinct reasons", async () => {
    const { db, options } = fixture({ solutionCount: 4 });
    db.run("UPDATE solutions SET duplicate_of_solution_id = 1 WHERE id = 2");
    db.run("UPDATE solutions SET status = 'rejected' WHERE id = 3");
    db.run("UPDATE solutions SET content = '   ' WHERE id = 4");

    const plan = await planLLMOperation(db, { ...options, maxInputChars: 10 });
    expect(plan.summary.skips).toMatchObject({
        duplicate: 1,
        inactive_status: 1,
        empty: 1,
        too_large: 1,
    });
    expect(plan.summary.candidates).toBe(0);
    db.close();
});

test("manually curated solutions are protected from repair proposals", async () => {
    const { db, options } = fixture();
    db.run("UPDATE solutions SET status_source = 'manual' WHERE id = 1");
    const plan = await planLLMOperation(db, options);
    expect(plan.summary.candidates).toBe(0);
    expect(plan.summary.skips.manual_decision).toBe(1);
    db.close();
});

test("the planner is read-only", async () => {
    const { db, options } = fixture();
    const before = db.query("SELECT content FROM solutions WHERE id = 1").get().content;
    await planLLMOperation(db, options);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(0);
    expect(db.query("SELECT content FROM solutions WHERE id = 1").get().content).toBe(before);
    db.close();
});

// --- request identity ---------------------------------------------------------

test("cache identity is operation-specific", () => {
    const modelConfig = { modelId: "m", modelRevision: "r1" };
    const repair = buildRepairRequest(
        {
            solutionId: 1,
            problemId: 1,
            content: NOISY,
            contentFormat: "latex_bbcode",
            sources: [],
            signals: repairSignals(NOISY),
            problem: { statement: "Find x.", choices: null, responseKind: null, answerValue: "7" },
        },
        modelConfig,
    );
    const extraction = buildExtractionRequest(
        { statement: "Find x.", choices: null, responseKind: null, answerValue: "7" },
        { post_id: 20, topic_id: 123, post_canonical: NOISY },
        modelConfig,
    );
    expect(repair.operation).toBe(REPAIR_OPERATION);
    expect(repair.requestKey).not.toBe(extraction.requestKey);

    // The solution text is part of identity: editing it must not reuse a result.
    const edited = buildRepairRequest(
        {
            solutionId: 1,
            problemId: 1,
            content: `${NOISY} `,
            contentFormat: "latex_bbcode",
            sources: [],
            signals: repairSignals(NOISY),
            problem: { statement: "Find x.", choices: null, responseKind: null, answerValue: "7" },
        },
        modelConfig,
    );
    expect(edited.requestKey).not.toBe(repair.requestKey);
});

// --- parsing and validation ---------------------------------------------------

test("JSON-in-text and fenced responses parse; malformed output is invalid", () => {
    const fenced = "Here you go:\n```json\n" + goodResponse() + "\n```\nHope that helps.";
    expect(parseRepairResponse(fenced).replacement).toBe(CLEAN);
    expect(parseRepairResponse(goodResponse()).change_summary).toEqual([
        "Removed a quoted reply and a greeting.",
    ]);

    const context = { content: NOISY, problem: { answerValue: "7" } };
    expect(interpretRepairResponse("not json at all", context).valid).toBe(false);
    expect(interpretRepairResponse("not json at all", context).errors[0]).toContain(
        "no JSON object",
    );
    const missingField = interpretRepairResponse(
        JSON.stringify({ replacement: CLEAN, change_summary: [], confidence: 1 }),
        context,
    );
    expect(missingField.valid).toBe(false);
    expect(missingField.errors[0]).toContain("mathematical_meaning_changed");
});

test("a well-formed repair validates and records its validation details", () => {
    const result = interpretRepairResponse(goodResponse(), {
        content: NOISY,
        problem: { answerValue: "7" },
    });
    expect(result.valid).toBe(true);
    expect(result.usableCount).toBe(1);
    expect(result.validated.replacement).toBe(CLEAN);
    expect(result.validated.validation.rules_before).toContain("content.quote_block");
    expect(result.validated.validation.rules_after).toEqual([]);
    expect(result.validated.validation.known_answer_checked).toBe(true);
    expect(result.validated.validation.known_answer).toBe("7");
});

test("a claimed meaning change is rejected as a cacheable negative", () => {
    const response = JSON.stringify({
        replacement: CLEAN,
        change_summary: ["rewrote the argument"],
        removed_non_solution_content: [],
        mathematical_meaning_changed: true,
        confidence: 0.9,
    });
    const result = interpretRepairResponse(response, {
        content: NOISY,
        problem: { answerValue: "7" },
    });
    expect(result.valid).toBe(true);
    expect(result.usableCount).toBe(0);
    expect(result.validated.rejected).toBe(true);
    expect(result.errors.join(" ")).toContain("mathematical meaning changed");
});

test("empty replacements, dropped answers, and dropped images are rejected", () => {
    const context = { content: NOISY, problem: { answerValue: "7" } };
    const empty = interpretRepairResponse(goodResponse("   "), context);
    expect(empty.usableCount).toBe(0);
    expect(empty.errors.join(" ")).toContain("empty");

    const withoutAnswer = interpretRepairResponse(
        goodResponse("Since $x+1=8$, we get $x=7$."),
        context,
    );
    expect(withoutAnswer.usableCount).toBe(0);
    expect(withoutAnswer.errors.join(" ")).toContain("boxed answer");

    const withImage = `${NOISY}\n[asy] draw((0,0)--(1,1)); [/asy]`;
    const droppedImage = interpretRepairResponse(goodResponse(CLEAN), {
        content: withImage,
        problem: { answerValue: "7" },
    });
    expect(droppedImage.usableCount).toBe(0);
    expect(droppedImage.errors.join(" ")).toContain("image references");

    const keptImage = interpretRepairResponse(
        goodResponse(`${CLEAN}\n[asy] draw((0,0)--(1,1)); [/asy]`),
        { content: withImage, problem: { answerValue: "7" } },
    );
    expect(keptImage.usableCount).toBe(1);
});

test("audit regressions are rejected and a no-op replacement fails the improvement check", () => {
    const broken = "Since $x+1=8, we get $\\boxed{7}$.";
    const context = { content: NOISY, problem: { answerValue: "7" } };

    const regressed = interpretRepairResponse(goodResponse(broken), context);
    expect(regressed.usableCount).toBe(0);
    expect(regressed.errors.join(" ")).toContain("introduces error-level findings");

    const noop = interpretRepairResponse(goodResponse(NOISY), context);
    expect(noop.usableCount).toBe(0);
    expect(noop.errors.join(" ")).toContain("does not improve");

    // Repairing an audit error without touching the mathematics is accepted.
    const fixesAudit = interpretRepairResponse(
        goodResponse("Since $x+1=8$, we get $\\boxed{7}$."),
        { content: broken, problem: { answerValue: "7" } },
    );
    expect(fixesAudit.usableCount).toBe(1);
    expect(fixesAudit.validated.validation.findings_after).toBeLessThan(
        fixesAudit.validated.validation.findings_before,
    );
});

// --- planning, limits, and caching --------------------------------------------

test("limit bounds this operation's candidates and model calls", async () => {
    const { db, options, getCalls } = fixture({ solutionCount: 3 });
    const plan = await planLLMOperation(db, { ...options, limit: 2 });
    expect(plan.summary.totalCandidates).toBe(3);
    expect(plan.summary.candidates).toBe(2);
    expect(plan.summary.omittedCandidates).toBe(1);
    expect(plan.summary.trueCallsRequired).toBe(2);
    expect(plan.entries.filter((entry) => entry.requestKey).map((entry) => entry.solutionId)).toEqual(
        [1, 2],
    );

    const run = await runLLMOperation(db, { ...options, limit: 2 });
    expect(run.results).toHaveLength(2);
    expect(getCalls()).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(2);
    db.close();
});

test("run reuses the cached inference and proposal creation is idempotent", async () => {
    const { db, options, getCalls } = fixture();
    expect((await planLLMOperation(db, options)).summary.dispositions.miss).toBe(1);

    const first = await runLLMOperation(db, options);
    expect(first.results[0].status).toBe("proposal");
    expect(getCalls()).toBe(1);
    const proposalId = first.results[0].proposalId;
    expect(listLLMProposals(db, { operation: REPAIR_OPERATION })).toHaveLength(1);
    expect(showLLMProposal(db, proposalId).proposal.replacement).toBe(CLEAN);

    // An unchanged input re-plans as an existing proposal and calls nothing.
    expect((await planLLMOperation(db, options)).summary.dispositions.proposal_exists).toBe(1);
    await runLLMOperation(db, options);
    expect(getCalls()).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(1);

    // With the proposal gone the cached interpretation rebuilds it, still no call.
    db.run("DELETE FROM llm_proposals WHERE id = ?", [proposalId]);
    expect((await planLLMOperation(db, options)).summary.dispositions.cache_hit).toBe(1);
    const second = await runLLMOperation(db, options);
    expect(second.results[0].status).toBe("proposal");
    expect(getCalls()).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(1);
    db.close();
});

test("a run that creates nothing reports why, not an empty result set", async () => {
    const { db, options, getCalls } = fixture();
    const first = await runLLMOperation(db, options);
    expect(first.summary).toMatchObject({ modelCalls: 1, cacheReuse: 0, acted: 1 });
    expect(first.summary.statuses).toEqual({ proposal: 1 });
    expect(first.summary.noops).toEqual({});

    // Nothing left to do: the proposal already exists and is awaiting review.
    const second = await runLLMOperation(db, options);
    expect(second.results).toHaveLength(0);
    expect(second.summary).toMatchObject({ modelCalls: 0, cacheReuse: 0, acted: 0 });
    expect(second.summary.noops).toEqual({ proposal_exists: 1 });

    // Real cache reuse rebuilds the proposal and is reported as such.
    db.run("DELETE FROM llm_proposals");
    const third = await runLLMOperation(db, options);
    expect(third.summary).toMatchObject({ modelCalls: 0, cacheReuse: 1, acted: 1 });
    expect(third.summary.statuses).toEqual({ proposal: 1 });
    expect(getCalls()).toBe(1);
    db.close();
});

test("the plan quotes the tokens it would actually send", async () => {
    const { db, options } = fixture();
    const fresh = await planLLMOperation(db, options);
    expect(fresh.summary.estimatedCallTokens).toBe(fresh.summary.estimatedInputTokens);
    expect(fresh.summary.estimatedCallTokens).toBeGreaterThan(0);

    await runLLMOperation(db, options);
    const rerun = await planLLMOperation(db, options);
    expect(rerun.summary.trueCallsRequired).toBe(0);
    expect(rerun.summary.estimatedCallTokens).toBe(0);
    // The all-candidate figure still reports the full context size.
    expect(rerun.summary.estimatedInputTokens).toBeGreaterThan(0);
    db.close();
});

test("a validated negative caches as valid_empty instead of re-calling the model", async () => {
    const { db, options, getCalls } = fixture({ responseText: goodResponse(NOISY) });
    const run = await runLLMOperation(db, options);
    expect(run.results[0].status).toBe("valid_empty");
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(0);

    expect((await planLLMOperation(db, options)).summary.dispositions.valid_empty).toBe(1);
    await runLLMOperation(db, options);
    expect(getCalls()).toBe(1);
    db.close();
});

test("a parser version change reparses the cached raw response without a new call", async () => {
    const { db, options, getCalls } = fixture();
    await runLLMOperation(db, options);
    expect(getCalls()).toBe(1);

    const cache = new (await import("bun:sqlite")).Database(options.cachePath);
    cache.run("UPDATE llm_interpretations SET parser_version = '0'");
    cache.close();
    db.run("DELETE FROM llm_proposals");

    const plan = await planLLMOperation(db, options);
    expect(plan.summary.dispositions.reparse).toBe(1);
    const rerun = await runLLMOperation(db, options);
    expect(rerun.results[0].status).toBe("proposal");
    expect(getCalls()).toBe(1);
    db.close();
});

// --- review and materialization -----------------------------------------------

test("accept rewrites only the canonical content and preserves the original source", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    const proposalId = run.results[0].proposalId;

    const first = acceptLLMProposal(db, proposalId, { reviewer: "reviewer" });
    const second = acceptLLMProposal(db, proposalId, { reviewer: "reviewer" });
    expect(second.id).toBe(first.id);
    expect(first.method).toBe("llm_repair");

    const solution = db.query("SELECT * FROM solutions WHERE id = 1").get();
    const source = db.query("SELECT * FROM solution_sources WHERE solution_id = 1").get();
    expect(solution.content).toBe(CLEAN);
    expect(solution.status).toBe("accepted");
    expect(solution.status_source).toBe("manual");
    expect(source.raw_content).toBe(RAW_POST);
    expect(first.materialized_value_hash).toBe(hashText(CLEAN));
    expect(db.query("SELECT count(*) AS n FROM solutions").get().n).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(1);

    const proposal = db.query("SELECT * FROM llm_proposals WHERE id = ?").get(proposalId);
    expect(proposal.review_status).toBe("accepted");
    expect(proposal.status_source).toBe("manual");
    // The model's proposal stays immutable next to the reviewer-approved value.
    expect(JSON.parse(proposal.proposal_json).replacement).toBe(CLEAN);
    expect(proposal.reviewer_approved_value).toBe(CLEAN);
    db.close();
});

test("accept materializes a reviewer-edited value", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    const proposalId = run.results[0].proposalId;
    const edited = "Since $x+1=8$, we get $x=7$, so the answer is $\\boxed{7}$.";

    const materialization = acceptLLMProposal(db, proposalId, {
        approvedValue: edited,
        reviewer: "reviewer",
    });
    expect(db.query("SELECT content FROM solutions WHERE id = 1").get().content).toBe(edited);
    expect(materialization.materialized_value_hash).toBe(hashText(edited));
    const proposal = db.query("SELECT * FROM llm_proposals WHERE id = ?").get(proposalId);
    expect(proposal.reviewer_approved_value).toBe(edited);
    expect(JSON.parse(proposal.proposal_json).replacement).toBe(CLEAN);
    db.close();
});

test("accept refuses a proposal whose target solution changed, leaving nothing behind", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    const proposalId = run.results[0].proposalId;
    db.run("UPDATE solutions SET content = ? WHERE id = 1", [`${NOISY}\nlater manual edit`]);

    expect(() => acceptLLMProposal(db, proposalId, { reviewer: "reviewer" })).toThrow(
        "changed after proposal",
    );
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(0);
    expect(
        db.query("SELECT review_status FROM llm_proposals WHERE id = ?").get(proposalId)
            .review_status,
    ).toBe("needs_review");
    expect(db.query("SELECT content FROM solutions WHERE id = 1").get().content).toContain(
        "later manual edit",
    );
    db.close();
});

test("accept refuses to collide the repaired content with another solution", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    const proposalId = run.results[0].proposalId;
    upsertSolutionCandidate(db, {
        problemId: 1,
        source: "manual",
        sourceKey: "manual:other",
        content: CLEAN,
    });

    expect(() => acceptLLMProposal(db, proposalId, { reviewer: "reviewer" })).toThrow("collides");
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(0);
    db.close();
});

test("rejection is idempotent and blocks the same solution content", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    const proposalId = run.results[0].proposalId;
    rejectLLMProposal(db, proposalId, { reviewer: "reviewer" });
    rejectLLMProposal(db, proposalId, { reviewer: "reviewer" });
    const proposal = db.query("SELECT * FROM llm_proposals WHERE id = ?").get(proposalId);
    expect(proposal.review_status).toBe("rejected");
    expect(proposal.status_source).toBe("manual");
    expect(db.query("SELECT content FROM solutions WHERE id = 1").get().content).toBe(NOISY);

    const plan = await planLLMOperation(db, options);
    expect(plan.summary.skips.manual_rejection).toBe(1);
    expect(() => acceptLLMProposal(db, proposalId, { reviewer: "reviewer" })).toThrow("Rejected");
    db.close();
});

test("a materialized repair survives preprocess and re-ingestion of the source", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    acceptLLMProposal(db, run.results[0].proposalId, { reviewer: "reviewer" });

    classifySolutions(db);
    // A later scrape re-offers the original post for the same solution.
    upsertSolutionCandidate(db, {
        problemId: 1,
        source: "aops",
        sourceKey: "post:20",
        content: NOISY,
        raw_content: RAW_POST,
        aops_post_id: 20,
    });

    const solution = db.query("SELECT * FROM solutions WHERE id = 1").get();
    expect(solution.content).toBe(CLEAN);
    expect(solution.status).toBe("accepted");
    expect(solution.status_source).toBe("manual");
    db.close();
});

test("a materialized repair reports as materialized, and later edits as drift", async () => {
    const { db, options } = fixture();
    const run = await runLLMOperation(db, options);
    acceptLLMProposal(db, run.results[0].proposalId, { reviewer: "reviewer" });

    const plan = await planLLMOperation(db, options);
    expect(plan.summary.dispositions.materialized).toBe(1);
    expect(plan.entries.find((entry) => entry.solutionId === 1).materializationDrift).toBe(false);

    db.run("UPDATE solutions SET content = ? WHERE id = 1", ["reviewer later edited this"]);
    const driftPlan = await planLLMOperation(db, options);
    expect(driftPlan.entries.find((entry) => entry.solutionId === 1).materializationDrift).toBe(
        true,
    );
    expect(driftPlan.summary.dispositions.materialized).toBe(1);
    db.close();
});
