import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    acceptLLMProposal,
    initDB,
    rejectLLMProposal,
    upsertSolutionCandidate,
} from "../src/db.js";
import { ResponseCache } from "../src/ResponseCache.js";
import {
    listLLMProposals,
    planLLMExtraction,
    runLLMExtraction,
    showLLMProposal,
} from "../src/llm/service.js";

const temporaryPaths = [];
afterEach(() => {
    for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture({ replyCount = 1 } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "aops-llm-workflow-"));
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
         ) VALUES (1, 0, 123, 10, 'Find x.', 'Find x.', '1', 1)`,
    );
    const rawPost = "We have x+1=2, so x=1. This proves the claim.";
    const archive = new ResponseCache(join(directory, "responses"), { readEnabled: false });
    await archive.set(
        { a: "fetch_topic", topic_id: 123 },
        {
            response: {
                topic: {
                    posts_data: [
                        { post_id: 10, topic_id: 123, post_canonical: "Find x." },
                        ...Array.from({ length: replyCount }, (_, index) => ({
                            post_id: 20 + index,
                            topic_id: 123,
                            poster_id: 7,
                            username: "solver",
                            post_time: 123456,
                            post_canonical: rawPost,
                        })),
                    ],
                },
            },
        },
    );
    let calls = 0;
    const client = {
        async complete() {
            calls++;
            const responseText = "full_solution";
            return {
                status: "success",
                rawResponse: { id: "r1", model: "served", choices: [] },
                responseText,
                providerModelId: "served",
                providerResponseId: "r1",
                latencyMs: 1,
            };
        },
    };
    const options = {
        cachePath: join(directory, "llm.sqlite"),
        responseCacheDir: join(directory, "responses"),
        modelId: "fixture-model",
        modelRevision: "r1",
        client,
    };
    return { db, options, rawPost, getCalls: () => calls };
}

test("limit bounds the deterministic plan and the number of model calls", async () => {
    const { db, options, getCalls } = await fixture({ replyCount: 3 });
    const plan = await planLLMExtraction(db, { ...options, limit: 2 });
    expect(plan.summary.candidates).toBe(2);
    expect(plan.summary.totalCandidates).toBe(3);
    expect(plan.summary.omittedCandidates).toBe(1);
    expect(plan.summary.trueCallsRequired).toBe(2);
    expect(plan.entries.filter((entry) => entry.requestKey).map((entry) => entry.postId)).toEqual([
        20,
        21,
    ]);

    const run = await runLLMExtraction(db, { ...options, limit: 2 });
    expect(run.results).toHaveLength(2);
    expect(getCalls()).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(2);
    db.close();
});

test("limit must be a positive integer", async () => {
    const { db, options } = await fixture();
    await expect(planLLMExtraction(db, { ...options, limit: 0 })).rejects.toThrow(
        "positive integer",
    );
    await expect(planLLMExtraction(db, { ...options, limit: 1.5 })).rejects.toThrow(
        "positive integer",
    );
    db.close();
});

test("run reuses cached inference and proposal creation is idempotent", async () => {
    const { db, options, getCalls } = await fixture();
    const initialPlan = await planLLMExtraction(db, options);
    expect(initialPlan.summary.dispositions.miss).toBe(1);

    const first = await runLLMExtraction(db, options);
    expect(first.results[0].status).toBe("proposal");
    expect(getCalls()).toBe(1);
    const proposalId = first.results[0].proposalId;
    expect(listLLMProposals(db)).toHaveLength(1);
    expect(showLLMProposal(db, proposalId).proposal.extracted_content).toContain("x=1");
    db.run("DELETE FROM llm_proposals WHERE id = ?", [proposalId]);

    const cachedPlan = await planLLMExtraction(db, options);
    expect(cachedPlan.summary.dispositions.cache_hit).toBe(1);
    const second = await runLLMExtraction(db, options);
    expect(second.results[0].status).toBe("proposal");
    expect(getCalls()).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM llm_proposals").get().n).toBe(1);
    db.close();
});

test("accept refuses to move an AoPS source off a manually reviewed solution", async () => {
    const { db, options } = await fixture();
    const run = await runLLMExtraction(db, options);
    const proposalId = run.results[0].proposalId;
    upsertSolutionCandidate(db, {
        problemId: 1,
        source: "aops",
        sourceKey: "post:20",
        content: "A different manually reviewed interpretation.",
        raw_content: "original",
        aops_post_id: 20,
        status: "accepted",
        status_source: "manual",
    });

    expect(() => acceptLLMProposal(db, proposalId, { reviewer: "reviewer" })).toThrow(
        "manually reviewed solution",
    );
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(0);
    expect(
        db.query("SELECT review_status FROM llm_proposals WHERE id = ?").get(proposalId)
            .review_status,
    ).toBe("needs_review");
    db.close();
});

test("accept materializes transactionally and idempotently through solution tables", async () => {
    const { db, options, rawPost } = await fixture();
    const run = await runLLMExtraction(db, options);
    const proposalId = run.results[0].proposalId;
    const first = acceptLLMProposal(db, proposalId, { reviewer: "reviewer" });
    const second = acceptLLMProposal(db, proposalId, { reviewer: "reviewer" });
    expect(second.id).toBe(first.id);

    const solution = db.query("SELECT * FROM solutions").get();
    const source = db.query("SELECT * FROM solution_sources").get();
    const proposal = db.query("SELECT * FROM llm_proposals WHERE id = ?").get(proposalId);
    expect(solution.content).toBe(rawPost);
    expect(solution.status).toBe("accepted");
    expect(solution.status_source).toBe("manual");
    expect(source.source).toBe("aops");
    expect(source.source_key).toBe("post:20");
    expect(source.raw_content).toBe(rawPost);
    expect(proposal.review_status).toBe("accepted");
    expect(db.query("SELECT count(*) AS n FROM llm_materializations").get().n).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM solutions").get().n).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM solution_sources").get().n).toBe(1);

    const plan = await planLLMExtraction(db, options);
    expect(plan.summary.dispositions.materialized).toBe(1);
    expect(plan.entries.find((entry) => entry.postId === 20).materializationDrift).toBe(false);
    db.run("UPDATE solutions SET content = 'reviewer later edited this' WHERE id = ?", [solution.id]);
    const driftPlan = await planLLMExtraction(db, options);
    expect(driftPlan.entries.find((entry) => entry.postId === 20).materializationDrift).toBe(true);
    db.close();
});

test("manual rejection is idempotent and blocks identical post content", async () => {
    const { db, options } = await fixture();
    const run = await runLLMExtraction(db, options);
    const proposalId = run.results[0].proposalId;
    rejectLLMProposal(db, proposalId, { reviewer: "reviewer" });
    rejectLLMProposal(db, proposalId, { reviewer: "reviewer" });
    const proposal = db.query("SELECT * FROM llm_proposals WHERE id = ?").get(proposalId);
    expect(proposal.review_status).toBe("rejected");
    expect(proposal.status_source).toBe("manual");

    const plan = await planLLMExtraction(db, options);
    expect(plan.summary.skips.manual_rejection).toBe(1);
    expect(plan.entries.some((entry) => entry.reason === "manual_rejection")).toBe(true);
    db.close();
});
