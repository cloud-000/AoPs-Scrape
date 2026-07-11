const MATHCOUNTS_DIVISIONS = new Map([
    ["school", ["School", 10]],
    ["chapter", ["Chapter", 20]],
    ["state", ["State", 30]],
    ["national", ["National", 40]],
]);

const MATHCOUNTS_FORMATS = new Map([
    ["sprint", ["Sprint", 10]],
    ["target", ["Target", 20]],
    ["team", ["Team", 30]],
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
