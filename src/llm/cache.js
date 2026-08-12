import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const CACHE_PROTOCOL_VERSION = "1";

const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_requests (
  request_key               TEXT PRIMARY KEY,
  cache_protocol_version    TEXT NOT NULL,
  operation                 TEXT NOT NULL,
  operation_version         TEXT NOT NULL,
  response_contract_version TEXT NOT NULL,
  identity_json             TEXT NOT NULL,
  input_json                TEXT NOT NULL,
  system_prompt             TEXT NOT NULL,
  user_prompt               TEXT NOT NULL,
  response_schema_json      TEXT NOT NULL,
  model_id                  TEXT NOT NULL,
  model_revision            TEXT,
  inference_parameters_json TEXT NOT NULL,
  created_at                TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_attempts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key         TEXT NOT NULL REFERENCES llm_requests(request_key),
  attempt_index       INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('success', 'transient_error', 'provider_error')),
  raw_response_json   TEXT,
  response_text       TEXT,
  error_type          TEXT,
  error_message       TEXT,
  provider_model_id   TEXT,
  provider_response_id TEXT,
  server_fingerprint  TEXT,
  usage_json          TEXT,
  finish_reason       TEXT,
  latency_ms          INTEGER,
  created_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(request_key, attempt_index)
);
CREATE INDEX IF NOT EXISTS idx_llm_attempts_request_status
  ON llm_attempts (request_key, status, attempt_index);

CREATE TABLE IF NOT EXISTS llm_interpretations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key       TEXT NOT NULL REFERENCES llm_requests(request_key),
  attempt_id        INTEGER NOT NULL REFERENCES llm_attempts(id),
  parser_version    TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  parsed_json       TEXT,
  validated_json    TEXT,
  validation_errors_json TEXT,
  usable_count      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(request_key, attempt_id, parser_version, validator_version)
);
CREATE INDEX IF NOT EXISTS idx_llm_interpretations_lookup
  ON llm_interpretations (request_key, parser_version, validator_version, status);
`;

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
    if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
        }
        return result;
    }
    return value;
}

export function canonicalJSON(value) {
    return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
    return createHash("sha256").update(String(value)).digest("hex");
}

export function buildRequestIdentity(spec) {
    const identity = {
        cache_protocol_version: CACHE_PROTOCOL_VERSION,
        operation: spec.operation,
        operation_version: spec.operationVersion,
        input: spec.input,
        system_prompt_hash: sha256(spec.systemPrompt),
        user_prompt_hash: sha256(spec.userPrompt),
        response_contract_version: spec.responseContractVersion,
        response_schema_hash: sha256(canonicalJSON(spec.responseSchema)),
        model_id: spec.modelId,
        model_revision: spec.modelRevision ?? null,
        inference_parameters: spec.inferenceParameters,
        sample_index: spec.sampleIndex ?? 0,
    };
    const identityJSON = canonicalJSON(identity);
    return { requestKey: sha256(identityJSON), identity, identityJSON };
}

export function openLLMCache(path, { readOnly = false } = {}) {
    if (readOnly && !existsSync(path)) return null;
    const db = new Database(path, readOnly ? { readonly: true } : { create: true });
    if (!readOnly) {
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec(CACHE_SCHEMA);
    }
    return db;
}

export function storeRequest(cache, spec, builtIdentity) {
    cache.run(
        `INSERT INTO llm_requests (
            request_key, cache_protocol_version, operation, operation_version,
            response_contract_version, identity_json, input_json,
            system_prompt, user_prompt, response_schema_json,
            model_id, model_revision, inference_parameters_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_key) DO NOTHING`,
        [
            builtIdentity.requestKey,
            CACHE_PROTOCOL_VERSION,
            spec.operation,
            spec.operationVersion,
            spec.responseContractVersion,
            builtIdentity.identityJSON,
            canonicalJSON(spec.input),
            spec.systemPrompt,
            spec.userPrompt,
            canonicalJSON(spec.responseSchema),
            spec.modelId,
            spec.modelRevision ?? null,
            canonicalJSON(spec.inferenceParameters),
        ],
    );
}

export function nextAttemptIndex(cache, requestKey) {
    return (
        cache
            .query(`SELECT COALESCE(MAX(attempt_index), -1) + 1 AS n FROM llm_attempts WHERE request_key = ?`)
            .get(requestKey)?.n ?? 0
    );
}

export function storeAttempt(cache, requestKey, attempt) {
    const index = nextAttemptIndex(cache, requestKey);
    cache.run(
        `INSERT INTO llm_attempts (
            request_key, attempt_index, status, raw_response_json, response_text,
            error_type, error_message, provider_model_id, provider_response_id,
            server_fingerprint, usage_json, finish_reason, latency_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            requestKey,
            index,
            attempt.status,
            attempt.rawResponse == null ? null : JSON.stringify(attempt.rawResponse),
            attempt.responseText ?? null,
            attempt.errorType ?? null,
            attempt.errorMessage ?? null,
            attempt.providerModelId ?? null,
            attempt.providerResponseId ?? null,
            attempt.serverFingerprint ?? null,
            attempt.usage == null ? null : JSON.stringify(attempt.usage),
            attempt.finishReason ?? null,
            attempt.latencyMs ?? null,
        ],
    );
    return cache.query(`SELECT * FROM llm_attempts WHERE rowid = last_insert_rowid()`).get();
}

export function storeInterpretation(cache, requestKey, attemptId, versions, result) {
    cache.run(
        `INSERT INTO llm_interpretations (
            request_key, attempt_id, parser_version, validator_version,
            status, parsed_json, validated_json, validation_errors_json, usable_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_key, attempt_id, parser_version, validator_version)
         DO UPDATE SET status = excluded.status, parsed_json = excluded.parsed_json,
            validated_json = excluded.validated_json,
            validation_errors_json = excluded.validation_errors_json,
            usable_count = excluded.usable_count`,
        [
            requestKey,
            attemptId,
            versions.parserVersion,
            versions.validatorVersion,
            result.valid ? "valid" : "invalid",
            result.parsed == null ? null : JSON.stringify(result.parsed),
            result.validated == null ? null : JSON.stringify(result.validated),
            JSON.stringify(result.errors ?? []),
            result.usableCount ?? 0,
        ],
    );
    return cache
        .query(
            `SELECT * FROM llm_interpretations
             WHERE request_key = ? AND attempt_id = ? AND parser_version = ? AND validator_version = ?`,
        )
        .get(requestKey, attemptId, versions.parserVersion, versions.validatorVersion);
}

export function inspectCachedRequest(cache, requestKey, versions) {
    if (!cache) return { disposition: "miss" };
    const attempt = cache
        .query(
            `SELECT * FROM llm_attempts
             WHERE request_key = ? AND status = 'success'
             ORDER BY attempt_index DESC LIMIT 1`,
        )
        .get(requestKey);
    if (!attempt) return { disposition: "miss" };
    const interpretation = cache
        .query(
            `SELECT * FROM llm_interpretations
             WHERE request_key = ? AND attempt_id = ?
               AND parser_version = ? AND validator_version = ?`,
        )
        .get(
            requestKey,
            attempt.id,
            versions.parserVersion,
            versions.validatorVersion,
        );
    if (!interpretation) return { disposition: "reparse", attempt };
    if (interpretation.status !== "valid") return { disposition: "miss", attempt, interpretation };
    if (interpretation.usable_count === 0) {
        return { disposition: "valid_empty", attempt, interpretation };
    }
    return { disposition: "cache_hit", attempt, interpretation };
}
