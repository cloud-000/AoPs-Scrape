export class CLIBar {
    #percent = 0;
    constructor(total, label="Test") {
        this.current = 0;
        this.total = total;
        this.label = label
        this.edges = ["[", "]"]
        this.fill = "\u2588"
        this.unfill = "\u2591"
        this.width = 20;
        this.string = ""
    }
    calculate() {
        this.current = Math.max(0, Math.min(this.total, this.current))
        this.#percent = this.current / this.total;
        const filled = Math.round(this.width * this.#percent);
        this.string = this.fill.repeat(filled) + this.unfill.repeat(this.width - filled);
    }
    render() {
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        process.stdout.write(
            `${this.label} [${this.current} / ${this.total}] (${Math.round(this.#percent * 100)}%) ${this.edges[0]}${this.string}${this.edges[1]}\n`
        );
    }

    ended() {
        return this.current >= this.total;
    }
}

export class CLIBarManager {
    constructor() {
        this.bars = []
        this.started = false;
    }

    addBar(bar) {
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
        return this.bars.every((bar) => bar.ended())
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
}

async function main() {
    let m = new CLIBarManager();
    m.addBar(new CLIBar(200, "Original"));
    m.start();
    for (let i = 1; i < 6; i++) {
        setTimeout(() => {
            m.addBar(new CLIBar(i ** 2 + 5 * i + 30, `Testing ${i}`));
        }, (6 - i) * 670)
    }
    const interval = setInterval(() => {
        m.bars.forEach((bar) => {
            bar.current += Math.round(Math.random() * 5 + 1)
        })
        m.calculate()
        m.render()
        if (m.done()) {
            clearInterval(interval);
            process.stdout.write('\nDone!\n');
        }
    }, 200);
}