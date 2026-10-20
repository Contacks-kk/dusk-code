import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

export interface ParsedMouseEvent {
    button: number;
    col: number;
    row: number;
    isDown: boolean;
}

export class MouseTracker {
    public readonly input = new PassThrough();
    private isEnabled = false;
    private wasRaw = false;
    private decoder = new StringDecoder("utf8");
    private pendingInput = "";
    private inputTimer?: NodeJS.Timeout;
    private originalWrite?: typeof process.stdout.write;
    private originalErrorWrite?: typeof process.stderr.write;
    private bufferedOutput: Array<{ text: string; error: boolean }> = [];
    private latestThought?: { header: string; text: string };
    private viewer?: { header: string; text: string; lines: string[]; offset: number };
    private readonly viewerInput = new PassThrough();
    private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

    /** 初始化独立的详情键盘输入流 */
    public constructor() {
        readline.emitKeypressEvents(this.viewerInput);
        this.viewerInput.on("keypress", this.onViewerKeypress);
        this.input.resume();
    }

    /** 接入共享键盘输入并保留主界面的原生终端滚动 */
    public enable(): void {
        if (!process.stdin.isTTY || !process.stdout.isTTY || this.isEnabled) return;
        this.isEnabled = true;
        this.wasRaw = !!process.stdin.isRaw;
        this.originalWrite = process.stdout.write;
        this.originalErrorWrite = process.stderr.write;
        process.stdout.write = this.wrapOutput(false);
        process.stderr.write = this.wrapOutput(true);
        process.stdin.setRawMode(true);
        process.stdin.on("data", this.onInput);
        process.stdout.on("resize", this.onResize);
        process.once("exit", this.onExit);
        process.stdout.write("\x1b[?1000l\x1b[?1006l");
        process.stdin.resume();
    }

    /** 还原终端屏幕、鼠标模式与输入输出监听 */
    public disable(): void {
        if (!this.isEnabled) return;
        this.closeThought();
        clearTimeout(this.inputTimer);
        this.pendingInput = "";
        process.stdin.off("data", this.onInput);
        process.stdout.off("resize", this.onResize);
        process.off("exit", this.onExit);
        process.stdout.write("\x1b[?1000l\x1b[?1006l");
        process.stdout.write = this.originalWrite!;
        process.stderr.write = this.originalErrorWrite!;
        process.stdin.setRawMode(this.wasRaw);
        process.stdin.pause();
        this.isEnabled = false;
        this.latestThought = undefined;
        this.decoder = new StringDecoder("utf8");
    }

    /** 进程退出时还原鼠标模式 */
    private onExit = (): void => { this.disable(); };

    /** 窗口尺寸改变后重新排版思考详情 */
    private onResize = (): void => {
        if (this.viewer) {
            this.viewer.lines = this.wrapText(this.viewer.text);
            this.renderViewer();
        }
    };

    /** 查看详情期间暂存后台输出并保持写入回调 */
    private wrapOutput(error: boolean): typeof process.stdout.write {
        return ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
            const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
            if (this.viewer) {
                this.bufferedOutput.push({ text, error });
                const done = typeof encoding === "function" ? encoding : callback;
                if (done) queueMicrotask(done);
                return true;
            }
            const write = error ? this.originalErrorWrite! : this.originalWrite!;
            return write.call(error ? process.stderr : process.stdout, chunk, encoding as BufferEncoding, callback);
        }) as typeof process.stdout.write;
    }

    /** 输出精简思考摘要并保存最近一次原文供快捷键查看 */
    public writeThought(header: string, text: string): void {
        process.stdout.write(`\r  \x1b[90m▸ ${header}\x1b[0m\x1b[K\n`);
        if (this.isEnabled) this.latestThought = { header, text };
    }

    /** 展开最近一次完整思考 */
    public openLatestThought(): void {
        if (this.latestThought) this.openThought(this.latestThought.header, this.latestThought.text);
    }

    /** 在独立屏幕展开指定思考，保留主屏内容与输入位置 */
    private openThought(header: string, text: string): void {
        if (!this.isEnabled || this.viewer) return;
        this.viewer = { header, text, lines: this.wrapText(text), offset: 0 };
        /** 仅在详情屏接管鼠标，避免主界面吞掉终端历史滚轮 */
        this.originalWrite!.call(process.stdout, "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
        this.renderViewer();
    }

    /** 收起详情后回放后台输出并还原主屏光标 */
    private closeThought(): void {
        if (!this.viewer) return;
        this.viewer = undefined;
        this.originalWrite!.call(process.stdout, "\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h");
        for (const { text, error } of this.bufferedOutput) {
            (error ? this.originalErrorWrite! : this.originalWrite!).call(error ? process.stderr : process.stdout, text);
        }
        this.bufferedOutput = [];
    }

    /** 按终端宽度折行思考全文并清除终端控制字符 */
    private wrapText(text: string): string[] {
        const width = Math.max(1, (process.stdout.columns || 80) - 4);
        const lines: string[] = [];
        const safeText = stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        for (const line of safeText.split("\n")) {
            let part = "";
            let used = 0;
            for (const { segment } of this.segmenter.segment(line)) {
                const size = stringWidth(segment);
                if (used + size > width && part) { lines.push(part); part = ""; used = 0; }
                part += segment;
                used += size;
            }
            lines.push(part);
        }
        return lines;
    }

    /** 渲染可滚动的思考详情及收起入口 */
    private renderViewer(): void {
        if (!this.viewer) return;
        const rows = Math.max(4, process.stdout.rows || 24);
        const pageSize = rows - 3;
        this.viewer.offset = Math.max(0, Math.min(this.viewer.offset, this.viewer.lines.length - pageSize));
        const header = this.wrapText(this.viewer.header)[0];
        const body = this.viewer.lines.slice(this.viewer.offset, this.viewer.offset + pageSize).map(line => `  ${line}`).join("\r\n");
        const footer = this.wrapText(`Esc 收起 · ↑↓/滚轮翻阅 · ${this.viewer.offset + 1}/${this.viewer.lines.length}`)[0];
        this.originalWrite!.call(process.stdout, `\x1b[H\x1b[2J  \x1b[90m▾ ${header}\x1b[0m\r\n\r\n${body}\x1b[${rows};1H\x1b[90m${footer}\x1b[0m`);
    }

    /** 响应详情界面的翻页、收起与取消按键 */
    private onViewerKeypress = (_text: string, key: readline.Key): void => {
        if (!this.viewer || !key) return;
        if (key.ctrl && key.name === "c") { this.closeThought(); this.deliverKeyboard("\x03"); return; }
        if ((key.ctrl && key.name === "o") || key.name === "escape" || key.name === "q") { this.closeThought(); return; }
        const pageSize = Math.max(1, (process.stdout.rows || 24) - 3);
        if (key.name === "up") this.viewer.offset--;
        if (key.name === "down") this.viewer.offset++;
        if (key.name === "pageup") this.viewer.offset -= pageSize;
        if (key.name === "pagedown") this.viewer.offset += pageSize;
        if (key.name === "home") this.viewer.offset = 0;
        if (key.name === "end") this.viewer.offset = this.viewer.lines.length;
        this.renderViewer();
    };

    /** 分离鼠标及光标报告，避免终端协议污染用户输入 */
    private onInput = (chunk: Buffer): void => {
        clearTimeout(this.inputTimer);
        const text = this.pendingInput + this.decoder.write(chunk);
        this.pendingInput = "";
        let cleaned = "";
        for (let index = 0; index < text.length;) {
            if (text[index] !== "\x1b") { cleaned += text[index++]; continue; }
            const tail = text.slice(index);
            const mousePrefix = tail.startsWith("\x1b[<");
            const sequence = (mousePrefix ? /^\x1b\[<[^\x00-\x1f\x7f]*?[Mm]/ : /^\x1b\[[0-?]*[ -/]*[@-~]/).exec(tail)?.[0];
            if (mousePrefix && !sequence) {
                const partial = /^\x1b\[<[^\x00-\x1f\x7f]*/.exec(tail)![0];
                if (partial.length === tail.length && tail.length < 128) { this.pendingInput = tail; break; }
                index += partial.length;
                continue;
            }
            if (!sequence && (tail === "\x1b" || (/^\x1b\[[0-?]*[ -/]*$/.test(tail) && tail.length < 128))) {
                this.pendingInput = tail;
                break;
            }
            if (!sequence && tail.startsWith("\x1b[")) {
                index += /^\x1b\[[0-?]*[ -/]*/.exec(tail)?.[0].length || 2;
                continue;
            }
            if (!sequence) { cleaned += text[index++]; continue; }
            const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
            const cursor = /^\x1b\[(\d+);(\d+)R$/.exec(sequence);
            if (mouse) this.handleMouse({ button: +mouse[1], col: +mouse[2], row: +mouse[3], isDown: mouse[4] === "M" });
            else if (!cursor && !mousePrefix) cleaned += sequence;
            index += sequence.length;
        }
        this.deliverKeyboard(cleaned);
        if (this.pendingInput === "\x1b") {
            this.inputTimer = setTimeout(() => {
                const pending = this.pendingInput;
                this.pendingInput = "";
                if (pending === "\x1b") this.deliverKeyboard(pending);
            }, 50);
        }
    };

    /** 将普通按键交给当前界面，无界面接收时保留取消能力 */
    private deliverKeyboard(text: string): void {
        if (!text) return;
        if (this.viewer && text === "\x1b") { this.closeThought(); return; }
        if (this.viewer) { this.viewerInput.write(text); return; }
        if (this.input.listenerCount("keypress")) this.input.write(text);
        else if (text.includes("\x03")) process.emit("SIGINT");
        else if (text === "\x0f") this.openLatestThought();
    }

    /** 仅在思考详情中响应收起点击与滚轮翻阅 */
    private handleMouse(event: ParsedMouseEvent): void {
        if (!this.viewer || !event.isDown) return;
        if (event.button === 0 && event.row === 1 && event.col === 3) this.closeThought();
        else if (event.button === 64 || event.button === 65) {
            this.viewer.offset += event.button === 64 ? -3 : 3;
            this.renderViewer();
        }
    }

    /** 检查共享终端输入是否已接入 */
    public isActive(): boolean {
        return this.isEnabled;
    }
}

export const mouseTracker = new MouseTracker();
