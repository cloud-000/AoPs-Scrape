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
//   test_name_pattern  case-insensitive substring of tests.name; an ARRAY means
//                      every token must be present (AND) — this is how a level +
//                      round like ["State", "Sprint"] is distinguished.
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
      { id: "aime", series: "AIME", range: [1300, 2300], curve: "linear" },

      // MATHCOUNTS — detect level (Chapter/State/National) + round
      // (Sprint/Target). Specific (level+round) rules carry higher priority
      // than the bare-round fallbacks so a named level wins; unrecognized
      // levels fall through to mc-sprint / mc-target.
      {
         id: "mc-chapter-sprint",
         series: "MATHCOUNTS",
         test_name_pattern: ["Chapter", "Sprint"],
         range: [650, 1500],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-state-sprint",
         series: "MATHCOUNTS",
         test_name_pattern: ["State", "Sprint"],
         range: [850, 1850],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-national-sprint",
         series: "MATHCOUNTS",
         test_name_pattern: ["National", "Sprint"],
         range: [1050, 2050],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-chapter-target",
         series: "MATHCOUNTS",
         test_name_pattern: ["Chapter", "Target"],
         range: [800, 1700],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-state-target",
         series: "MATHCOUNTS",
         test_name_pattern: ["State", "Target"],
         range: [1000, 2000],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-national-target",
         series: "MATHCOUNTS",
         test_name_pattern: ["National", "Target"],
         range: [1200, 2200],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-school-sprint",
         series: "MATHCOUNTS",
         test_name_pattern: ["School", "Sprint"],
         range: [500, 1350],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-school-target",
         series: "MATHCOUNTS",
         test_name_pattern: ["School", "Target"],
         range: [650, 1550],
         curve: "linear",
         priority: 200,
      },
      {
         id: "mc-sprint",
         series: "MATHCOUNTS",
         test_name_pattern: "Sprint",
         range: [750, 1750],
         curve: "linear",
         priority: 100,
      },
      {
         id: "mc-target",
         series: "MATHCOUNTS",
         test_name_pattern: "Target",
         range: [900, 1900],
         curve: "linear",
         priority: 100,
      },
      {
         id: "mc-team",
         series: "MATHCOUNTS",
         test_name_pattern: "Team",
         range: [750, 1750],
         curve: "linear",
         priority: 100,
      },

      {
         id: "purple-comet-hs",
         series: "Purple Comet",
         test_name_pattern: "High School",
         range: [1000, 2100],
         curve: "linear",
         priority: 200,
      },
      {
         id: "purple-comet-ms",
         series: "Purple Comet",
         test_name_pattern: "Middle School",
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
         id: "mandelbrot",
         series: "Mandelbrot Competition",
         range: [900, 2000],
         curve: "linear",
      },
      { id: "usamts", series: "USAMTS", range: [1500, 2400], curve: "linear" },
   ],
};
