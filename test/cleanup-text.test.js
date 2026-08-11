import { describe, expect, test } from "bun:test";

import { CleanupText } from "../src/CleanupText.js";
import { WikiSession } from "../src/WikiSession.js";

describe("answer-choice extraction", () => {
    test("consumes isolated wiki math wrappers around choice labels", () => {
        const source = CleanupText.normalizeWikiMath(String.raw`
Question?

<math>\textbf{(A) }</math>The mean increases by <math>1</math> and the median does not change.
<math>\textbf{(B) }</math>The mean increases by <math>1</math> and the median increases by <math>1</math>.
<math>\textbf{(C) }</math>The mean increases by <math>1</math> and the median increases by <math>5</math>.
        `.trim());

        expect(CleanupText.extractChoices(source)).toEqual([
            "The mean increases by $1$ and the median does not change.",
            "The mean increases by $1$ and the median increases by $1$.",
            "The mean increases by $1$ and the median increases by $5$.",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("retains balanced math delimiters inside individual choices", () => {
        const source = String.raw`Question? \textbf{(A)} $2015^{2016}$ \qquad \textbf{(B)} $2016^{2015}$ \qquad \textbf{(C)} $1$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "$2015^{2016}$",
            "$2016^{2015}$",
            "$1$",
        ]);
    });

    test("does not mistake adjacent PDF choice math for a label wrapper", () => {
        const source = String.raw`Which is larger, $2015^{2016}$ or $2016^{2015}$? (A) $2015^{2016}$ (B) $2016^{2015}$ (C) They are equal.`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "$2015^{2016}$",
            "$2016^{2015}$",
            "They are equal.",
        ]);
    });

    test("removes only the unmatched delimiter shared by a choice block", () => {
        const source = String.raw`Question? $\textbf{(A)} 1 \qquad \textbf{(B)} 2 \qquad \textbf{(C)} 3$`;

        expect(CleanupText.extractChoices(source)).toEqual(["1", "2", "3"]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("extracts values that share their text wrapper with the label", () => {
        const source = String.raw`Question? $\text{(A) red}\qquad \text{(B) white}\qquad \text{(C) green}$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "red",
            "white",
            "green",
        ]);
    });

    test("unwraps labels nested inside a surrounding text command", () => {
        const source = String.raw`Question? $\text{\textbf{(A)} red}\qquad \text{\textbf{(B)} white}\qquad \text{\textbf{(C)} green}$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "red",
            "white",
            "green",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("accepts malformed missing-parenthesis labels and removes wrapper braces", () => {
        const source = String.raw`Question? $\textbf{(A)}\ 3\qquad\textbf{(B)}\ 8\qquad\textbf{(C)}\ 13\qquad\textbf{(D}}\ 18\qquad\textbf{(E)}\ 23$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "3",
            "8",
            "13",
            "18",
            "23",
        ]);
    });

    test("removes split bold presentation tags from choice values", () => {
        const source = String.raw`Question? [b]\textbf{(A)}[/b] 80 [b]\textbf{(B)}[/b] 90 [b]\textbf{(C)}[/b] 100`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "80",
            "90",
            "100",
        ]);
    });

    test("preserves complete multiline Asymptote choices", () => {
        const source = String.raw`Question?
\textbf{(A)} [asy=https://example.test/a.png]
draw((0,0)--(1,1));
label("}", (0,0));
[/asy]
\textbf{(B)} [asy=https://example.test/b.png]
draw((0,0)--(2,2));
[/asy]
\textbf{(C)} [asy=https://example.test/c.png]
draw((0,0)--(3,3));
[/asy]`;

        const choices = CleanupText.extractChoices(source);
        expect(choices).toHaveLength(3);
        expect(choices.every((choice) => choice.endsWith("[/asy]"))).toBe(true);
        expect(choices[0]).toContain('label("}", (0,0));');
    });

    test("extracts malformed labels from a display choice table", () => {
        const source = String.raw`Question? \[\begin{array}{rlrlrl}\textbf{(A)}&1&\textbf{(B)}&2&\textbf{(C)}&3&\textbf{(D}}&4&\textbf{(E)}&5\end{array}\]`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "1",
            "2",
            "3",
            "4",
            "5",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("extracts hbox labels and unwraps a multicolumn table cell", () => {
        const source = String.raw`From among the four values, the greatest two are
\[ \begin{array}{rlrlrlrl} \hbox{(A)} & 3^{1/3},\ 2^{1/2} \quad & \hbox{(B)} & 3^{1/3},\ 8^{1/8} \quad & \hbox{(C)} & 3^{1/3},\ 9^{1/9} \quad & \hbox{(D)} & 8^{1/8},\ 9^{1/9} \\ \hbox{(E)} & \multicolumn{3}{l}{\hbox{None of these}} \end{array} \]`;

        expect(CleanupText.extractChoices(source)).toEqual([
            String.raw`3^{1/3},\ 2^{1/2}`,
            String.raw`3^{1/3},\ 8^{1/8}`,
            String.raw`3^{1/3},\ 9^{1/9}`,
            String.raw`8^{1/8},\ 9^{1/9}`,
            "None of these",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe(
            "From among the four values, the greatest two are",
        );
    });

    test("does not treat function arguments as bare answer labels", () => {
        const source = String.raw`For sets $A$, $B$, and $C$, suppose \[n(A) + n(B) + n(C) = n(A\cup B\cup C)\] and find the minimum. \[(A) 96 \quad (B) 97 \quad (C) 98 \quad (D) 99 \quad (E) 100\]`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "96",
            "97",
            "98",
            "99",
            "100",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe(
            String.raw`For sets $A$, $B$, and $C$, suppose \[n(A) + n(B) + n(C) = n(A\cup B\cup C)\] and find the minimum.`,
        );
    });

    test("removes only surplus display closers between choice rows", () => {
        const source = String.raw`Question? \[(A) x \quad (B) 3x \quad (C) \[5x\]\] \[(D) 7x \quad (E) 9x\]`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "x",
            "3x",
            String.raw`\[5x\]`,
            "7x",
            "9x",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("removes only unmatched choice-boundary dollar delimiters", () => {
        const source = String.raw`Question? \textbf{(A)} $ none \qquad \textbf{(B)} \frac{1}{2}$. \qquad \textbf{(C)} $3$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "none",
            "\\frac{1}{2}.",
            "$3$",
        ]);
    });

    test("extracts plain line and compact answer labels", () => {
        const lines = String.raw`Question?
A. $10$
B. $20$
C. $30$
D. $40$
E. $50$`;
        const compact = String.raw`Question? A)$46$ B)$50$ C)$48$ D)$47$ E)$49$`;

        expect(CleanupText.extractChoices(lines)).toEqual([
            "$10$",
            "$20$",
            "$30$",
            "$40$",
            "$50$",
        ]);
        expect(CleanupText.cleanChoices(lines)).toBe("Question?");
        expect(CleanupText.extractChoices(compact)).toEqual([
            "$46$",
            "$50$",
            "$48$",
            "$47$",
            "$49$",
        ]);
    });

    test("does not treat terminal variables inside choice values as labels", () => {
        const source = String.raw`Question? $ \textbf{(A)}\ \frac12(90-A) \qquad \textbf{(B)}\ (C,A,E,D,B) \qquad \textbf{(C)}\ (A,B,C,D,E) \\ [1ex] \textbf{(D)}\ 4 \qquad \textbf{(E)}\ 5$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            String.raw`\frac12(90-A)`,
            "(C,A,E,D,B)",
            "(A,B,C,D,E)",
            "4",
            "5",
        ]);
        expect(CleanupText.cleanChoices(source)).toBe("Question?");
    });

    test("extracts mathbf and malformed text-command labels", () => {
        const mathbf = String.raw`Question? \mathbf{(A)} 6\qquad \mathbf{(B)} 7\qquad \mathbf{(C)} 8\qquad \mathbf{(D)} 9\qquad \mathbf{(E)} 10`;
        const malformed = String.raw`Question? $\text{A) } \frac14 \qquad \text{B) } \frac12 \qquad \text(C)} \frac34 \qquad \text{D) } 1 \qquad \text{E) } 2$`;

        expect(CleanupText.extractChoices(mathbf)).toEqual([
            "6",
            "7",
            "8",
            "9",
            "10",
        ]);
        expect(CleanupText.extractChoices(malformed)).toEqual([
            "\\frac14",
            "\\frac12",
            "\\frac34",
            "1",
            "2",
        ]);
    });

    test("removes boundary-only wiki choice layout residue", () => {
        const source = String.raw`Question? $\textbf{(A)}\text{five minutes}$ <br> $\textbf{(B)}\text{six minutes}$ <br> $\textbf{(C)}\text{seven minutes}$`;
        const malformed = String.raw`Question? \textbf{(A)} -20\qquad\textbf{ \textbf{(B)} -15\qquad\rm{ \textbf{(C)} -10`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "\\text{five minutes}",
            "\\text{six minutes}",
            "\\text{seven minutes}",
        ]);
        expect(CleanupText.extractChoices(malformed)).toEqual([
            "-20",
            "-15",
            "-10",
        ]);
    });

    test("keeps a textual choice that begins on the line after its label", () => {
        const source = String.raw`Question?
$\textbf{(A)} 1\qquad\textbf{(B)} 2\qquad\textbf{(C)}
\frac{5}{2}\qquad\textbf{(D)} 3\qquad\textbf{(E)} 4$`;

        expect(CleanupText.extractChoices(source)).toEqual([
            "1",
            "2",
            String.raw`\frac{5}{2}`,
            "3",
            "4",
        ]);
    });
});

describe("problem cleanup", () => {
    test("removes unexpected C0 control bytes without removing whitespace", () => {
        expect(CleanupText.cleanProblem("A fi\u000Cgure\nwith\ttabs"))
            .toBe("A figure\nwith\ttabs");
    });

    test("removes malformed trailing author and proposer credits", () => {
        expect(
            CleanupText.cleanProblem(
                "Find $x$. [i]Author: Jason Tang[i]",
            ),
        ).toBe("Find $x$.");
        expect(
            CleanupText.cleanProblem(
                "Find $y$. [i]Proposed by [b]AOPS12142015[b][/i]",
            ),
        ).toBe("Find $y$.");
        expect(CleanupText.cleanProblem("Keep [i]this[/i] text.")).toBe(
            "Keep [i]this[/i] text.",
        );
    });

    test("removes an orphan newline fragment after a display table", () => {
        const source = String.raw`Question with table:
$$\begin{tabular}{|c|c|}A&B\\\end{tabular}$$
$\newline`;

        expect(CleanupText.cleanProblem(source)).toBe(String.raw`Question with table:
$$\begin{tabular}{|c|c|}A&B\\\end{tabular}$$`);
    });

    test("classifies known metadata and missing-problem replacement posts", () => {
        expect(
            CleanupText.nonProblemPostDisposition(
                "This test and the matching AMC 12P were developed for the use of a group of Taiwan schools. When Taiwan had taken the contests, the AMC released the questions here as a set of practice questions.",
            ),
        ).toBe("skip");
        expect(
            CleanupText.nonProblemPostDisposition(
                String.raw`Consider $A=\{p,2p,\dots,(q-1)p\}$ and $B=\{q,2q,\dots,(p-1)q\}$. It's easy to see that the sets are disjoint. Hence we get the result.`,
            ),
        ).toBe("reserve");
        expect(CleanupText.nonProblemPostDisposition("Find $x$."))
            .toBeNull();
    });

    test("preserves mixed answer kinds only for AIME practice sets", () => {
        expect(
            CleanupText.preserveMixedPracticeAnswerKinds(
                "2023 AIME Combo Practice Problem Set",
            ),
        ).toBe(true);
        expect(
            CleanupText.preserveMixedPracticeAnswerKinds(
                "2023 AIME-level Number Theory Practice Problem Set",
            ),
        ).toBe(true);
        expect(
            CleanupText.preserveMixedPracticeAnswerKinds("2024 AMC 12A"),
        ).toBe(false);
    });
});

describe("wiki cleanup", () => {
    test("collapses redundant nested display delimiters", () => {
        expect(
            CleanupText.cleanWikiProblem(
                String.raw`Let <cmath>\[x=1\]</cmath>.`,
            ),
        ).toBe("Let $$x=1$$.");
    });

    test("removes a cached orphaned textbf choice prefix", () => {
        expect(
            CleanupText.cleanChoices("Question? $$\\textbf", [
                "1",
                "2",
                "3",
            ]),
        ).toBe("Question?");
    });

    test("removes only exact empty scripts and triple-braced math literals", () => {
        expect(
            CleanupText.normalizeWikiMath(
                String.raw`Let <math>P^{}_{}=m_{}</math>. Choose <math>{{{4015}}}</math>. Keep {{{outside}}}.`,
            ),
        ).toBe("Let $P=m$. Choose $4015$. Keep {{{outside}}}.");
    });

    test("preserves raw wiki Asymptote choices through problem parsing", async () => {
        const raw = String.raw`==Problem==
Which diagram?
$\textbf{(A)}$
<asy>draw((0,0)--(1,0));</asy>
$\textbf{(B)}$
<asy>draw((0,0)--(2,0));</asy>
$\textbf{(C)}$
<asy>draw((0,0)--(3,0));</asy>
==Solution==
The answer is <math>\boxed{A}</math>.`;
        class FixtureWikiSession extends WikiSession {
            async parse(_page, { wikitext = false } = {}) {
                if (wikitext) return raw;
                throw new Error("render unavailable");
            }
        }

        const problem = await new FixtureWikiSession(
            true,
            1,
            "fixture",
        ).getProblemPage("Fixture Problems/Problem 1");

        expect(problem.choices).toEqual([
            "[asy]draw((0,0)--(1,0));[/asy]",
            "[asy]draw((0,0)--(2,0));[/asy]",
            "[asy]draw((0,0)--(3,0));[/asy]",
        ]);
        expect(problem.statement).toBe("Which diagram?");
    });
});
