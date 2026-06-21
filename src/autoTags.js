export const AUTO_TAGS = [
    { tag: "probability",         match: /\bprobabilit/i },
    { tag: "expected value",      match: /\bexpected\s+value\b/i },
    { tag: "AM-GM",               match: /\bam-gm\b|\bAM-GM\b/i },
    { tag: "Cauchy-Schwarz",      match: /cauchy.schwarz/i },
    { tag: "modular arithmetic",  match: /\bmod\b|\bmodulo\b|\bcongruent\b.*\bmod\b/i },
    { tag: "pigeonhole",          match: /\bpigeonhole\b/i },
    { tag: "induction",           match: /\binduction\b/i },
    { tag: "recursion",           match: /\brecursion\b|\brecurrence\b/i },
    { tag: "combinatorics",       match: /\bchoose\b|\bbinom\b|\bC\(\d/i },
    { tag: "inequalities",        match: /\binequality\b|\binequalities\b/i },
    { tag: "polynomial",          match: /\bpolynomial\b/i },
    { tag: "sequence",            match: /\bsequence\b|\bseries\b/i },
    { tag: "prime",               match: /\bprime\b|\bprimes\b/i },
    { tag: "divisibility",        match: /\bdivisib/i },
    { tag: "floor/ceiling",       match: /\\lfloor|\\lceil|\bfloor\b|\bceiling\b/i },
    { tag: "trigonometry",        match: /\\sin\b|\\cos\b|\\tan\b|\bsine\b|\bcosine\b|\btangent\b/i },
    { tag: "complex numbers",     match: /\bcomplex\b.*\bnumber\b|\\mathbb\{C\}/i },
    { tag: "graph theory",        match: /\bgraph\b.*\bvertex\b|\bgraph\b.*\bedge\b/i },
    { tag: "geometry",            match: /\bcircumradius\b|\bincircle\b|\bcircumcircle\b/i },
    { tag: "relay",               match: /\brelay\b|\bTNYWR\b/i },
]

/**
 * Returns a list of tags that match the given problem statement.
 * @param {string} statement
 * @returns {string[]}
 */
export function getAutoTags(statement) {
    const tags = []
    for (const { tag, match } of AUTO_TAGS) {
        if (typeof match === 'string' ? statement.includes(match) : match.test(statement)) {
            tags.push(tag)
        }
    }
    return tags
}
