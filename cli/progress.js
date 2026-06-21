class CLIElement {
    done() { return true; }
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
        this.fill = "█";
        this.unfill = "░";
        this.width = 20;
        this.string = "";
    }

    calculate() {
        this.count = Math.max(0, Math.min(this.total, this.count));
        this.#percent = this.count / this.total;
        const filled = Math.round(this.width * this.#percent);
        this.string = this.fill.repeat(filled) + this.unfill.repeat(this.width - filled);
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
        this.bars.forEach((bar) => bar.calculate());
    }

    render() {
        process.stdout.moveCursor(0, -this.bars.length);
        this.bars.forEach((bar) => bar.render());
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
        return false;
    }

    render() {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`${this.label} ${this.count}\n`);
    }
}
