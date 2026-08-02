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

// Re-derives MCQ choices from the statement when missing, and re-cleans the
// statement of any leftover appended answer-choice block. Operates on the
// aops_* source columns (the merged `statement` is COALESCE(pdf,...) in the DB).
function refreshChoices(db) {
    console.log("Step 1: Re-extracting MCQ choices / cleaning statements...");
    const problems = db
        .query(
            "SELECT id, aops_statement, aops_choices FROM problems WHERE aops_statement IS NOT NULL",
        )
        .all();
    let updated = 0;
    // Keep the merged `statement` consistent for non-PDF rows (it is
    // COALESCE(pdf_statement, aops_statement)); never clobber a pdf override.
    const stmt = db.prepare(
        "UPDATE problems SET aops_statement = ?, aops_choices = ?, statement = COALESCE(pdf_statement, ?) WHERE id = ?",
    );

    db.transaction(() => {
        for (const p of problems) {
            const hasChoices =
                p.aops_choices &&
                p.aops_choices !== "[]" &&
                JSON.parse(p.aops_choices).length > 0;
            const extracted = hasChoices
                ? JSON.parse(p.aops_choices)
                : CleanupText.extractChoices(p.aops_statement);

            // Nothing to extract → not an MCQ problem; leave it untouched.
            if (!extracted || extracted.length === 0) continue;

            const cleaned = CleanupText.cleanChoices(p.aops_statement).trim();
            if (cleaned !== p.aops_statement || !hasChoices) {
                stmt.run(cleaned, JSON.stringify(extracted), cleaned, p.id);
                updated++;
            }
        }
    })();

    console.log(`  Updated choices/statement for ${updated} problems.`);
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
