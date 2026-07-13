// ---------------------------------------------------------------------------
// Token -> [label, order] maps. Every structural taxonomy the importers key off
// lives here so the axes are visible in one place; the exported helpers below
// just look tokens up in these.
// ---------------------------------------------------------------------------

// MATHCOUNTS levels (the "which division" axis).
const MATHCOUNTS_DIVISIONS = new Map([
    ["school", ["School", 10]],
    ["chapter", ["Chapter", 20]],
    ["state", ["State", 30]],
    ["national", ["National", 40]],
]);

// MATHCOUNTS rounds (the "which format" axis). "cdr" is the Countdown round.
const MATHCOUNTS_FORMATS = new Map([
    ["sprint", ["Sprint", 10]],
    ["target", ["Target", 20]],
    ["team", ["Team", 30]],
    ["cdr", ["Countdown", 40]],
]);

const SCHOOL_DIVISIONS = new Map([
    ["middle school", ["Middle School", 10]],
    ["high school", ["High School", 20]],
]);

const LETTER_FORMATS = new Map([
    ["A", ["A", 10]],
    ["B", ["B", 20]],
]);

const AIME_FORMATS = new Map([
    ["I", ["I", 10]],
    ["II", ["II", 20]],
]);

// HMMT's structural token is the season/administration: February, November, or
// the invitational (HMIC). This is the "which division" axis, so it maps to
// `division`. HMMT has no format of its own at the season level (the round/theme
// like Guts/Algebra is captured separately as the format by the importer).
const HMMT_SEASONS = new Map([
    ["feb", ["February", 10]],
    ["nov", ["November", 20]],
    ["hmic", ["Invitational", 30]],
]);

// MPFG splits into two distinct contest types under one umbrella series family.
// The type is the "which division" axis, so it maps to `division`. No format.
const MPFG_CONTESTS = new Map([
    ["mathprize", ["Math Prize", 10]],
    ["olympiad", ["Olympiad", 20]],
]);

// Mandelbrot Competition divisions (the "which division" axis). The individual
// test (`tmc` folders) ran in a harder National and an easier Regional division;
// Team Play (`mtp` folders) is the separate team component with no N/R split. The
// round number rides on the format instead (numberedFormatMetadata).
const MANDELBROT_DIVISIONS = new Map([
    ["N", ["National", 10]],
    ["R", ["Regional", 20]],
    ["team", ["Team Play", 30]],
]);

// Berkeley Math Tournament divisions (the "which division" axis): the main BMT,
// the middle-school BMMT, and its online variant. The subject/round rides on the
// format instead (BMT_FORMATS).
const BMT_DIVISIONS = new Map([
    ["bmt", ["BMT", 10]],
    ["bmmt", ["BMMT", 20]],
    ["bmmt-online", ["BMMT Online", 30]],
]);

// BMT rounds/subjects (the "which format" axis).
const BMT_FORMATS = new Map([
    ["algebra", ["Algebra", 10]],
    ["ciphering", ["Ciphering", 20]],
    ["individual", ["Individual", 30]],
    ["partner", ["Partner", 40]],
    ["speed", ["Speed", 50]],
    ["team", ["Team", 60]],
]);

// Stanford Math Tournament divisions (the "which division" axis): the flagship
// SMT plus the ASMT and SM3 sub-tournaments under the same umbrella series. The
// subject/round rides on the format instead (SMT_FORMATS).
const SMT_DIVISIONS = new Map([
    ["asmt", ["ASMT", 10]],
    ["sm3", ["SM3", 20]],
    ["smt", ["SMT", 30]],
]);

// SMT rounds/subjects (the "which format" axis). A "<subject>-tiebreaker" folder
// reuses its base subject's label/order plus a +5 bump so the tiebreaker sorts
// immediately after its subject (see smtFormatMetadata).
const SMT_FORMATS = new Map([
    ["advanced", ["Advanced", 10]],
    ["algebra", ["Algebra", 20]],
    ["calculus", ["Calculus", 30]],
    ["discrete", ["Discrete", 40]],
    ["general", ["General", 50]],
    ["geometry", ["Geometry", 60]],
    ["guts", ["Guts", 70]],
    ["power", ["Power", 80]],
    ["team", ["Team", 90]],
]);

export function emptyTestMetadata() {
    return {
        division: null,
        divisionOrder: null,
        format: null,
        formatOrder: null,
    };
}

function fromEntry(kind, entry) {
    if (!entry) return null;
    const [label, order] = entry;
    return kind === "division"
        ? { division: label, divisionOrder: order }
        : { format: label, formatOrder: order };
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

    if (type === "AIME") {
        const format = fromEntry(
            "format",
            AIME_FORMATS.get(label.toUpperCase()),
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

    const amc = titleBase.match(/^AMC\s+(?:10|12)([AB])$/);
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
// axis. The label/order are supplied by the importer's HMMT_ROUNDS map. Returns
// only format fields (no division) so it can be spread alongside the season
// division metadata without clobbering it.
export function hmmtRoundMetadata(label, order) {
    if (!label) return {};
    return { format: label, formatOrder: order };
}

// PUMaC subject (Algebra, Geometry, Combinatorics, Number Theory, Individual
// Finals) is the "which format" axis. The label/order are supplied by the
// importer's PUMAC_SUBJECTS map. Returns only format fields.
export function pumacSubjectMetadata(label, order) {
    if (!label) return {};
    return { format: label, formatOrder: order };
}

// Mandelbrot division: "N"/"R" (individual National/Regional) or "team" (Team
// Play). Returns the full base + division fields; the round is a separate format.
export function mandelbrotDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", MANDELBROT_DIVISIONS.get(token)) ?? {}),
    };
}

// BMT division (main/BMMT/BMMT Online) is the "which division" axis. Returns the
// full base + division fields.
export function bmtDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", BMT_DIVISIONS.get(token?.toLowerCase())) ?? {}),
    };
}

// BMT round/subject is the "which format" axis. Returns only format fields so it
// can be spread alongside the division metadata.
export function bmtFormatMetadata(token) {
    return fromEntry("format", BMT_FORMATS.get(token?.toLowerCase())) ?? {};
}

// SMT division (ASMT/SM3/SMT) is the "which division" axis. Returns the full base
// + division fields.
export function smtDivisionMetadata(token) {
    return {
        ...emptyTestMetadata(),
        ...(fromEntry("division", SMT_DIVISIONS.get(token?.toLowerCase())) ?? {}),
    };
}

// SMT round/subject is the "which format" axis. A "<subject>-tiebreaker" token
// reuses its base subject's label/order with a " Tiebreaker" suffix and a +5
// order bump. Returns only format fields.
export function smtFormatMetadata(token) {
    if (!token) return {};
    const t = token.toLowerCase();
    const isTiebreaker = t.endsWith("-tiebreaker");
    const base = isTiebreaker ? t.slice(0, -"-tiebreaker".length) : t;
    const entry = SMT_FORMATS.get(base);
    if (!entry) return {};
    const [label, order] = entry;
    return isTiebreaker
        ? { format: `${label} Tiebreaker`, formatOrder: order + 5 }
        : { format: label, formatOrder: order };
}
