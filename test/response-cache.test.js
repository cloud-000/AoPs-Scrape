import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForumSession } from "../src/ForumSession.js";
import { ResponseCache } from "../src/ResponseCache.js";

const temporaryPaths = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("topic responses write through even when cache reads are disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aops-response-cache-"));
    temporaryPaths.push(directory);
    const cache = new ResponseCache(directory, { readEnabled: false });
    const session = new ForumSession(false, 1, "not-persisted");
    session.cache = cache;
    session.requestDelay = [0, 0];
    const response = { response: { topic: { posts_data: [{ post_id: 2 }] } } };
    globalThis.fetch = async () => new Response(JSON.stringify(response), { status: 200 });

    await session.sendRequest({ a: "fetch_topic", topic_id: 123 });

    expect(cache.canRead({ a: "fetch_topic", topic_id: 123 })).toBe(false);
    expect(await cache.get({ a: "fetch_topic", topic_id: 123 })).toEqual(response);
    const metadata = JSON.parse(readFileSync(join(directory, "topic_123.meta.json"), "utf8"));
    expect(metadata.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(metadata.fetched_at)).not.toBeNaN();
    expect(readFileSync(join(directory, "topic_123.json"), "utf8")).not.toContain(
        "not-persisted",
    );
});

test("non-topic writes remain opt-in when read-through is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aops-response-cache-"));
    temporaryPaths.push(directory);
    const cache = new ResponseCache(directory, { readEnabled: false });
    const written = await cache.set({ a: "fetch_category_data", category_id: 5 }, { ok: true });
    expect(written).toBe(false);
    expect(cache.has({ a: "fetch_category_data", category_id: 5 })).toBe(false);
});
