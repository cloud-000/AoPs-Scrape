import { CleanupText } from './CleanupText.js';
import { getAutoTags } from './autoTags.js';
import { SOLUTIONS_USERS } from '../contest_id.js';

/**
 * Pre-processing pipeline. Operates on all problems in the DB (idempotent).
 * NOT subject to scraper-immutable rules — can update acgn, tags, choices,
 * solution flags.
 *
 * Responsibilities:
 * 1. Re-extract MCQ choices / clean statements on the source of truth
 * 2. Re-run inferACGN on every problem (can update acgn)
 * 3. Apply AUTO_TAGS and union into existing tags
 * 4. Re-apply solution classification rules to existing solutions
 * 5. is_official detection for solutions based on known organizers
 * 6. Answer cross-check: log warnings where aops_answer != pdf_answer
 */
export async function runPreprocess(db) {
    console.log("Running pre-processing pipeline...\n");

    await refreshChoices(db);
    await reclassifyAcgn(db);
    await retagProblems(db);
    await reclassifySolutions(db);
    await detectOfficialSolutions(db);
    await crossCheckAnswers(db);

    console.log("\nPre-processing complete.");
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
    const problems = db.query("SELECT id, aops_statement FROM problems WHERE aops_statement IS NOT NULL").all();
    let updated = 0;
    const stmt = db.prepare("UPDATE problems SET acgn = ? WHERE id = ?");

    db.transaction(() => {
        for (const p of problems) {
            const newAcgn = CleanupText.inferACGN(p.aops_statement);
            stmt.run(newAcgn, p.id);
            updated++;
        }
    })();

    console.log(`  Updated acgn for ${updated} problems.`);
}

function retagProblems(db) {
    console.log("Step 3: Re-applying auto-tags (union with existing)...");
    const problems = db.query("SELECT id, aops_statement, tags FROM problems WHERE aops_statement IS NOT NULL").all();
    let updated = 0;
    const stmt = db.prepare("UPDATE problems SET tags = ? WHERE id = ?");

    db.transaction(() => {
        for (const p of problems) {
            const newTags = getAutoTags(p.aops_statement);
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
    console.log("Step 4: Re-classifying solutions (no-op for existing classification)...");
    // Solutions are already classified at scrape time. This step is a placeholder
    // for future re-classification when rules change.
    console.log("  Skipped (solutions classified at scrape time).");
}

function detectOfficialSolutions(db) {
    console.log("Step 5: Detecting official solutions by known organizers...");

    if (!SOLUTIONS_USERS || SOLUTIONS_USERS.length === 0) {
        console.log("  No SOLUTIONS_USERS defined, skipping.");
        return;
    }

    const userIds = SOLUTIONS_USERS.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');

    const result = db.run(
        `UPDATE solutions SET is_official = 1 WHERE aops_user_id IN (${placeholders}) AND is_official = 0`,
        userIds
    );

    console.log(`  Marked ${result.changes} solutions as official.`);
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
