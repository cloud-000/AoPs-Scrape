import { CleanupText } from './CleanupText.js';
import { getAutoTags } from './autoTags.js';
import { SOLUTIONS_USERS } from '../contest_id.js';

/**
 * Pre-processing pipeline. Operates on all problems in the DB (idempotent).
 * NOT subject to scraper-immutable rules — can update topic, tags, solution flags.
 *
 * Responsibilities:
 * 1. Re-run inferACGN on every problem (can update topic)
 * 2. Apply AUTO_TAGS and union into existing tags
 * 3. Re-apply solution classification rules to existing solutions
 * 4. is_official detection for solutions based on known organizers
 * 5. Answer cross-check: log warnings where aops_answer != pdf_answer
 */
export async function runPreprocess(db) {
    console.log("Running pre-processing pipeline...\n");

    await retopicProblems(db);
    await retagProblems(db);
    await reclassifySolutions(db);
    await detectOfficialSolutions(db);
    await crossCheckAnswers(db);

    console.log("\nPre-processing complete.");
}

function retopicProblems(db) {
    console.log("Step 1: Re-inferring ACGN topic classification...");
    const problems = db.query("SELECT id, aops_statement FROM problems WHERE aops_statement IS NOT NULL").all();
    let updated = 0;
    const stmt = db.prepare("UPDATE problems SET topic = ? WHERE id = ?");

    db.transaction(() => {
        for (const p of problems) {
            const newTopic = CleanupText.inferACGN(p.aops_statement);
            stmt.run(newTopic, p.id);
            updated++;
        }
    })();

    console.log(`  Updated topic for ${updated} problems.`);
}

function retagProblems(db) {
    console.log("Step 2: Re-applying auto-tags (union with existing)...");
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
    console.log("Step 3: Re-classifying solutions (no-op for existing classification)...");
    // Solutions are already classified at scrape time. This step is a placeholder
    // for future re-classification when rules change.
    console.log("  Skipped (solutions classified at scrape time).");
}

function detectOfficialSolutions(db) {
    console.log("Step 4: Detecting official solutions by known organizers...");

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
    console.log("Step 5: Cross-checking AoPS vs PDF answers...");

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
