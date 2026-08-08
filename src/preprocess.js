import { CleanupText } from './CleanupText.js';
import { getAutoTags } from './autoTags.js';
import { resolveTopic } from './topicPolicy.js';
import { SOLUTIONS_USERS } from '../contest_id.js';
import {
    classifySolutions,
    resolveWikiRedirectLinks,
    normalizeProblemLinks,
} from './db.js';

/**
 * Pre-processing pipeline. Operates on all problems in the DB (idempotent).
 * NOT subject to scraper-immutable rules — can update acgn, tags, choices,
 * solution flags.
 *
 * Responsibilities:
 * 1. Re-extract MCQ choices / clean statements on the source of truth
 * 2. Re-resolve every problem's acgn (test-declared subject, else inferACGN)
 * 3. Apply AUTO_TAGS and union into existing tags
 * 4. is_official detection for solution sources based on known organizers
 * 5. Re-apply solution classification rules to existing solutions
 * 6. Answer cross-check: log warnings where aops_answer != pdf_answer
 */
export async function runPreprocess(db) {
    console.log("Running pre-processing pipeline...\n");

    await refreshChoices(db);
    await reclassifyAcgn(db);
    await retagProblems(db);
    await detectOfficialSolutions(db);
    await reclassifySolutions(db);
    await crossCheckAnswers(db);
    await normalizeDuplicateLinks(db);

    console.log("\nPre-processing complete.");
}

// Resolves any pending wiki redirects whose target is now imported and collapses
// duplicate-link chains so every alias points directly at its ultimate canonical.
// Both are idempotent and require no network.
function normalizeDuplicateLinks(db) {
    console.log(
        "Step 7: Resolving wiki redirects + normalizing duplicate links...",
    );
    const r = resolveWikiRedirectLinks(db);
    const n = normalizeProblemLinks(db);
    console.log(
        `  Resolved ${r.linked} redirect link(s) (${r.unresolved} unresolved); repointed ${n.repointed} link(s) to their ultimate canonical.`,
    );
}

// Re-derives MCQ choices from each scraped statement tier when missing, and
// re-cleans any leftover appended answer-choice block. The resolved columns are
// recomputed with the normal pdf > wiki > aops precedence.
function refreshChoices(db) {
    console.log("Step 1: Re-extracting MCQ choices / cleaning statements...");
    const problems = db
        .query(
            `SELECT id, verified, pdf_statement,
                    wiki_statement, wiki_choices, wiki_answer_index, wiki_answer,
                    aops_statement, aops_choices, aops_answer_index, aops_answer
             FROM problems
             WHERE wiki_statement IS NOT NULL OR aops_statement IS NOT NULL`,
        )
        .all();
    let updatedProblems = 0;
    let updatedWiki = 0;
    let updatedAops = 0;
    const stmt = db.prepare(
        `UPDATE problems SET
            wiki_statement = ?, wiki_choices = ?, wiki_answer_index = ?,
            aops_statement = ?, aops_choices = ?, aops_answer_index = ?,
            statement = CASE
                WHEN verified THEN statement
                ELSE COALESCE(pdf_statement, ?, ?)
            END,
            answer_index = CASE
                WHEN verified THEN answer_index
                WHEN ? IS NOT NULL THEN ?
                ELSE ?
            END
         WHERE id = ?`,
    );

    const refreshTier = (statement, choicesJson, answerIndex, answer) => {
        if (statement == null) {
            return { statement, choicesJson, answerIndex, changed: false };
        }
        const stored = choicesJson ? JSON.parse(choicesJson) : null;
        const extracted = CleanupText.extractChoices(statement);
        // A previous parser may have persisted only part of a malformed block.
        // Prefer a newly recovered, longer sequence; otherwise preserve the
        // stored choices when the already-cleaned statement no longer has them.
        const choices =
            extracted.length > (stored?.length ?? 0) ? extracted : stored;
        if (!choices?.length) {
            return { statement, choicesJson, answerIndex, changed: false };
        }
        const cleaned = CleanupText.cleanChoices(statement).trim();
        const resolvedIndex = CleanupText.choiceIndexOfAnswer(answer, choices);
        const nextIndex = resolvedIndex >= 0 ? resolvedIndex : (answerIndex ?? -1);
        const nextChoicesJson = JSON.stringify(choices);
        return {
            statement: cleaned,
            choicesJson: nextChoicesJson,
            answerIndex: nextIndex,
            changed:
                cleaned !== statement ||
                nextChoicesJson !== choicesJson ||
                nextIndex !== (answerIndex ?? -1),
        };
    };

    db.transaction(() => {
        for (const p of problems) {
            const wiki = refreshTier(
                p.wiki_statement,
                p.wiki_choices,
                p.wiki_answer_index,
                p.wiki_answer,
            );
            const aops = refreshTier(
                p.aops_statement,
                p.aops_choices,
                p.aops_answer_index,
                p.aops_answer,
            );
            if (!wiki.changed && !aops.changed) continue;

            stmt.run(
                wiki.statement,
                wiki.choicesJson,
                wiki.answerIndex,
                aops.statement,
                aops.choicesJson,
                aops.answerIndex,
                wiki.statement,
                aops.statement,
                wiki.choicesJson,
                wiki.answerIndex,
                aops.answerIndex,
                p.id,
            );
            updatedProblems++;
            if (wiki.changed) updatedWiki++;
            if (aops.changed) updatedAops++;
        }
    })();

    console.log(
        `  Updated ${updatedProblems} problem(s) (${updatedWiki} wiki tier, ${updatedAops} AoPS tier).`,
    );
}

function reclassifyAcgn(db) {
    console.log("Step 2: Re-inferring ACGN classification...");
    // Joined to tests because a test can declare its problems' subject outright
    // (a Calculus / Integration Bee round), in which case that declaration wins
    // over the keyword inference — see src/topicPolicy.js.
    const problems = db
        .query(
            `SELECT p.id, p.statement, t.format AS test_format
             FROM problems p
             LEFT JOIN tests t ON t.id = p.test_id
             WHERE p.statement IS NOT NULL`,
        )
        .all();
    let updated = 0;
    const stmt = db.prepare("UPDATE problems SET acgn = ? WHERE id = ?");

    db.transaction(() => {
        for (const p of problems) {
            const newAcgn = resolveTopic(p.statement, {
                format: p.test_format,
            });
            stmt.run(newAcgn, p.id);
            updated++;
        }
    })();

    console.log(`  Updated acgn for ${updated} problems.`);
}

function retagProblems(db) {
    console.log("Step 3: Re-applying auto-tags (union with existing)...");
    const problems = db.query("SELECT id, statement, tags FROM problems WHERE statement IS NOT NULL").all();
    let updated = 0;
    const stmt = db.prepare("UPDATE problems SET tags = ? WHERE id = ?");

    db.transaction(() => {
        for (const p of problems) {
            const newTags = getAutoTags(p.statement);
            if (newTags.length === 0) continue;

            const existingTags = p.tags ? JSON.parse(p.tags) : [];
            const merged = [...new Set([...existingTags, ...newTags])];

            if (merged.length !== existingTags.length) {
                stmt.run(JSON.stringify(merged), p.id);
                updated++;
            }
        }
    })();

    console.log(`  Updated tags for ${updated} problems.`);
}

function reclassifySolutions(db) {
    console.log("Step 5: Re-classifying solution candidates...");
    const result = classifySolutions(db);
    console.log(
        `  Classified ${result.updated} solution(s); marked ${result.duplicates} near-duplicate(s).`,
    );
}

function detectOfficialSolutions(db) {
    console.log("Step 4: Detecting official solution sources by known organizers...");

    if (!SOLUTIONS_USERS || SOLUTIONS_USERS.length === 0) {
        console.log("  No SOLUTIONS_USERS defined, skipping.");
        return;
    }

    const userIds = SOLUTIONS_USERS.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');

    const sourceResult = db.run(
        `UPDATE solution_sources
         SET is_official_hint = 1,
             reliability_hint = MAX(reliability_hint, 90),
             last_seen_at = datetime('now')
         WHERE aops_user_id IN (${placeholders})
           AND is_official_hint = 0`,
        userIds
    );

    const solutionResult = db.run(`
        UPDATE solutions
        SET is_official = 1,
            updated_at = datetime('now')
        WHERE status_source != 'manual'
          AND EXISTS (
              SELECT 1
              FROM solution_sources ss
              WHERE ss.solution_id = solutions.id
                AND ss.is_official_hint = 1
          )
    `);

    console.log(
        `  Marked ${sourceResult.changes} source(s) and ${solutionResult.changes} solution(s) as official hints.`,
    );
}

function crossCheckAnswers(db) {
    console.log("Step 6: Cross-checking AoPS vs PDF answers...");

    const mismatches = db.query(`
        SELECT p.id, p.aops_answer, p.pdf_answer, t.name AS test_name, p.n
        FROM problems p
        JOIN tests t ON p.test_id = t.id
        WHERE p.aops_answer IS NOT NULL
          AND p.pdf_answer IS NOT NULL
          AND p.aops_answer != p.pdf_answer
    `).all();

    if (mismatches.length === 0) {
        console.log("  No answer mismatches found.");
        return;
    }

    console.log(`  WARNING: ${mismatches.length} answer mismatch(es) found:`);
    for (const m of mismatches) {
        console.log(`    [${m.test_name} P${m.n + 1}] aops="${m.aops_answer}" vs pdf="${m.pdf_answer}"`);
    }
}
