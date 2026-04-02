class CLIElement {
    constructor() {}
    done() {return true}
    render() {}
    calculate() {}
}

export class CLIBar extends CLIElement  {
    #percent = 0;
    constructor(total, label="Test") {
        super();
        this.count = 0;
        this.total = total;
        this.label = label
        this.edges = ["[", "]"]
        this.fill = "\u2588"
        this.unfill = "\u2591"
        this.width = 20;
        this.string = ""
    }
    calculate() {
        this.count = Math.max(0, Math.min(this.total, this.count))
        this.#percent = this.count / this.total;
        const filled = Math.round(this.width * this.#percent);
        this.string = this.fill.repeat(filled) + this.unfill.repeat(this.width - filled);
    }
    render() {
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        process.stdout.write(
            `${this.label} [${this.count} / ${this.total}] (${Math.round(this.#percent * 100)}%) ${this.edges[0]}${this.string}${this.edges[1]}\n`
        );
    }

    done() {
        return this.count >= this.total;
    }
}

export class CLIBarManager extends CLIElement {
    constructor() {
        super()
        this.bars = []
        this.started = false;
    }

    add(bar) {
        this.bars.push(bar);
        if (this.started) {
            console.log("")
        }
    }

    start() {
        console.log("\n".repeat(this.bars.length))
        this.started = true;
    }

    done() {
        return this.bars.every((bar) => bar.done())
    }

    calculate() {
        this.bars.forEach((bar) => {
            bar.calculate();
        })
    }

    render() {
        process.stdout.moveCursor(0, -this.bars.length);
        this.bars.forEach((bar) => {
            bar.render()
        })
    }

    clear() {
        process.stdout.moveCursor(0, -this.bars.length);
        process.stdout.clearLine(0);
    }
}

export class CLICount extends CLIElement {
    constructor(label="Label: ") {
        super()
        this.label = label;
        this.count = 0;
    }

    done() {
        return this.count >= 20;
    }

    render() {
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        process.stdout.write(`${this.label} ${this.count}\n`);
    }
}

async function main() {
    let m = new CLIBarManager();
    console.log("TEEEEST")
    m.add(new CLICount())
    m.start()
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
            bar.count += Math.round(Math.random() * 5 + 1)
        })
        m.calculate()
        m.render()
        if (m.done()) {
            clearInterval(interval);
            m.clear()
            setTimeout(() => {
                process.stdout.write('Done!');
                setTimeout(() => {}, 1000);
            }, 500)
        }
    }, 200);
}

/*import {CleanupText} from "../../src/CleanupText.js";
import { promises as fs } from 'node:fs';

try {
    const data = await fs.readFile("raw.json")
    const jsonData = JSON.parse(data)
    console.log(CleanupText.parseForum(data, [
        {
            regex: /\(ZeMC \d+ P\d+\)$/,
            matches: [1],
            name: (matches, year) => {
                return `${year} ZeMC 10`
            }
        },
        {
            regex: /^\(ZIME P(\d+)\)$/,
            matches: [1],
            name: (matches, year) => {
                return `${year} ZIME`
            }
        }
    ]))
} catch (e) {
    console.error(e)
}*/