import * as readline from "node:readline";
import { mouseTracker } from "./mouse-tracker";

export class LiveInputManager {
    private isRunning = false;
    private buffer = "";
    private pendingInputs: string[] = [];
    private originalWrite?: typeof process.stdout.write;

    /** 检查当前执行态输入框是否处于激活状态 */
    public isActive(): boolean {
        return this.isRunning;
    }

    /** 渲染当前执行态输入条 */
    private renderInputLine(): void {
        if (!this.isRunning || !process.stdout.isTTY) {
            return;
        }

        const placeholder = this.buffer.length === 0
            ? "\x1b[38;5;242m(Agent 执行中，输入内容可在此键入...)\x1b[0m"
            : "";
        const writeFn = this.originalWrite || process.stdout.write.bind(process.stdout);

        writeFn(`\r\x1b[2K\x1b[38;5;250m› \x1b[38;5;255m${this.buffer}\x1b[0m${placeholder}`);
    }

    /** 启动执行期输入框监听，允许用户在 Agent 运算期间键入内容 */
    public start(): void {
        if (this.isRunning || !process.stdin.isTTY) {
            return;
        }

        this.isRunning = true;
        this.buffer = "";
        this.pendingInputs = [];

        // 劫持 stdout.write，在日志输出前抹除输入条，输出后恢复输入条
        this.originalWrite = process.stdout.write.bind(process.stdout);
        const original = this.originalWrite;

        process.stdout.write = ((chunk: any, encoding?: any, callback?: any) => {
            if (this.isRunning) {
                original("\r\x1b[2K");
            }
            const res = original(chunk, encoding, callback);
            if (this.isRunning) {
                this.renderInputLine();
            }
            return res;
        }) as typeof process.stdout.write;

        const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
        readline.emitKeypressEvents(input);

        input.on("keypress", this.onKeypress);
        this.renderInputLine();
    }

    /** 响应执行期间的键盘按键并维护输入缓冲 */
    private onKeypress = (str: string, key: readline.Key): void => {
        if (!this.isRunning || !key) {
            return;
        }

        // 过滤鼠标逃逸序列
        if (str && (str.includes("\x1b[<") || (str.startsWith("<") && key.name === undefined))) {
            return;
        }

        // Ctrl+C 触发全局中断退出
        if (key.ctrl && key.name === "c") {
            process.emit("SIGINT");
            return;
        }

        // 回车暂存当前输入
        if (key.name === "return" || key.name === "enter") {
            const trimmed = this.buffer.trim();
            if (trimmed.length > 0) {
                this.pendingInputs.push(trimmed);

                // 打印已接收提示并清空缓冲
                const writeFn = this.originalWrite || process.stdout.write.bind(process.stdout);
                writeFn(`\r\x1b[2K\x1b[38;5;250m› \x1b[38;5;255m${trimmed}\x1b[0m \x1b[90m(已捕获输入，等待当前执行阶段完成)\x1b[0m\n`);
            }
            this.buffer = "";
            this.renderInputLine();
            return;
        }

        // 退格删除字符
        if (key.name === "backspace") {
            if (this.buffer.length > 0) {
                this.buffer = this.buffer.slice(0, -1);
                this.renderInputLine();
            }
            return;
        }

        // 忽略其它控制按键
        if (key.ctrl || key.meta || (str && str.startsWith("\x1b"))) {
            return;
        }

        // 普通可打印字符录入
        if (str && !/[\r\n]/.test(str)) {
            this.buffer += str;
            this.renderInputLine();
        }
    };

    /** 停止执行态输入框并返回执行期间捕获的用户输入列表 */
    public stop(): string[] {
        if (!this.isRunning) {
            return [];
        }

        this.isRunning = false;
        const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
        input.off("keypress", this.onKeypress);

        if (this.originalWrite) {
            this.originalWrite("\r\x1b[2K");
            process.stdout.write = this.originalWrite;
            this.originalWrite = undefined;
        }

        const captured = [...this.pendingInputs];
        if (this.buffer.trim().length > 0) {
            captured.push(this.buffer.trim());
        }
        this.buffer = "";
        this.pendingInputs = [];

        return captured;
    }
}

export const liveInputManager = new LiveInputManager();
