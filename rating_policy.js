// Rating seed policy for `seed-ratings-export`.
//
// For a series/test matched by a rule, a [lower, upper] rating range is spread
// across that test by problem number `n` along a `linear` or `exp` curve, giving
// each cold problem a difficulty-aware starting prior in place of the flat 1500.
// See src/ratingSeed.js for the matcher + curve, and the handoff in
// tmp/rating-seed-handoff.md for the full contract.
//
// Rule fields (a rule matches a test when EVERY field it specifies matches):
//   series             exact tests' series.name
//   test_type          exact tests.type
//   division           exact tests.division (structural label the importers set,
//                      e.g. "State", "High School" — see testMetadata.js).
//   format             exact tests.format (e.g. "Sprint", "Target", "Team").
//                      division + format together distinguish a level+round.
//   test_name_pattern  case-insensitive substring of tests.name; an ARRAY means
//                      every token must be present (AND). Prefer division/format
//                      over this — it scans the free-text name and is a fallback
//                      for series that carry no structured taxonomy.
//   range              [lower, upper] rating band spread across the test by n.
//   curve              "linear" (default) or "exp" (geometric interpolation).
//   priority           higher wins when multiple rules match (default 0); ties
//                      broken by array order.
//
// Ranges are priors — tune freely.
export const RATING_POLICY = {
    version: 1,
    // Applied to any test that matches no rule. Set to null to skip unmatched
    // tests entirely (they stay at the flat 1500 default).
    fallback: { range: [900, 2100], curve: "linear" },
    rules: [
        { id: "amc-8", series: "AMC 8", range: [700, 1600], curve: "linear" },
        { id: "amc-10", series: "AMC 10", range: [900, 1900], curve: "linear" },
        {
            id: "amc-12",
            series: "AMC 12",
            range: [1000, 2100],
            curve: "linear",
        },
        { id: "aime", series: "AIME", range: [1300, 2300], curve: "linear" },

        // MATHCOUNTS — keyed off the structured division (School/Chapter/State/
        // National) + format (Sprint/Target/Team) columns. Specific (division +
        // format) rules carry higher priority than the bare-format fallbacks so a
        // named level wins; tests whose division didn't resolve fall through to
        // mc-sprint / mc-target / mc-team on format alone.
        {
            id: "mc-chapter-sprint",
            series: "MATHCOUNTS",
            division: "Chapter",
            format: "Sprint",
            range: [650, 1500],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-state-sprint",
            series: "MATHCOUNTS",
            division: "State",
            format: "Sprint",
            range: [850, 1850],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-national-sprint",
            series: "MATHCOUNTS",
            division: "National",
            format: "Sprint",
            range: [1050, 2050],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-chapter-target",
            series: "MATHCOUNTS",
            division: "Chapter",
            format: "Target",
            range: [800, 1700],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-state-target",
            series: "MATHCOUNTS",
            division: "State",
            format: "Target",
            range: [1000, 2000],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-national-target",
            series: "MATHCOUNTS",
            division: "National",
            format: "Target",
            range: [1200, 2200],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-chapter-countdown",
            series: "MATHCOUNTS",
            division: "Chapter",
            format: "Countdown",
            range: [500, 1150],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-state-countdown",
            series: "MATHCOUNTS",
            division: "State",
            format: "Countdown",
            range: [600, 1300],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-national-countdown",
            series: "MATHCOUNTS",
            division: "National",
            format: "Countdown",
            range: [700, 1450],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-school-sprint",
            series: "MATHCOUNTS",
            division: "School",
            format: "Sprint",
            range: [500, 1350],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-school-target",
            series: "MATHCOUNTS",
            division: "School",
            format: "Target",
            range: [650, 1550],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-school-countdown",
            series: "MATHCOUNTS",
            division: "School",
            format: "Countdown",
            range: [400, 1000],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mc-sprint",
            series: "MATHCOUNTS",
            format: "Sprint",
            range: [750, 1750],
            curve: "linear",
            priority: 100,
        },
        {
            id: "mc-target",
            series: "MATHCOUNTS",
            format: "Target",
            range: [900, 1900],
            curve: "linear",
            priority: 100,
        },
        {
            id: "mc-team",
            series: "MATHCOUNTS",
            format: "Team",
            range: [750, 1750],
            curve: "linear",
            priority: 100,
        },
        {
            id: "mc-countdown",
            series: "MATHCOUNTS",
            format: "Countdown",
            range: [550, 1250],
            curve: "linear",
            priority: 100,
        },

        // HMMT (Harvard-MIT Mathematics Tournament)
        // Highly challenging high-school tournament. November is slightly easier
        // than February. HMIC (Invitational) is proof-based/Olympiad level.
        {
            id: "hmmt-hmic",
            series: "HMMT",
            division: "Invitational",
            range: [1800, 2700],
            curve: "linear",
            priority: 200,
        },
        {
            id: "hmmt-february",
            series: "HMMT",
            division: "February",
            range: [1400, 2400],
            curve: "linear",
            priority: 200,
        },
        {
            id: "hmmt-november",
            series: "HMMT November",
            range: [1100, 2100],
            curve: "linear",
            priority: 100,
        },
        {
            id: "hmmt-fallback",
            series: "HMMT",
            range: [1300, 2300],
            curve: "linear",
            priority: 100,
        },

        // CMIMC (Carnegie Mellon Informatics and Mathematics Competition)
        // Challenging high-school tournament. Division 1 is harder than Division 2.
        {
            id: "cmimc-finals",
            series: "CMIMC",
            format: "Finals",
            range: [1600, 2500],
            curve: "linear",
            priority: 250,
        },
        {
            id: "cmimc-div1",
            series: "CMIMC",
            division: "Division 1",
            range: [1400, 2400],
            curve: "linear",
            priority: 200,
        },
        {
            id: "cmimc-div2",
            series: "CMIMC",
            division: "Division 2",
            range: [1100, 2100],
            curve: "linear",
            priority: 200,
        },
        {
            id: "cmimc-individual",
            series: "CMIMC",
            division: "Individual",
            range: [1200, 2200],
            curve: "linear",
            priority: 150,
        },
        {
            id: "cmimc-team",
            series: "CMIMC",
            division: "Team",
            range: [1300, 2300],
            curve: "linear",
            priority: 150,
        },
        {
            id: "cmimc-mini",
            series: "CMIMC",
            division: "Mini-Events",
            range: [1100, 2000],
            curve: "linear",
            priority: 150,
        },
        {
            id: "cmimc",
            series: "CMIMC",
            range: [1200, 2200],
            curve: "linear",
            priority: 100,
        },

        // CHMMC (Caltech Harvey Mudd Math Competition)
        {
            id: "chmmc-proof",
            series: "CHMMC",
            format: "Proof",
            range: [1600, 2500],
            curve: "linear",
            priority: 200,
        },
        {
            id: "chmmc-tiebreaker",
            series: "CHMMC",
            format: "Tiebreaker",
            range: [1500, 2400],
            curve: "linear",
            priority: 200,
        },
        {
            id: "chmmc-ibee-finals",
            series: "CHMMC",
            format: "Integration Bee Finals",
            range: [1300, 2200],
            curve: "linear",
            priority: 200,
        },
        {
            id: "chmmc-ibee-qual",
            series: "CHMMC",
            format: "Integration Bee Qualifying",
            range: [1100, 2000],
            curve: "linear",
            priority: 200,
        },
        {
            id: "chmmc",
            series: "CHMMC",
            range: [1200, 2200],
            curve: "linear",
            priority: 100,
        },

        // BMT (Berkeley Math Tournament) & BMMT (Berkeley Mini Math Tournament)
        // High school tournament is BMT division; middle school is BMMT.
        {
            id: "bmmt",
            series: "BMT",
            division: "BMMT",
            range: [900, 1800],
            curve: "linear",
            priority: 200,
        },
        {
            id: "bmmt-online",
            series: "BMT",
            division: "BMMT Online",
            range: [900, 1800],
            curve: "linear",
            priority: 200,
        },
        {
            id: "bmt-hs",
            series: "BMT",
            division: "BMT",
            range: [1300, 2300],
            curve: "linear",
            priority: 200,
        },
        {
            id: "bmt",
            series: "BMT",
            range: [1200, 2200],
            curve: "linear",
            priority: 100,
        },

        // MPFG (Math Prize for Girls) & MPFG Olympiad
        // Regular contest is computational (AIME level/harder); Olympiad is proof-based.
        {
            id: "mpfg",
            series: "MPFG",
            range: [1300, 2300],
            curve: "linear",
        },
        {
            id: "mpfg-oly",
            series: "MPFG Olympiad",
            range: [1700, 2600],
            curve: "linear",
        },

        // SMT (Stanford Math Tournament)
        // High-school tournament. ASMT is the easier division, SMT is flagship.
        {
            id: "smt-asmt",
            series: "SMT",
            division: "ASMT",
            range: [1000, 2000],
            curve: "linear",
            priority: 200,
        },
        {
            id: "smt-sm3",
            series: "SMT",
            division: "SM3",
            range: [900, 1800],
            curve: "linear",
            priority: 200,
        },
        {
            id: "smt-hs",
            series: "SMT",
            division: "SMT",
            range: [1200, 2200],
            curve: "linear",
            priority: 200,
        },
        {
            id: "smt",
            series: "SMT",
            range: [1100, 2100],
            curve: "linear",
            priority: 100,
        },

        // PUMAC (Princeton University Mathematics Competition)
        // Highly challenging tournament. Division A is harder than Division B.
        // Finals rounds are proof-based/Olympiad style.
        {
            id: "pumac-finals-a",
            series: "PUMAC",
            division: "A",
            format: "Individual Finals",
            range: [1700, 2600],
            curve: "linear",
            priority: 200,
        },
        {
            id: "pumac-finals-b",
            series: "PUMAC",
            division: "B",
            format: "Individual Finals",
            range: [1500, 2450],
            curve: "linear",
            priority: 200,
        },
        {
            id: "pumac-a",
            series: "PUMAC",
            division: "A",
            range: [1500, 2500],
            curve: "linear",
            priority: 100,
        },
        {
            id: "pumac-b",
            series: "PUMAC",
            division: "B",
            range: [1300, 2300],
            curve: "linear",
            priority: 100,
        },
        {
            id: "pumac-team",
            series: "PUMAC",
            division: "Team",
            range: [1400, 2400],
            curve: "linear",
            priority: 100,
        },
        {
            id: "pumac",
            series: "PUMAC",
            range: [1400, 2400],
            curve: "linear",
            priority: 50,
        },

        {
            id: "purple-comet-hs",
            series: "Purple Comet",
            division: "High School",
            range: [1000, 2100],
            curve: "linear",
            priority: 200,
        },
        {
            id: "purple-comet-ms",
            series: "Purple Comet",
            division: "Middle School",
            range: [800, 1800],
            curve: "linear",
            priority: 200,
        },
        {
            id: "purple-comet",
            series: "Purple Comet",
            range: [900, 2000],
            curve: "linear",
        },
        {
            id: "mandelbrot-national",
            series: "Mandelbrot Competition",
            division: "National",
            range: [1200, 2200],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mandelbrot-regional",
            series: "Mandelbrot Competition",
            division: "Regional",
            range: [900, 1800],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mandelbrot-team",
            series: "Mandelbrot Competition",
            division: "Team Play",
            range: [1000, 2000],
            curve: "linear",
            priority: 200,
        },
        {
            id: "mandelbrot",
            series: "Mandelbrot Competition",
            range: [900, 2000],
            curve: "linear",
            priority: 100,
        },
        {
            id: "usamts",
            series: "USAMTS",
            range: [1500, 2400],
            curve: "linear",
        },

        // NIMO (National Internet Math Olympiad)
        // Monthly and Summer contests are computational (AIME to Olympiad-level);
        // Winter Olympiad is proof-based.
        {
            id: "nimo-winter-olympiad",
            series: "NIMO",
            division: "Winter Olympiad",
            range: [1700, 2600],
            curve: "linear",
            priority: 200,
        },
        {
            id: "nimo",
            series: "NIMO",
            range: [1200, 2300],
            curve: "linear",
            priority: 100,
        },
    ],
};
