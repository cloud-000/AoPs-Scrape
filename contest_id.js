export const TYPES = {
    OMMC: {id: -1, computational: true, name: "OMMC", choices: false},
    AMC: {id: 0, computational: true, name: "AMC", choices: true},
    AIME: {id: 1, computational: true, name: "AIME", choices: false},
    AMO: {id: 2, computational: false, name: "US(J)AMO", choices: false},
    HMMT: {id: 4, computational: true, name: "HMMT", choices: false},
    COMPUTE: {id: 97, computational: true, name: "COMPUTE", choices: false},
    ARML: {id: 98, computational: true, name: "ARML", choices: false},
    UNKNOWN: {id: 99, computational: null, name: null}
}

export const CONTEST_IDS = {
    "IGNORE": [
        4491998, // para made OMMC collection
        4479828,
        3685109 // 2013 USAYNO (NIMO 2-13 Q11)
    ],
    "MAA": [
        {
            "name": "AMC 8",
            "id": 3413,
            // starting seeds
            "range": [800, 1100],
            "dist": 1 // distribution x^1 linear
        },
        {
            "name": "AMC 10",
            "id": 3414,
            "range": [950, 1700],
            "dist": 2

        },
        {
            "name": "AMC 12",
            "id": 3415,
            "range": [1050, 1900],
            "dist": 2
        },
        {
            "name": "AIME",
            "id": 3416,
            "range": [1400, 2300],
            "dist": 1
        },
        {
            "name": "USAMTS",
            "id": 3412,
            "link": "https://www.usamts.org/contest/past-problems/"
        }
    ],
    "CollegeComp": [
        {
            "name": "CMIMC",
            "id": 253928,
            "link": "https://cmimc.math.cmu.edu/math/past-problems"
        },
        {
            "name": "CHMMC",
            "id": 2746308,
            "link": "https://www.caltechmathmeet.org/problems"
        },
        {
            "name": "HMMT",
            "id": 3417,
            "link": "https://www.hmmt.org/www/archive/problems"
        },
        {
            "name": "HMMT November",
            "id": 2881068,
            "link": "https://www.hmmt.org/www/archive/problems"
        },
        {
            "name": "SMT",
            "id": 3418,
            "link": "https://www.stanfordmathtournament.org/past-tests/problems"
        },
        {
            "name": "BMT",
            "id": 2503467,
            "link": "https://berkeley.mt/resources/"
        },
        {
            "name": "PUMAC",
            "id": 3426,
            "link": "https://pumac.princeton.edu/archives"
        },
        {
            "name": "BAMO",
            "id": 233906,
            "link": "https://www.bamo.org/archives/problems_and_solutions/"
        },
        {
            "name": "JHMT",
            "id": 3347995,
            "link": "https://www.johnshopkinsmathtournament.com/past-papers"
        }
    ],
    "Other": [
        {
            "name": "MPFG",
            "id": 3427,
            "link": "https://mathprize.atfoundation.org/resources"
        },
        {
            "name": "MPFG Olympiad",
            "id": 953466
        },
        {
            "name": "Purple Comet",
            "id": 3419,
            "link": "https://purplecomet.org/answers"
        },
        {
            "name": "OMMC",
            "id": 2824982,
            "link": "https://www.ommcofficial.org/"
        },
        {
            "name": "NIMO",
            "id": 3423,
            "link": "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link"
        },
        {
            "name": "OMO",
            "id": 3431,
            "link": "https://drive.google.com/drive/folders/1jVXuZMdk-GkucFtqPWAIg5xMiQN-E3gf?usp=drive_link"
        },
        {
            "name": "EMCC",
            "id": 4718194,
            "link": "https://exetermathclub.com/archives"
        }
    ],
    "UserMocks": [
        {
            "type": "collection",
            "name": "AIME mocks",
            "id": 2439872
        },
        {
            "type": "collection",
            "name": "USA Mocks",
            "id": 2439870
        },
        {
            "type": "collection",
            "name": "USA Computational Geo Mocks",
            "id": 3629353
        }
    ],
    "UserContestSeries": [
        // A few worth setting aside from (user mocks), as contest series like CMC
        {
            "type": "collection",
            "name": "CMC",
            "id": 2402371,
            "infer": true
        },
        {
            "type": "collection",
            "name": "OTIS Mock AIME",
            "id": 4180954
        },
        {
            "type": "collection",
            "name": "OTSS",
            "id": 1189415
        },
        {
            "type": "collection",
            "name": "MAC",
            "id": 2442196
        },
        {
            "type": "collection",
            "name": "IMTC",
            "id": 3632745
        },
        {
            "type": "collection",
            "name": "Nanomath",
            "id": 3583112
        },
        {
            "type": "collection",
            "name": "Gaussian Curvature",
            "id": 2442168
        },
        {
            "type": "collection",
            "name": "DMC",
            "id": 2332005
        },
        {
            "name": "ZeMC",
            "link": "https://benny-w.github.io/ZeMC/"
        }
    ],
    "NotMath": [
        {
            "name": "F = MA",
            "id": 3421,
            "link": "https://aapt.org/physicsteam/PT-exams.cfm"
        }
    ],
    "ImportantPosts": [
        "https://artofproblemsolving.com/community/c5h3200761p29225908",
        "https://artofproblemsolving.com/community/c2435719_user_created_contests",
        "https://artofproblemsolving.com/community/c2439875_usa_collaborations_mocks"
    ]
}

// Those who often post solution users
const SOLUTION_USERS = [
    {"id": 672616, "name": "lpieleanu"},
    {"id": 86424, "name": "Mrdavid445"}
]