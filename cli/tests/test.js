import { ForumSession } from "../../src/ForumSession.js";

class CLIElement {
    constructor() {}
    done() {
        return true;
    }
    render() {}
    calculate() {}
}

export class CLIBar extends CLIElement {
    #percent = 0;
    constructor(total, label = "Test") {
        super();
        this.count = 0;
        this.total = total;
        this.label = label;
        this.edges = ["[", "]"];
        this.fill = "\u2588";
        this.unfill = "\u2591";
        this.width = 20;
        this.string = "";
    }
    calculate() {
        this.count = Math.max(0, Math.min(this.total, this.count));
        this.#percent = this.count / this.total;
        const filled = Math.round(this.width * this.#percent);
        this.string =
            this.fill.repeat(filled) + this.unfill.repeat(this.width - filled);
    }
    render() {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(
            `${this.label} [${this.count} / ${this.total}] (${Math.round(this.#percent * 100)}%) ${this.edges[0]}${this.string}${this.edges[1]}\n`,
        );
    }

    done() {
        return this.count >= this.total;
    }
}

export class CLIBarManager extends CLIElement {
    constructor() {
        super();
        this.bars = [];
        this.started = false;
    }

    add(bar) {
        this.bars.push(bar);
        if (this.started) {
            console.log("");
        }
    }

    start() {
        console.log("\n".repeat(this.bars.length));
        this.started = true;
    }

    done() {
        return this.bars.every((bar) => bar.done());
    }

    calculate() {
        this.bars.forEach((bar) => {
            bar.calculate();
        });
    }

    render() {
        process.stdout.moveCursor(0, -this.bars.length);
        this.bars.forEach((bar) => {
            bar.render();
        });
    }

    clear() {
        process.stdout.moveCursor(0, -this.bars.length);
        process.stdout.clearLine(0);
    }
}

export class CLICount extends CLIElement {
    constructor(label = "Label: ") {
        super();
        this.label = label;
        this.count = 0;
    }

    done() {
        return this.count >= 20;
    }

    render() {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`${this.label} ${this.count}\n`);
    }
}

async function main() {
    let m = new CLIBarManager();
    console.log("TEEEEST");
    m.add(new CLICount());
    m.start();
    /*m.add(new CLIBar(50, "Original"));
    m.start();
    for (let i = 1; i < 3; i++) {
        setTimeout(() => {
            m.add(new CLIBar(i ** 2 + 5 * i + 30, `Testing ${i}`));
            m.add(new CLICount(`The big ${i}: `))
        }, (6 - i) * 300)
    }*/
    const interval = setInterval(() => {
        m.bars.forEach((bar) => {
            bar.count += Math.round(Math.random() * 5 + 1);
        });
        m.calculate();
        m.render();
        if (m.done()) {
            clearInterval(interval);
            m.clear();
            setTimeout(() => {
                process.stdout.write("Done!");
                setTimeout(() => {}, 1000);
            }, 500);
        }
    }, 200);
}

import { CleanupText } from "../../src/CleanupText.js";
import { ENV } from "../../.env.js";

try {
    // let text = "In square $ABCD$ with side length $2$, let $\\omega_1$ be a circle with its center at $A$ and radius $AB$. Let $\\omega_2$ be a circle with its center at $D$ and with radius $DC$. There exists a circle with radius $r$ that is externally tangent to both $\\omega_1$ and $\\omega_2$ and tangent to $BC$. What is $r$?\n\n[asy=https://latex.artofproblemsolving.com/2/0/1/201135c32840f1b1221c711b3a465376bed55d63.png]\nsize(4cm);\ndraw(scale(.5)*((-1,-1)--(1,-1)--(1,1)--(-1,1)--cycle));\npath p = arc((-.5,-.5),1,0,90);\npath q = arc((.5,-.5),-1,0,-90);\ndraw(p);\ndraw(q);\ndraw(circle((0,0.4375),0.0625));\n[/asy]\n\n$\\textbf {(A) } \\frac{1}{8} \\qquad \\textbf {(B) } \\frac{1}{7} \\qquad \\textbf {(C) } \\frac{1}{6} \\qquad \\textbf {(D) } \\frac{1}{5} \\qquad \\textbf {(E) } \\frac{1}{4}"
    // console.log(CleanupText.extractChoices(text))
    /*let text = `
Given that $mx + k = 9$ and $(m+k)x = 15$ for positive integers $m$, $k$ and $x$, find $kx + m$.\n\n$\\textbf{(A) }8\\qquad\\textbf{(B) }9\\qquad\\textbf{(C) }10\\qquad\\textbf{(D) }11\\qquad\\textbf{(E) }12$
    `
    console.log(CleanupText.cleanProblem(text))
    console.log("#".repeat(10))
    console.log(CleanupText.extractChoices(text))
    console.log("#".repeat(10))
    console.log(CleanupText.cleanChoices(text))*/
    // const data = await Bun.file("raw.json").json()
    // let user = ENV["AoPs-User"]["clod"]
    // let f = new ForumSession(
    //     user["logged-in"],
    //     user["user-id"],
    //     user["session-id"],
    //     user["headers"] || null
    // )
    // f.debug = false
    // console.log(await CleanupText.parseForum(jsonData, {}, f, null))
    // console.log(CleanupText.parseForum(data, [
    //     {
    //         regex: /\(ZeMC \d+ P\d+\)$/,
    //         matches: [1],
    //         name: (matches, year) => {
    //             return `${year} ZeMC 10`
    //         }
    //     },
    //     {
    //         regex: /^\(ZIME P(\d+)\)$/,
    //         matches: [1],
    //         name: (matches, year) => {
    //             return `${year} ZIME`
    //         }
    //     }
    // ]))
} catch (e) {
    console.error(e);
}
