// ---------------------------------------------------------------------------
// Token -> { label, order, subject? } maps. Every structural taxonomy the
// importers key off lives here so the axes are visible in one place; the
// exported helpers below just look tokens up in these.
//
// `subject` is optional and only meaningful on a *format* (round) registry: it
// declares that every problem in such a round is that topic, regardless of what
// keywords its statement happens to contain — an Integration Bee item is a bare
// integral, and a Calculus round is calculus by construction. Rounds that mix
// subjects (a Team or Guts round, or HMMT's combined "Algebra/Calculus") simply
// omit it and keep the per-statement heuristic. See src/topicPolicy.js for how
// the declaration is consumed, and subjectForFormat() at the bottom of this file
// for the lookup.
// ---------------------------------------------------------------------------

import { TOPIC } from "./CleanupText.js";

// Suffix a round's tiebreaker label carries (see smtFormatMetadata), and the one
// piece of label grammar subjectForFormat has to understand.
const TIEBREAKER_SUFFIX = "Tiebreaker";

// MATHCOUNTS levels (the "which division" axis).
const MATHCOUNTS_DIVISIONS = new Map([
    ["school", { label: "School", order: 10 }],
    ["chapter", { label: "Chapter", order: 20 }],
    ["state", { label: "State", order: 30 }],
    ["national", { label: "National", order: 40 }],
]);

// MATHCOUNTS rounds (the "which format" axis). The Countdown round is spelled
// two ways across the OCR tree ("cdr" in the older folders, "countdown" in the
// 2023+ ones); both are the same round and resolve to one label, so the two
// spellings merge onto a single test rather than splitting it.
const MATHCOUNTS_COUNTDOWN = { label: "Countdown", order: 40 };
const MATHCOUNTS_FORMATS = new Map([
    ["sprint", { label: "Sprint", order: 10 }],
    ["target", { label: "Target", order: 20 }],
    ["team", { label: "Team", order: 30 }],
    ["cdr", MATHCOUNTS_COUNTDOWN],
    ["countdown", MATHCOUNTS_COUNTDOWN],
]);

const SCHOOL_DIVISIONS = new Map([
    ["middle school", { label: "Middle School", order: 10 }],
    ["high school", { label: "High School", order: 20 }],
]);

// Version letters of one contest (an AMC 10A vs. 10B). "P" is the 2002-only
// third administration, which both AoPS and the wiki spell as a version.
const LETTER_FORMATS = new Map([
    ["A", { label: "A", order: 10 }],
    ["B", { label: "B", order: 20 }],
    ["P", { label: "P", order: 30 }],
]);

const AIME_FORMATS = new Map([
    ["I", { label: "I", order: 10 }],
    ["II", { label: "II", order: 20 }],
]);

// HMMT's structural token is the season/administration: February, November, or
// the invitational (HMIC). This is the "which division" axis, so it maps to
// `division`. HMMT has no format of its own at the season level (the round/theme
// like Guts/Algebra is captured separately as the format by the importer).
const HMMT_SEASONS = new Map([
    ["feb", { label: "February", order: 10 }],
    ["nov", { label: "November", order: 20 }],
    ["hmic", { label: "Invitational", order: 30 }],
]);

// HMMT rounds/themes (the "which format" axis). The combined rounds
// ("Algebra/Calculus" and friends, run only in 2011) are half non-calculus, so
// they deliberately declare no subject.
const HMMT_ROUNDS = new Map([
    ["adv", { label: "Advanced", order: 10 }],
    ["alg", { label: "Algebra", order: 20, subject: TOPIC.ALGEBRA }],
    ["calc", { label: "Calculus", order: 30, subject: TOPIC.CALCULUS }],
    [
        "comb",
        { label: "Combinatorics", order: 40, subject: TOPIC.COMBINATORICS },
    ],
    ["geo", { label: "Geometry", order: 50, subject: TOPIC.GEOMETRY }],
    ["gen", { label: "General", order: 60 }],
    ["gen1", { label: "General 1", order: 61 }],
    ["gen2", { label: "General 2", order: 62 }],
    ["guts", { label: "Guts", order: 70 }],
    ["oral", { label: "Oral", order: 80 }],
    ["pow", { label: "Power", order: 90 }],
    ["team", { label: "Team", order: 100 }],
    ["team1", { label: "Team 1", order: 101 }],
    ["team2", { label: "Team 2", order: 102 }],
    ["algcalc", { label: "Algebra/Calculus", order: 110 }],
    ["algcomb", { label: "Algebra/Combinatorics", order: 120 }],
    ["alggeo", { label: "Algebra/Geometry", order: 130 }],
    ["algnt", { label: "Algebra/Number Theory", order: 140 }],
    ["calccomb", { label: "Calculus/Combinatorics", order: 150 }],
    ["calcgeo", { label: "Calculus/Geometry", order: 160 }],
    ["combgeo", { label: "Combinatorics/Geometry", order: 170 }],
    ["thm", { label: "Theme", order: 180 }],
]);

// PUMaC subjects (the "which format" axis); the A/B letter is the division.
const PUMAC_SUBJECTS = new Map([
    ["algebra", { label: "Algebra", order: 10, subject: TOPIC.ALGEBRA }],
    [
        "combinatorics",
        { label: "Combinatorics", order: 20, subject: TOPIC.COMBINATORICS },
    ],
    ["geometry", { label: "Geometry", order: 30, subject: TOPIC.GEOMETRY }],
    [
        "number_theory",
        { label: "Number Theory", order: 40, subject: TOPIC.NUMBER_THEORY },
    ],
    ["individual_finals", { label: "Individual Finals", order: 50 }],
]);

// CMIMC divisions (the "which division" axis).
const CMIMC_DIVISIONS = new Map([
    ["individual", { label: "Individual", order: 10 }],
    ["team", { label: "Team", order: 20 }],
    ["division-1", { label: "Division 1", order: 30 }],
    ["division-2", { label: "Division 2", order: 40 }],
    ["mini-events", { label: "Mini-Events", order: 50 }],
]);

// CMIMC rounds/subjects (the "which format" axis). The Computer Science round is
// its own discipline with no ACGNK code, so it declares no subject.
const CMIMC_FORMATS = new Map([
    ["algebra", { label: "Algebra", order: 10, subject: TOPIC.ALGEBRA }],
    [
        "combinatorics",
        { label: "Combinatorics", order: 20, subject: TOPIC.COMBINATORICS },
    ],
    ["geometry", { label: "Geometry", order: 30, subject: TOPIC.GEOMETRY }],
    [
        "number-theory",
        { label: "Number Theory", order: 40, subject: TOPIC.NUMBER_THEORY },
    ],
    ["computer-science", { label: "Computer Science", order: 50 }],
    ["team", { label: "Team", order: 60 }],
    ["finals", { label: "Finals", order: 70 }],
    [
        "integration-bee",
        { label: "Integration Bee", order: 80, subject: TOPIC.CALCULUS },
    ],
]);

// CHMMC administrations (the "which division" axis).
const CHMMC_SEASONS = new Map([
    ["winter", { label: "Winter", order: 10 }],
    ["spring", { label: "Spring", order: 20 }],
    ["fall", { label: "Fall", order: 30 }],
    ["annual", { label: "Annual", order: 40 }],
]);

// CHMMC rounds (the "which format" axis).
const CHMMC_FORMATS = new Map([
    ["individual", { label: "Individual", order: 10 }],
    ["team", { label: "Team", order: 20 }],
    ["tiebreaker", { label: "Tiebreaker", order: 30 }],
    ["mixer", { label: "Mixer", order: 40 }],
    ["proof", { label: "Proof", order: 50 }],
    [
        "integration-bee-qualifying",
        {
            label: "Integration Bee Qualifying",
            order: 60,
            subject: TOPIC.CALCULUS,
        },
    ],
    [
        "integration-bee-finals",
        {
            label: "Integration Bee Finals",
            order: 70,
            subject: TOPIC.CALCULUS,
        },
    ],
]);

// OMO administrations (the "which division" axis). The contest ran a Fall and a
// January "Winter" edition through 2013, then moved the second one to April and
// renamed it Spring; both spellings are live, so both are registered. OMO has no
// format axis — each contest is a single undivided round.
const OMO_SEASONS = new Map([
    ["winter", { label: "Winter", order: 10 }],
    ["spring", { label: "Spring", order: 20 }],
    ["fall", { label: "Fall", order: 30 }],
]);

// NIMO administrations (the "which division" axis). NIMO ran four kinds of
// contest under one series: a monthly short-answer contest, a Summer Contest, an
// April Fun Round, and the proof-based Winter Olympiad. For the monthly contest
// the administration IS its month, so the months are registered here alongside
// the three named contests and ordered by the calendar, which is the order a
// year's contests were run in. Like OMO there is no format axis — every NIMO
// contest is a single undivided round — so this is the series' only axis.
const NIMO_CONTESTS = new Map([
    ["january", { label: "January", order: 10 }],
    ["february", { label: "February", order: 20 }],
    ["march", { label: "March", order: 30 }],
    ["april", { label: "April", order: 40 }],
    ["may", { label: "May", order: 50 }],
    ["june", { label: "June", order: 60 }],
    ["july", { label: "July", order: 70 }],
    ["august", { label: "August", order: 80 }],
    ["september", { label: "September", order: 90 }],
    ["october", { label: "October", order: 100 }],
    ["november", { label: "November", order: 110 }],
    ["december", { label: "December", order: 120 }],
    ["summer", { label: "Summer", order: 130 }],
    ["april_fun", { label: "April Fun Round", order: 140 }],
    ["winter_olympiad", { label: "Winter Olympiad", order: 150 }],
]);

// A NIMO folder token repeated within one year carries a comp-OCR dedup suffix
// ("2015_summer_2"), which is a real second contest rather than a spelling: the
// compendium prints "5. Summer 2015" and "6. Summer 2015" as separate contests.
// The suffix is part of the administration, so it rides into the label.
const NIMO_REPEAT_RE = /^(.+)_(\d+)$/;

// MPFG splits into two distinct contest types under one umbrella series family.
// The type is the "which division" axis, so it maps to `division`. No format.
const MPFG_CONTESTS = new Map([
    ["mathprize", { label: "Math Prize", order: 10 }],
    ["olympiad", { label: "Olympiad", order: 20 }],
]);

// Mandelbrot Competition divisions (the "which division" axis). The individual
// test (`tmc` folders) ran in a harder National and an easier Regional division;
// Team Play (`mtp` folders) is the separate team component with no N/R split. The
// round number rides on the format instead (numberedFormatMetadata).
const MANDELBROT_DIVISIONS = new Map([
    ["N", { label: "National", order: 10 }],
    ["R", { label: "Regional", order: 20 }],
    ["team", { label: "Team Play", order: 30 }],
]);

// Berkeley Math Tournament divisions (the "which division" axis): the main BMT,
// the middle-school BMMT, and its online variant. The subject/round rides on the
// format instead (BMT_FORMATS).
const BMT_DIVISIONS = new Map([
    ["bmt", { label: "BMT", order: 10 }],
    ["bmmt", { label: "BMMT", order: 20 }],
    ["bmmt-online", { label: "BMMT Online", order: 50 }],
]);

// BMMT 2019 was administered as parallel regional editions. The region rides on
// the OCR *format* token ("team-us-iran"), but it identifies an administration,
// not a round — so it folds into the division label and the format stays the
// plain round ("Team"), keeping round ordering and subject declarations intact.
// See splitBmtRegion / bmtDivisionMetadata.
const BMT_REGIONS = new Map([
    ["us-iran", { suffix: "US/Iran", order: 30 }],
    ["china-toronto", { suffix: "China/Toronto", order: 40 }],
]);

// BMT rounds/subjects (the "which format" axis), alphabetical. "Analysis" is
// what BMT called its calculus round before 2018; "Discrete" spans combinatorics
// AND number theory, so unlike the single-subject rounds it declares no subject.
const BMT_FORMATS = new Map([
    ["algebra", { label: "Algebra", order: 10, subject: TOPIC.ALGEBRA }],
    ["analysis", { label: "Analysis", order: 20, subject: TOPIC.CALCULUS }],
    ["calculus", { label: "Calculus", order: 30, subject: TOPIC.CALCULUS }],
    ["ciphering", { label: "Ciphering", order: 40 }],
    [
        "combinatorics",
        { label: "Combinatorics", order: 50, subject: TOPIC.COMBINATORICS },
    ],
    ["discrete", { label: "Discrete", order: 60 }],
    ["general", { label: "General", order: 70 }],
    ["geometry", { label: "Geometry", order: 80, subject: TOPIC.GEOMETRY }],
    ["guts", { label: "Guts", order: 90 }],
    ["individual", { label: "Individual", order: 100 }],
    [
        "number-theory",
        { label: "Number Theory", order: 110, subject: TOPIC.NUMBER_THEORY },
    ],
    ["pacer", { label: "Pacer", order: 120 }],
    ["partner", { label: "Partner", order: 130 }],
    ["speed", { label: "Speed", order: 140 }],
    ["team", { label: "Team", order: 150 }],
    ["tournament", { label: "Tournament", order: 160 }],
]);

// Stanford Math Tournament divisions (the "which division" axis): the flagship
// SMT plus the ASMT and SM3 sub-tournaments under the same umbrella series. The
// subject/round rides on the format instead (SMT_FORMATS).
const SMT_DIVISIONS = new Map([
    ["asmt", { label: "ASMT", order: 10 }],
    ["sm3", { label: "SM3", order: 20 }],
    ["smt", { label: "SMT", order: 30 }],
]);

// SMT rounds/subjects (the "which format" axis), alphabetical. A
// "<subject>-tiebreaker" folder reuses its base subject's label/order plus a +5
// bump so the tiebreaker sorts immediately after its subject (see
// formatWithTiebreaker). "Discrete" spans combinatorics AND number theory, so
// unlike the single-subject rounds it declares no subject. The SM3
// sub-tournament contributes the Tree Relay and Construction Challenge rounds.
const SMT_FORMATS = new Map([
    ["advanced", { label: "Advanced", order: 10 }],
    ["algebra", { label: "Algebra", order: 20, subject: TOPIC.ALGEBRA }],
    ["calculus", { label: "Calculus", order: 30, subject: TOPIC.CALCULUS }],
    [
        "combo",
        { label: "Combinatorics", order: 40, subject: TOPIC.COMBINATORICS },
    ],
    ["construction", { label: "Construction Challenge", order: 50 }],
    ["discrete", { label: "Discrete", order: 60 }],
    ["general", { label: "General", order: 70 }],
    ["geometry", { label: "Geometry", order: 80, subject: TOPIC.GEOMETRY }],
    ["guts", { label: "Guts", order: 90 }],
    [
        "integrationbee",
        { label: "Integration Bee", order: 100, subject: TOPIC.CALCULUS },
    ],
    [
        // Labelled to match CHMMC's qualifying round rather than the folder
        // token, so one vocabulary covers both series.
        "integrationbeequalification",
        {
            label: "Integration Bee Qualifying",
            order: 110,
            subject: TOPIC.CALCULUS,
        },
    ],
    ["nt", { label: "Number Theory", order: 120, subject: TOPIC.NUMBER_THEORY }],
    ["power", { label: "Power", order: 130 }],
    ["team", { label: "Team", order: 140 }],
    ["treelay", { label: "Tree Relay", order: 150 }],
]);

// FARML events (the "which format" axis). FARML publishes one packet per year
// holding every event, so unlike the other series these tokens are not folder
// names — they are produced by the importer's problem-number router (see
// FARML_ROUNDS in pdfImport.js). The two relay chains (R1/x, R2/x) are one
// event administered twice, so they share the "Relay" label rather than
// splitting a six-problem round across two tests. Every event is mixed-topic,
// so none declares a subject.
const FARML_FORMATS = new Map([
    ["team", { label: "Team", order: 10 }],
    ["individual", { label: "Individual", order: 20 }],
    ["relay", { label: "Relay", order: 30 }],
    ["tiebreaker", { label: "Tiebreaker", order: 40 }],
]);

export function emptyTestMetadata() {
    return {
        division: null,
        divisionOrder: null,
        format: null,
        formatOrder: null,
    };
}

// Note that `subject` is deliberately NOT carried into the returned metadata:
// these objects are spread onto the `tests` row, and the subject is not a stored
// column — it is looked up from the label on demand (subjectForFormat).
function fromEntry(kind, entry) {
    if (!entry) return null;
    return kind === "division"
        ? { division: entry.label, divisionOrder: entry.order }
        : { format: entry.label, formatOrder: entry.order };
}

// Looks a round token up in `registry`, honoring a "<round>-tiebreaker" token:
// the tiebreaker reuses its base round's label with a " Tiebreaker" suffix and a
// +5 order bump, so it sorts immediately after the round it breaks. Returns only
// format fields (`{}` when unknown), so it can be spread alongside division
// metadata. Shared by BMT and SMT, whose OCR folders use the same convention.
function formatWithTiebreaker(registry, token) {
    if (!token) return {};
    const t = token.toLowerCase();
    const suffix = `-${TIEBREAKER_SUFFIX.toLowerCase()}`;
    const isTiebreaker = t.endsWith(suffix);
    const entry = registry.get(
        isTiebreaker ? t.slice(0, -suffix.length) : t,
    );
    if (!entry) return {};
    return isTiebreaker
        ? {
              format: `${entry.label} ${TIEBREAKER_SUFFIX}`,
              formatOrder: entry.order + 5,
          }
        : { format: entry.label, formatOrder: entry.order };
}

export function foldedSectionMetadata(label) {
    if (!label) return null;
    const division = fromEntry(
        "division",
        SCHOOL_DIVISIONS.get(label.trim().toLowerCase()),
    );
    if (division) return { ...emptyTestMetadata(), ...division };
    const format = fromEntry(
        "format",
        LETTER_FORMATS.get(label.trim().toUpperCase()),
    );
    return format ? { ...emptyTestMetadata(), ...format } : null;
}

export function sectionTestMetadata(type, sectionName) {
    if (!sectionName) return null;
    const label = sectionName.trim();
    const division = fromEntry(
        "division",
        SCHOOL_DIVISIONS.get(label.toLowerCase()),
    );
    if (division) return { ...emptyTestMetadata(), ...division };

    // A season label is an administration, which is the division axis — an OMO
    // year category carries its two contests as "Winter"/"Fall" (through 2013)
    // or "Spring"/"Fall" sections. Resolved from the same registry the PDF
    // importer uses, so a scraped row and a PDF-imported one cannot disagree on
    // the label or its order. This only decides a row the PDF import never
    // touched: where both sources cover a test, the scrape passes the identical
    // value onto a row that already has it.
    const season = fromEntry("division", OMO_SEASONS.get(label.toLowerCase()));
    if (season) return { ...emptyTestMetadata(), ...season };

    if (type === "AIME") {
        const format = fromEntry(
            "format",
            AIME_FORMATS.get(label.toUpperCase()),
        );
        return format ? { ...emptyTestMetadata(), ...format } : null;
    }

    // An AMC section is a version (A/B/P) by the time it reaches here —
    // CleanupText.resolveVersionSections has already turned the raw date labels
    // into letters. Resolving them to the same format registry the wiki
    // importer uses keeps the two sources' metadata identical on a merged row.
    if (/^AMC\b/.test(type ?? "")) {
        const format = fromEntry(
            "format",
            LETTER_FORMATS.get(label.toUpperCase()),
        );
        return format ? { ...emptyTestMetadata(), ...format } : null;
    }

    const day = label.match(/^Day\s+(\d+)$/i);
    if (day) {
        const n = Number(day[1]);
        return {
            ...emptyTestMetadata(),
            format: `Day ${n}`,
            formatOrder: n * 10,
        };
    }
    return null;
}

export function wikiTestMetadata(titleBase) {
    if (titleBase === "AMC 8") return emptyTestMetadata();

    // The season prefix ("Fall AMC 12A") is part of the wiki's page-title base
    // and rides along in the test name; the version letter is still the format.
    const amc = titleBase.match(/^(?:Fall\s+|Spring\s+)?AMC\s+(?:10|12)([ABP])$/);
    if (amc) {
        return {
            ...emptyTestMetadata(),
            ...fromEntry("format", LETTER_FORMATS.get(amc[1])),
        };
    }

    const aime = titleBase.match(/^AIME\s+(I|II)$/);
    if (aime) {
        return {
            ...emptyTestMetadata(),
            ...fromEntry("format", AIME_FORMATS.get(aime[1])),
        };
    }
    return null;
}

export function mathcountsTestMetadata(divisionToken, formatToken) {
    const division = fromEntry(
        "division",
        MATHCOUNTS_DIVISIONS.get(divisionToken?.toLowerCase()),
    );
    const format = fromEntry(
        "format",
        MATHCOUNTS_FORMATS.get(formatToken?.toLowerCase()),
    );
    return { ...emptyTestMetadata(), ...(division ?? {}), ...(format ?? {}) };
}

export function schoolDivisionMetadata(levelToken) {
    const aliases = { HS: "high school", MS: "middle school" };
    const entry = SCHOOL_DIVISIONS.get(aliases[levelToken?.toUpperCase()]);
    return { ...emptyTestMetadata(), ...(fromEntry("division", entry) ?? {}) };
}

export function numberedFormatMetadata(prefix, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return emptyTestMetadata();
    return {
        ...emptyTestMetadata(),
        format: `${prefix} ${n}`,
        formatOrder: n * 10,
    };
}

// HMMT's structural token is the season/administration (February/November/HMIC),
// the "which division" axis (map: HMMT_SEASONS). HMMT has no format of its own at
// the season level — the round/theme (Guts/Algebra) rides on the format instead.
export function hmmtSeasonMetadata(monthOrKindToken) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry(
            "division",
            HMMT_SEASONS.get(monthOrKindToken?.toLowerCase()),
        ) ?? {}),
    };
}

export function mpfgContestMetadata(kindToken) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry(
            "division",
            MPFG_CONTESTS.get(kindToken?.toLowerCase()),
        ) ?? {}),
    };
}

// PUMaC's A/B letter is its "which division" axis (mirrors AMC A/B via
// LETTER_FORMATS); Team is a distinct division. No format at the letter level
// (the subject like Algebra/Geometry is captured separately as the format).
export function pumacDivisionMetadata(letterToken) {
    const L = letterToken?.toUpperCase();
    if (L === "TEAM") {
        return { ...emptyTestMetadata(), division: "Team", divisionOrder: 30 };
    }
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", LETTER_FORMATS.get(L)) ?? {}),
    };
}

// HMMT round/theme (Guts, Algebra, General, Team, ...) is the "which format"
// axis. Returns only format fields (no division) so it can be spread alongside
// the season division metadata without clobbering it. `{}` for an unknown or
// absent token — HMIC has no round, and callers treat a missing `format` as an
// unparseable folder.
export function hmmtRoundMetadata(token) {
    return fromEntry("format", HMMT_ROUNDS.get(token?.toLowerCase())) ?? {};
}

// PUMaC subject (Algebra, Geometry, Combinatorics, Number Theory, Individual
// Finals) is the "which format" axis. Returns only format fields.
export function pumacSubjectMetadata(token) {
    return fromEntry("format", PUMAC_SUBJECTS.get(token?.toLowerCase())) ?? {};
}

// CMIMC division (Individual/Team/Division 1/2/Mini-Events). Full base + division.
export function cmimcDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", CMIMC_DIVISIONS.get(token?.toLowerCase())) ??
            {}),
    };
}

// CMIMC round/subject is the "which format" axis. Returns only format fields.
export function cmimcFormatMetadata(token) {
    return fromEntry("format", CMIMC_FORMATS.get(token?.toLowerCase())) ?? {};
}

// CHMMC administration (Winter/Spring/Fall/Annual) is the "which division"
// axis. Full base + division.
export function chmmcSeasonMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", CHMMC_SEASONS.get(token?.toLowerCase())) ??
            {}),
    };
}

// CHMMC round is the "which format" axis. Returns only format fields.
export function chmmcFormatMetadata(token) {
    return fromEntry("format", CHMMC_FORMATS.get(token?.toLowerCase())) ?? {};
}

// OMO administration (Winter/Spring/Fall) is the "which division" axis, and the
// only axis OMO has. Full base + division.
export function omoSeasonMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", OMO_SEASONS.get(token?.toLowerCase())) ?? {}),
    };
}

// NIMO administration (a month for the monthly contest, else Summer / April Fun
// Round / Winter Olympiad) is the "which division" axis, and the only axis NIMO
// has. A repeated contest keeps its base label plus the repeat's ordinal
// ("Summer 2") and sorts immediately after the first ("2015 NIMO Summer" then
// "2015 NIMO Summer 2"). Full base + division.
export function nimoContestMetadata(token) {
    const t = token?.toLowerCase() ?? "";
    const repeat = t.match(NIMO_REPEAT_RE);
    const entry = NIMO_CONTESTS.get(repeat ? repeat[1] : t);
    if (!entry) return emptyTestMetadata();
    if (!repeat) {
        return { ...emptyTestMetadata(), ...fromEntry("division", entry) };
    }
    const nth = Number(repeat[2]);
    return {
        ...emptyTestMetadata(),
        division: `${entry.label} ${nth}`,
        divisionOrder: entry.order + nth - 1,
    };
}

// FARML event is the "which format" axis. Returns only format fields.
export function farmlFormatMetadata(token) {
    return fromEntry("format", FARML_FORMATS.get(token?.toLowerCase())) ?? {};
}

// Mandelbrot division: "N"/"R" (individual National/Regional) or "team" (Team
// Play). Returns the full base + division fields; the round is a separate format.
export function mandelbrotDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", MANDELBROT_DIVISIONS.get(token)) ?? {}),
    };
}

// Splits a trailing regional token off a BMT format token, e.g.
// "team-us-iran" -> { formatToken: "team", regionToken: "us-iran" }. The region
// belongs to the division (see BMT_REGIONS), so the caller feeds each half to
// the axis it belongs to. A token with no region passes through unchanged.
export function splitBmtRegion(token) {
    const t = token?.toLowerCase() ?? "";
    for (const region of BMT_REGIONS.keys()) {
        if (t.endsWith(`-${region}`)) {
            return {
                formatToken: t.slice(0, -(region.length + 1)),
                regionToken: region,
            };
        }
    }
    return { formatToken: t, regionToken: null };
}

// BMT division (main/BMMT/BMMT Online) is the "which division" axis, optionally
// qualified by a regional edition ("BMMT US/Iran"). Returns the full base +
// division fields.
export function bmtDivisionMetadata(token, regionToken = null) {
    const entry = BMT_DIVISIONS.get(token?.toLowerCase());
    if (!entry) return emptyTestMetadata();
    const region = regionToken ? BMT_REGIONS.get(regionToken) : null;
    return {
        ...emptyTestMetadata(),
        division: region ? `${entry.label} ${region.suffix}` : entry.label,
        divisionOrder: region ? region.order : entry.order,
    };
}

// BMT round/subject is the "which format" axis, with the same "<round>-tiebreaker"
// rule as SMT. Returns only format fields so it can be spread alongside the
// division metadata.
export function bmtFormatMetadata(token) {
    return formatWithTiebreaker(BMT_FORMATS, token);
}

// SMT division (ASMT/SM3/SMT) is the "which division" axis. Returns the full base
// + division fields.
export function smtDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", SMT_DIVISIONS.get(token?.toLowerCase())) ?? {}),
    };
}

// SMT round/subject is the "which format" axis, with the "<round>-tiebreaker"
// rule. Returns only format fields.
export function smtFormatMetadata(token) {
    return formatWithTiebreaker(SMT_FORMATS, token);
}

// ---------------------------------------------------------------------------
// Declared subjects
// ---------------------------------------------------------------------------

// Every registry on the *format* (round) axis. Only these can declare a subject:
// a division ("BMT", "Winter", "Division 1") says which administration a test
// belongs to, never what it is about.
const FORMAT_REGISTRIES = [
    MATHCOUNTS_FORMATS,
    LETTER_FORMATS,
    AIME_FORMATS,
    HMMT_ROUNDS,
    PUMAC_SUBJECTS,
    BMT_FORMATS,
    SMT_FORMATS,
    CMIMC_FORMATS,
    CHMMC_FORMATS,
    FARML_FORMATS,
];

// A round's declared subject is keyed by its *label*, not its token, because the
// label is what survives into `tests.format` — the token is a comp-OCR folder
// spelling that differs per series ("calc" vs "calculus") and is gone by the
// time anything asks. Labels are keyed globally rather than per series: a
// subject label means the same thing in every contest that uses it, and the
// build below throws if two registries ever disagree, so a future conflict
// surfaces at import time instead of silently mislabeling problems.
const SUBJECT_BY_FORMAT = (() => {
    const map = new Map();
    for (const registry of FORMAT_REGISTRIES) {
        for (const entry of registry.values()) {
            if (!entry.subject) continue;
            const prior = map.get(entry.label);
            if (prior && prior !== entry.subject) {
                throw new Error(
                    `Conflicting declared subject for format "${entry.label}": ` +
                        `${prior} vs ${entry.subject}`,
                );
            }
            map.set(entry.label, entry.subject);
        }
    }
    return map;
})();

/**
 * The topic a round declares for every problem in it, or null when it declares
 * none (the common case: Team, Guts, General, an AMC, a mixed round).
 *
 * Takes the stored `tests.format` label. A "<Subject> Tiebreaker" resolves to
 * its base subject — the tiebreaker of a calculus round is still calculus, and
 * smtFormatMetadata synthesizes that label rather than registering it.
 *
 * @param {string|null|undefined} formatLabel a `tests.format` value
 * @returns {string|null} a TOPIC code, or null
 */
export function subjectForFormat(formatLabel) {
    if (!formatLabel) return null;
    const label = formatLabel.trim();
    const base = label.endsWith(` ${TIEBREAKER_SUFFIX}`)
        ? label.slice(0, -(TIEBREAKER_SUFFIX.length + 1))
        : label;
    return SUBJECT_BY_FORMAT.get(base) ?? null;
}
