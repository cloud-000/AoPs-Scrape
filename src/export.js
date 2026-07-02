// CSV/JSON inspection export. Reads from the derived `production_problems`
// table (the deliverable), so run `build` first. Output is for eyeballing /
// spot-checking — the real consumer is production_problems itself.

function sanitizeStringCSV(content) {
    content = content.replace(/\r\n/g, "\n");
    if (/[",\n\r]/.test(content)) {
        return `"${content.replace(/"/g, '""')}"`;
    }
    return content;
}

function JSONToCSV(data) {
    if (data.length === 0) return "";
    const keys = Object.keys(data[0]);
    let text = keys.join(",") + "\n";
    for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < keys.length; j++) {
            const d = data[i][keys[j]];
            if (Array.isArray(d)) {
                text += `"[${d.map((a) => `""${String(a).replace(/\\/g, "\\\\")}""`).join(",")}]"`;
            } else if (d != null) {
                text += typeof d === "string" ? sanitizeStringCSV(d) : d;
            }
            if (j < keys.length - 1) text += ",";
        }
        if (i < data.length - 1) text += "\n";
    }
    return text;
}

// Writes scrape_data/{series,tests,production_problems}.csv plus a JSON copy of
// the problems. Returns the number of exported problems.
export async function exportProductionCSV(db, outDir = "scrape_data") {
    const problems = db
        .query(
            `
        SELECT pp.test_id, pp.n, pp.aops_id, pp.statement, pp.choices,
               pp.answer_index, pp.answer_value, pp.official_solutions,
               pp.acgn, pp.tags, pp.is_computational, pp.difficulty,
               pp.quality, pp.verified, pp.notes,
               t.name AS test_name, t.year AS test_year,
               s.name AS series_name, s.is_official
        FROM production_problems pp
        JOIN tests t ON pp.test_id = t.id
        JOIN series s ON t.series_id = s.id
        ORDER BY s.name, t.year, t.name, pp.n
    `,
        )
        .all();

    if (problems.length === 0) {
        console.warn(
            "production_problems is empty — run `build` before `export`.",
        );
        return 0;
    }

    const tests = db
        .query(
            `
        SELECT t.*, s.name AS series_name, s.is_official
        FROM tests t JOIN series s ON t.series_id = s.id
        ORDER BY s.name, t.year, t.name
    `,
        )
        .all();

    const series = db.query(`SELECT * FROM series ORDER BY name`).all();

    await Bun.write(`${outDir}/series.csv`, JSONToCSV(series));
    await Bun.write(`${outDir}/tests.csv`, JSONToCSV(tests));
    await Bun.write(
        `${outDir}/production_problems.json`,
        JSON.stringify(problems, null, 2),
    );
    await Bun.write(`${outDir}/production_problems.csv`, JSONToCSV(problems));

    return problems.length;
}
