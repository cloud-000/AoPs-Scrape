import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "path";

/**
 * On-disk cache for raw AoPS AJAX responses.
 *
 * Keys are derived deterministically from the request payload built by
 * `ForumSession.payload()`, so the same logical request always maps to the
 * same file. Files hold the parsed JSON response verbatim, making them
 * inspectable and reusable across runs.
 */
export class ResponseCache {
    constructor(cacheDir = "./response_cache", { readEnabled = true } = {}) {
        this.cacheDir = cacheDir;
        this.readEnabled = readEnabled;
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    _key(bodyInput) {
        // Wiki (MediaWiki Action API) requests are keyed by page + section +
        // prop so they're inspectable on disk. `action` distinguishes them from
        // the forum's `a`-keyed payloads.
        if (bodyInput.action === "parse") {
            const section =
                bodyInput.section != null ? `_s${bodyInput.section}` : "";
            const prop = bodyInput.prop === "wikitext" ? "_wikitext" : "_html";
            const page = String(bodyInput.page).replace(/[^\w.-]+/g, "_");
            return join("wiki", `${page}${section}${prop}.json`);
        }

        const a = Array.isArray(bodyInput.a) ? bodyInput.a[0] : bodyInput.a;
        const first = (v) => (Array.isArray(v) ? v[0] : v);
        switch (a) {
            case "fetch_category_data":
                return `category_${first(bodyInput.category_id)}.json`;
            case "fetch_items_categories":
                return `items_categories_${first(bodyInput.parent_category_id)}_${first(bodyInput.start_num)}.json`;
            case "fetch_topic":
                return `topic_${first(bodyInput.topic_id)}.json`;
            case "fetch_topics": {
                const before = bodyInput.fetch_before
                    ? `_before_${first(bodyInput.fetch_before)}`
                    : "";
                return `forum_${first(bodyInput.category_id)}${before}.json`;
            }
            default:
                // Fallback: hash the full payload so unknown requests still cache.
                return `req_${Bun.hash(JSON.stringify(bodyInput)).toString(16)}.json`;
        }
    }

    _path(bodyInput) {
        return join(this.cacheDir, this._key(bodyInput));
    }

    _isTopic(bodyInput) {
        const action = Array.isArray(bodyInput.a) ? bodyInput.a[0] : bodyInput.a;
        return action === "fetch_topic";
    }

    _metadataPath(bodyInput) {
        return this._path(bodyInput).replace(/\.json$/, ".meta.json");
    }

    canRead(bodyInput) {
        return this.readEnabled && this.has(bodyInput);
    }

    has(bodyInput) {
        return existsSync(this._path(bodyInput));
    }

    async get(bodyInput) {
        return await Bun.file(this._path(bodyInput)).json();
    }

    async set(bodyInput, data, { fetchedAt = new Date().toISOString() } = {}) {
        // Topic responses are the durable LLM corpus and are always archived.
        // Other response types remain an opt-in performance cache.
        if (!this.readEnabled && !this._isTopic(bodyInput)) return false;

        const json = JSON.stringify(data);
        const path = this._path(bodyInput);
        const tempPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
        await Bun.write(tempPath, json);
        renameSync(tempPath, path);

        if (this._isTopic(bodyInput)) {
            const metadata = {
                content_hash: createHash("sha256").update(json).digest("hex"),
                fetched_at: fetchedAt,
            };
            const metadataPath = this._metadataPath(bodyInput);
            const metadataTemp = `${metadataPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
            await Bun.write(metadataTemp, JSON.stringify(metadata, null, 2));
            renameSync(metadataTemp, metadataPath);
        }
        return true;
    }

    async getTopic(topicId) {
        const payload = { a: "fetch_topic", topic_id: topicId };
        if (!this.has(payload)) return null;
        const response = await this.get(payload);
        let metadata = null;
        const metadataPath = this._metadataPath(payload);
        if (existsSync(metadataPath)) metadata = await Bun.file(metadataPath).json();
        return { response, metadata };
    }
}
