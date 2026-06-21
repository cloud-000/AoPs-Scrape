export const TYPES = {
    AMC: { id: 0, computational: true, name: "AMC", choices: true },
    AIME: { id: 1, computational: true, name: "AIME", choices: false },
    AMO: { id: 2, computational: false, name: "OLY", choices: false },
    COLLEGE: { id: 4, computational: true, name: "COLL", choices: false },
    COMPUTE: { id: 97, computational: true, name: "COMP", choices: false },
    ARML: { id: 98, computational: true, name: "ARML", choices: false },
    UNKNOWN: { id: 99, computational: null, name: null, choices: false },
};

export const CONTEST_IDS = {
    IGNORE: [
        4491998, // para made OMMC collection
        4479828,
        3685109, // 2013 USAYNO (NIMO 2-13 Q11)
        2982588, // FMM duplicate
    ],
    MAA: [
        { name: "AMC 8", id: 3413 },
        { name: "AMC 10", id: 3414 },
        { name: "AMC 12", id: 3415 },
        { name: "AIME", id: 3416 },
        {
            name: "USAMTS",
            id: 3412,
            link: "https://www.usamts.org/contest/past-problems/",
        },
    ],
    CollegeComp: [
        {
            name: "CMIMC",
            id: 253928,
            link: "https://cmimc.math.cmu.edu/math/past-problems",
        },
        {
            name: "CHMMC",
            id: 2746308,
            link: "https://www.caltechmathmeet.org/problems",
        },
        {
            name: "HMMT",
            id: 3417,
            link: "https://www.hmmt.org/www/archive/problems",
        },
        {
            name: "HMMT November",
            id: 2881068,
            link: "https://www.hmmt.org/www/archive/problems",
        },
        {
            name: "SMT",
            id: 3418,
            link: "https://www.stanfordmathtournament.org/past-tests/problems",
        },
        { name: "BMT", id: 2503467, link: "https://berkeley.mt/resources/" },
        {
            name: "PUMAC",
            id: 3426,
            link: "https://pumac.princeton.edu/archives",
        },
        {
            name: "BAMO",
            id: 233906,
            link: "https://www.bamo.org/archives/problems_and_solutions/",
        },
        {
            name: "JHMT",
            id: 3347995,
            link: "https://www.johnshopkinsmathtournament.com/past-papers",
        },
    ],
    Other: [
        {
            name: "MPFG",
            id: 3427,
            link: "https://mathprize.atfoundation.org/resources",
        },
        { name: "MPFG Olympiad", id: 953466 },
        {
            name: "Purple Comet",
            id: 3419,
            link: "https://purplecomet.org/answers",
        },
        { name: "OMMC", id: 2824982, link: "https://www.ommcofficial.org/" },
        {
            name: "NIMO",
            id: 3423,
            link: "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link",
        },
        {
            name: "OMO",
            id: 3431,
            link: "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link",
        },
        {
            name: "EMCC",
            id: 4718194,
            link: "https://exetermathclub.com/archives",
        },
        {
            name: "Putnam",
            id: 3249,
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

export const SOLUTION_USERS = [
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
