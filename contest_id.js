// `answerKind` is the name-inferred prior ("mcq" | "numeric" | "proof") used to
// seed a test's format before its problems vote on it (see
// ForumSession._finalizeComputationalAnswers). `computational`/`choices` are the
// legacy derived booleans kept in sync: computational = answerKind !== "proof",
// choices = answerKind === "mcq".
export const TYPES = {
    AMC: {
        id: 0,
        computational: true,
        name: "AMC",
        choices: true,
        answerKind: "mcq",
    },
    AIME: {
        id: 1,
        computational: true,
        name: "AIME",
        choices: false,
        answerKind: "numeric",
    },
    AMO: {
        id: 2,
        computational: false,
        name: "OLY",
        choices: false,
        answerKind: "proof",
    },
    COLLEGE: {
        id: 4,
        computational: true,
        name: "COLL",
        choices: false,
        answerKind: "numeric",
    },
    COMPUTE: {
        id: 97,
        computational: true,
        name: "COMP",
        choices: false,
        answerKind: "numeric",
    },
    ARML: {
        id: 98,
        computational: true,
        name: "ARML",
        choices: false,
        answerKind: "numeric",
    },
    UNKNOWN: {
        id: 99,
        computational: null,
        name: null,
        choices: false,
        answerKind: null,
    },
};

export const CONTEST_IDS = {
    IGNORE: [
        4491998, // para made OMMC collection
        4479828,
        3685109, // 2013 USAYNO (NIMO 2-13 Q11)
        2982588, // FMM duplicate
    ],
    // As of the current time, AMC 10/12 2026 has not occurred, (they occur later in the year)
    // AIME and AMC 8 has already been released however, so 2026 exists for them.
    MAA: [
        {
            name: "AMC 8",
            id: 3413,
            is_official: true,
            wiki: {
                variants: [
                    // The AMC 8 was the AJHSME until 1999 — the same rename
                    // story as AHSME → AMC 12 below, and it needs the same
                    // `testName`. The wiki publishes those years as
                    // "1985 AJHSME Problems"; the forum (and so the DB) stores
                    // them as "1985 AMC 8". Without this variant the pre-1999
                    // years get no wiki data at all: no answer key, and no wiki
                    // solutions — which left the forum's chatter replies as the
                    // only "solutions" those problems had.
                    { name: "AJHSME", years: [1985, 1998], testName: "AMC 8" },
                    { name: "AMC 8", years: [1999, 2026] },
                ],
                years: [1985, 2026],
            },
        },
        {
            name: "AMC 10",
            id: 3414,
            is_official: true,
            wiki: {
                variants: [
                    // The A/B split began in 2002. Before that the AMC 10 was a
                    // single administration published under an unsuffixed title,
                    // so these must NOT inherit the contest-level range — every
                    // "2000 AMC 10A Problems/Problem k" request can only 404.
                    { name: "AMC 10A", years: [2002, 2025] },
                    { name: "AMC 10B", years: [2002, 2025] },
                    // 2021 ran a second, full administration in the fall, which
                    // the wiki publishes as its own page family ("2021 Fall AMC
                    // 10B Problems/Problem 2"). Without these the fall tests get
                    // AoPS statements with no wiki choices or answer key.
                    { name: "Fall AMC 10A", years: [2021, 2021] },
                    { name: "Fall AMC 10B", years: [2021, 2021] },
                    // 2002 had a third "P" (practice) administration.
                    { name: "AMC 10P", years: [2002, 2002] },
                    // Pre-split years: one test per year, no A/B suffix.
                    { name: "AMC 10", years: [2000, 2001] },
                ],
                years: [2000, 2025],
            },
        },
        {
            name: "AMC 12",
            id: 3415,
            is_official: true,
            wiki: {
                variants: [
                    // The AMC 12 was the AHSME until 2000. The wiki publishes
                    // those years under the old name ("1950 AHSME Problems"),
                    // but the forum — and so the DB — stores them as
                    // "1950 AMC 12", hence `testName`. Without it the rows never
                    // merge onto the forum's, and `inferType("1950 AHSME")`
                    // returns null, scraping an MCQ contest as an untyped one.
                    { name: "AHSME", years: [1950, 1999], testName: "AMC 12" },
                    // See the AMC 10 note above: the A/B split began in 2002, so
                    // these carry their own start year rather than inheriting
                    // the contest-level range down into the unsuffixed era.
                    { name: "AMC 12A", years: [2002, 2025] },
                    { name: "AMC 12B", years: [2002, 2025] },
                    // 2021's fall administration and 2002's "P" are separate
                    // wiki page families.
                    { name: "Fall AMC 12A", years: [2021, 2021] },
                    { name: "Fall AMC 12B", years: [2021, 2021] },
                    { name: "AMC 12P", years: [2002, 2002] },
                    { name: "AMC 12", years: [2000, 2001] },
                ],
                years: [1950, 2025],
            },
        },
        {
            name: "AIME",
            id: 3416,
            is_official: true,
            wiki: {
                variants: [
                    // The I/II split began in 2000. Before that there was one
                    // AIME a year, published and stored unsuffixed, so the
                    // suffixed variants must not inherit the contest-level
                    // range: "1987 AIME I Problems/Problem 1" is a 404, and
                    // storing the year under "1987 AIME I" forks a second test
                    // that never merges onto the forum's "1987 AIME".
                    // WikiSession.getContest still remaps a pre-2000 "AIME I"
                    // defensively, for a hand-typed single-year run.
                    { name: "AIME", years: [1983, 1999] },
                    { name: "AIME I", years: [2000, 2026] },
                    { name: "AIME II", years: [2000, 2026] },
                ],
                years: [1983, 2026],
            },
        },
        {
            name: "USAMTS",
            id: 3412,
            is_official: true,
            link: "https://www.usamts.org/contest/past-problems/",
        },
    ],
    CollegeComp: [
        {
            name: "CMIMC",
            id: 253928,
            is_official: true,
            link: "https://cmimc.math.cmu.edu/math/past-problems",
        },
        {
            name: "CHMMC",
            id: 2746308,
            is_official: true,
            link: "https://www.caltechmathmeet.org/problems",
        },
        {
            name: "HMMT",
            id: 3417,
            is_official: true,
            link: "https://www.hmmt.org/www/archive/problems",
        },
        {
            name: "HMMT November",
            id: 2881068,
            is_official: true,
            link: "https://www.hmmt.org/www/archive/problems",
        },
        {
            name: "SMT",
            id: 3418,
            is_official: true,
            link: "https://www.stanfordmathtournament.org/past-tests/problems",
        },
        {
            name: "BMT",
            id: 2503467,
            is_official: true,
            link: "https://berkeley.mt/resources/",
        },
        {
            name: "PUMAC",
            id: 3426,
            is_official: true,
            link: "https://pumac.princeton.edu/archives",
        },
        {
            name: "BAMO",
            id: 233906,
            is_official: true,
            link: "https://www.bamo.org/archives/problems_and_solutions/",
        },
        {
            name: "JHMT",
            id: 3347995,
            is_official: true,
            link: "https://www.johnshopkinsmathtournament.com/past-papers",
        },
    ],
    Other: [
        {
            name: "MPFG",
            id: 3427,
            is_official: true,
            link: "https://mathprize.atfoundation.org/resources",
        },
        { name: "MPFG Olympiad", id: 953466, is_official: true },
        {
            name: "Purple Comet",
            id: 3419,
            is_official: true,
            link: "https://purplecomet.org/answers",
        },
        {
            name: "OMMC",
            id: 2824982,
            is_official: true,
            link: "https://www.ommcofficial.org/",
        },
        {
            name: "NIMO",
            id: 3423,
            is_official: true,
            link: "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link",
        },
        {
            name: "OMO",
            id: 3431,
            is_official: true,
            link: "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link",
        },
        {
            name: "EMCC",
            id: 4718194,
            is_official: true,
            link: "https://exetermathclub.com/archives",
        },
        {
            name: "Putnam",
            id: 3249,
            is_official: true,
            link: "https://kskedlaya.org/putnam-archive/",
        },
        { name: "mathleague.org", id: 134, type: "forum", rules: {} },
    ],
    UserMocks: [
        { type: "collection", name: "AIME mocks", id: 2439872 },
        { type: "collection", name: "USA Mocks", id: 2439870 },
        {
            type: "collection",
            name: "USA Computational Geo Mocks",
            id: 3629353,
        },
    ],
    UserContestSeries: [
        { type: "collection", name: "CMC", id: 2402371, infer: true },
        { type: "collection", name: "OTIS Mock AIME", id: 4180954 },
        { type: "collection", name: "OTSS", id: 1189415 },
        { type: "collection", name: "MAC", id: 2442196 },
        { type: "collection", name: "IMTC", id: 3632745 },
        { type: "collection", name: "Nanomath", id: 3583112 },
        { type: "collection", name: "Gaussian Curvature", id: 2442168 },
        { type: "collection", name: "DMC", id: 2332005 },
        {
            name: "ZeMC",
            ids: [2505703, 3211241, 3623297],
            link: "https://benny-w.github.io/ZeMC/",
        },
        {
            name: "Solstice Math Olympiads (SSMO)",
            id: 3072130,
            type: "forum",
            rules: {
                names: [
                    {
                        regex: /^(W|S)?SMO (\d{4}) Relay Round (\d+) (?:Problem|Question) (\d+)/,
                        metadata: (matches) => ({
                            year: matches[2],
                            name: `${matches[1]}SMO ${matches[2]} Relay ${matches[3]}`,
                            n: matches[4],
                        }),
                    },
                    {
                        regex: /^(W|S)?SMO\s+(\d{4})\s*([^\s]+)\s*(?:Round)?\s+Problem\s*(\d+)/,
                        metadata: (matches) => ({
                            year: matches[2],
                            name: `${matches[1]}SMO ${matches[2]} ${matches[3]}`,
                            n: matches[4],
                        }),
                    },
                ],
                posters: ["SMO_Team", "mudkip42"],
            },
        },
        { name: "2025 DISCUS AMC", id: 4624886, type: "forum" },
        { type: "collection", name: "CNCM", id: 1282021 },
    ],
};

// Users known to post high-quality solutions; used to classify solution posts during scraping.
export const SOLUTIONS_USERS = [
    { id: 672616, name: "lpieleanu" },
    { id: 86424, name: "Mrdavid445" },
    { id: 560465, name: "HamstPan38825" },
    { id: 53544, name: "v_Enhance" },
    { id: 102024, name: "djmathman" },
    { id: 20689, name: "BOGTRO" },
    { id: 280335, name: "GammaZero" },
    { id: 448942, name: "IAmTheHazard" },
    { id: 529392, name: "peace09" },
];

/** @deprecated use SOLUTIONS_USERS */
export const SOLUTION_USERS = SOLUTIONS_USERS;
