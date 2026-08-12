import { format } from "node:util";

/**
 * A live, multi-line status region for the terminal.
 *
 * The region owns a fixed block of lines at the bottom of the screen and
 * repaints them on an interval. The important property is that it is the *only*
 * thing that writes to those lines: any diagnostic output must go through
 * `region.log()`, which erases the region, writes the message into the normal
 * scrollback above it, and repaints. A bare `console.log` during a live region
 * is destroyed by the next repaint (the repaint walks the cursor up over it and
 * clears the line), which is why scrape warnings used to vanish.
 *
 * Everything degrades safely when stdout is not a TTY (piped output, CI): the
 * region never paints and `log()` falls through to `console.log`, so a redirected
 * run produces a plain readable transcript instead of cursor-control garbage.
 */

const DEFAULT_INTERVAL_MS = 300;
const SEP = "  ·  ";

/** Formats a millisecond duration as a compact human string ("7m12s", "840ms"). */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    if (m < 60) return `${m}m${String(rem).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m - h * 60).padStart(2, "0")}m`;
}

/** Thousands-separated integer, so a five-digit problem count stays readable. */
export function formatCount(n) {
    return Number(n ?? 0).toLocaleString("en-US");
}

/**
 * Line bodies may be a string or a zero-arg function. The function form is
 * evaluated at paint time, which is what lets a line show something that
 * changes without an event to drive it — an idle timer ticking up while a
 * request hangs, for instance.
 */
const resolve = (value) => (typeof value === "function" ? value() : (value ?? ""));

/**
 * Base class for one rendered line. `render()` returns plain text — the region
 * truncates it to the terminal width, so lines must not emit ANSI escapes
 * (their invisible bytes would break the width math and wrap the line, which in
 * turn desyncs the region's erase accounting).
 */
class StatusLine {
    constructor(label = "") {
        this.label = label;
    }

    render() {
        return this.label;
    }
}

/**
 * A monotonically increasing count, optionally out of a known total, with a
 * free-form `detail` suffix for context ("2001 AMC 10A · problem 12/25").
 */
export class CounterLine extends StatusLine {
    constructor(label, { total = null } = {}) {
        super(label);
        this.count = 0;
        this.total = total;
        this.detail = "";
    }

    increment(by = 1) {
        this.count += by;
        return this.count;
    }

    render() {
        const value =
            this.total != null
                ? `${formatCount(this.count)} / ${formatCount(this.total)}`
                : formatCount(this.count);
        const parts = [`${this.label} ${value}`];
        const detail = resolve(this.detail);
        if (detail) parts.push(detail);
        return parts.join(SEP);
    }
}

/** A line whose whole body is set imperatively — current activity, warnings. */
export class TextLine extends StatusLine {
    constructor(label = "") {
        super(label);
        this.value = "";
    }

    set(value) {
        this.value = value ?? "";
        return this;
    }

    render() {
        const value = resolve(this.value);
        if (!value) return this.label;
        return this.label ? `${this.label} ${value}` : value;
    }
}

/** A classic filled progress bar, for work with a known denominator. */
export class BarLine extends StatusLine {
    constructor(label, total) {
        super(label);
        this.count = 0;
        this.total = Math.max(1, total);
        this.width = 20;
        this.fill = "█";
        this.unfill = "░";
    }

    increment(by = 1) {
        this.count += by;
        return this.count;
    }

    render() {
        const count = Math.max(0, Math.min(this.total, this.count));
        const percent = count / this.total;
        const filled = Math.round(this.width * percent);
        const bar =
            this.fill.repeat(filled) + this.unfill.repeat(this.width - filled);
        return `${this.label} [${formatCount(count)} / ${formatCount(this.total)}] (${Math.round(percent * 100)}%) [${bar}]`;
    }
}

export class StatusRegion {
    #lines = [];
    #timer = null;
    #painted = 0;

    constructor({
        stream = process.stdout,
        intervalMs = DEFAULT_INTERVAL_MS,
        enabled = null,
    } = {}) {
        this.stream = stream;
        this.intervalMs = intervalMs;
        // An explicit `enabled` can force the region off (--no-counter), but it
        // can never force it on over a stream that cannot move the cursor — a
        // pipe has no moveCursor/clearLine, and calling them would throw
        // mid-scrape rather than merely rendering badly.
        const requested = enabled ?? Boolean(stream.isTTY);
        this.enabled =
            requested &&
            typeof stream.moveCursor === "function" &&
            typeof stream.clearLine === "function";
    }

    add(line) {
        this.#lines.push(line);
        if (this.#timer) this.#repaint();
        return line;
    }

    counter(label, options) {
        return this.add(new CounterLine(label, options));
    }

    text(label = "") {
        return this.add(new TextLine(label));
    }

    bar(label, total) {
        return this.add(new BarLine(label, total));
    }

    start() {
        if (!this.enabled || this.#timer) return this;
        this.#paint();
        this.#timer = setInterval(() => this.#repaint(), this.intervalMs);
        // Never let the repaint timer alone hold the process open.
        this.#timer.unref?.();
        return this;
    }

    /**
     * Stops repainting. `clear` (the default) erases the region entirely, so the
     * final summary the caller prints is not preceded by a stale progress line;
     * pass `false` to leave the last frame on screen.
     */
    stop({ clear = true } = {}) {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
        if (!this.enabled) return this;
        if (clear) this.#erase();
        else this.#repaint();
        return this;
    }

    /** Writes to the scrollback above the region, then repaints it. */
    log(...args) {
        const message = format(...args);
        if (!this.enabled || this.#painted === 0) {
            console.log(message);
            return;
        }
        this.#erase();
        this.stream.write(`${message}\n`);
        this.#paint();
    }

    get active() {
        return this.#timer != null;
    }

    #erase() {
        for (let i = 0; i < this.#painted; i++) {
            this.stream.moveCursor(0, -1);
            this.stream.clearLine(0);
        }
        this.stream.cursorTo(0);
        this.#painted = 0;
    }

    #paint() {
        // Leave a column of slack: a line that exactly fills the terminal wraps
        // on some emulators, which would make the erase walk up too few rows.
        // `||` not `??` — a pty with no size reports 0 columns, not undefined.
        const width = Math.max(20, (this.stream.columns || 80) - 1);
        for (const line of this.#lines) {
            const text = line.render();
            const clipped =
                text.length > width ? `${text.slice(0, width - 1)}…` : text;
            this.stream.write(`${clipped}\n`);
        }
        this.#painted = this.#lines.length;
    }

    #repaint() {
        this.#erase();
        this.#paint();
    }
}

// A request quiet for this long is worth surfacing: the politeness delay is
// ~250ms, so seconds of silence means the far side is slow, not that we are idle.
const STALL_MS = 4000;
// Above this mean latency AoPS is throttling us rather than merely being remote.
const THROTTLE_MS = 1500;

/**
 * The scrape/wiki commands' progress presenter.
 *
 * Binds a session's `onProblemAdd` / `onEvent` / `logger` to a two-line status
 * region, so a run always answers three questions that the old bare counter
 * could not: what is it working on, is it moving, and is the time going into the
 * network or into our own parsing. A run that collects nothing for minutes (a
 * year sweep over pages that can only 404) now reads as steady request traffic
 * against a stalled problem count, instead of as a hang.
 *
 * `attach()` may be called for either session class — both expose the same
 * `logger`/`onEvent`/`stats` surface.
 */
export function createScrapeProgress({
    enabled = null,
    verbose = false,
    label = "Problems collected:",
} = {}) {
    const region = new StatusRegion({ enabled });
    const counter = region.counter(label);
    const activity = region.text();
    const sessions = [];
    let lastEventAt = Date.now();
    let currentPage = "";
    let currentTest = "";

    // Summed across every attached session so the numbers stay right if a
    // command ever drives more than one.
    const totals = () =>
        sessions.reduce(
            (acc, s) => {
                for (const key of Object.keys(acc)) acc[key] += s.stats[key] ?? 0;
                return acc;
            },
            {
                requests: 0,
                cacheHits: 0,
                networkRequests: 0,
                networkMs: 0,
                missing: 0,
                retries: 0,
                challenges: 0,
            },
        );

    counter.detail = () => {
        const t = totals();
        if (t.requests === 0) return "";
        const parts = [
            `${formatCount(t.requests)} requests (${formatCount(t.cacheHits)} cached · ${formatCount(t.networkRequests)} net)`,
        ];
        if (t.networkRequests > 0) {
            parts.push(
                `${formatDuration(t.networkMs / t.networkRequests)}/req`,
            );
        }
        if (t.missing > 0) parts.push(`${formatCount(t.missing)} missing`);
        if (t.retries > 0) parts.push(`${formatCount(t.retries)} retries`);
        return parts.join(SEP);
    };

    activity.value = () => {
        const idle = Date.now() - lastEventAt;
        const where = currentPage || currentTest || "starting…";
        // Only call out the wait once it exceeds normal request latency —
        // otherwise every line would carry a meaningless sub-second timer.
        return idle > STALL_MS
            ? `${where}  ·  waiting ${formatDuration(idle)}…`
            : where;
    };

    function handleEvent(event) {
        lastEventAt = Date.now();
        switch (event.type) {
            case "test":
                // Prefer the page title: it names what is actually on the wire,
                // which is what you need when a request is slow or 404ing. It
                // differs from the stored test name only for variants that carry
                // a `testName` (AHSME → AMC 12).
                if (event.phase === "start") {
                    currentTest = event.pageTitle ?? event.name;
                    currentPage = currentTest;
                } else if (verbose) {
                    region.log(
                        `· ${event.name}: ${formatCount(event.count)} problems`,
                    );
                }
                break;
            case "problem":
                currentPage = `${event.pageTitle ?? event.name}  ·  problem ${event.index}/${event.total}`;
                break;
            case "request":
                if (verbose) {
                    const how = event.cached
                        ? "cache"
                        : formatDuration(event.ms);
                    region.log(
                        `  ${event.missing ? "404 " : "ok  "}${event.page}  (${how})`,
                    );
                }
                break;
            case "retry":
                // Always surfaced: a retry is the signal that AoPS is pushing
                // back, and it is exactly what a silent-looking run is doing.
                region.log(
                    `⚠️  retry ${event.attempt} (${event.kind}) on ${event.page} — backing off ${formatDuration(event.delayMs)}`,
                );
                break;
            case "warn":
                region.log(`⚠️  ${event.message}`);
                break;
        }
    }

    return {
        region,
        log: (...args) => region.log(...args),

        /** Wires a ForumSession or WikiSession into this progress display. */
        attach(session) {
            sessions.push(session);
            session.logger = (message) => region.log(message);
            session.onEvent = handleEvent;
            session.onProblemAdd = () => {
                counter.increment();
                lastEventAt = Date.now();
            };
            return session;
        },

        start() {
            lastEventAt = Date.now();
            region.start();
            return this;
        },

        stop() {
            region.stop();
            return this;
        },

        get count() {
            return counter.count;
        },

        /**
         * One-line request accounting for after the run, plus an explicit
         * throttling verdict — the thing you actually want when a scrape felt
         * slow and you need to know whether to blame the network or the config.
         */
        summary() {
            const t = totals();
            if (t.requests === 0) return [];
            const lines = [
                `Requests: ${formatCount(t.requests)}  ·  cache ${formatCount(t.cacheHits)}  ·  network ${formatCount(t.networkRequests)}  ·  missing pages ${formatCount(t.missing)}  ·  retries ${formatCount(t.retries)}`,
            ];
            if (t.networkRequests > 0) {
                const avg = t.networkMs / t.networkRequests;
                lines.push(
                    `Network: ${formatDuration(t.networkMs)} total, ${formatDuration(avg)} average per request.`,
                );
                if (avg > THROTTLE_MS) {
                    lines.push(
                        `⚠️  AoPS averaged ${formatDuration(avg)} per request — that is server-side throttling, not a hang. Re-running reuses ./response_cache for everything already fetched.`,
                    );
                }
            }
            if (t.challenges > 0) {
                lines.push(
                    `⚠️  ${formatCount(t.challenges)} Cloudflare challenge(s) hit. If these persist, refresh the session headers in .env.js from your browser's DevTools.`,
                );
            }
            if (t.missing > t.requests / 2) {
                lines.push(
                    `⚠️  Over half of all requests were for pages that do not exist. Check the \`wiki.years\` / \`variants\` ranges in contest_id.js — a variant is probably being swept across years it never ran.`,
                );
            }
            return lines;
        },
    };
}
