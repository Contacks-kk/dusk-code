import * as readline from "node:readline";
import { mouseTracker } from "./mouse-tracker";
import { getTerminalWidth, truncateTerminalText, wrapTerminalText } from "./terminal-layout";

export class LiveInputManager {
    private isRunning = false;
    private buffer = "";
    private pendingInputs: string[] = [];
    private originalWrite?: typeof process.stdout.write;
    private originalErrorWrite?: typeof process.stderr.write;
    private status = "";
    private isSuspended = false;
    private renderedLine = "";
    private onSubmit?: (input: string) => Promise<void>;
    private taskStatus = "";

    /** 显示宿主任务状态，独立于模型思考提示 */
    public setTaskStatus(status: string): void {
        this.taskStatus = status;
        this.renderInputLine();
    }

    /** 更新执行状态并在空输入条中展示进度 */
    public setStatus(status: string): void {
        this.status = status;
        this.renderInputLine();
    }

    /** 检查当前执行态输入框是否处于激活状态 */
    public isActive(): boolean {
        return this.isRunning && !this.isSuspended;
    }

    /** 弹出确认菜单前暂停输入条和键盘处理 */
    public pause(): void {
        if (this.isActive()) {
            this.originalWrite?.("\r\x1b[2K");
        }
        this.isSuspended = true;
        this.renderedLine = "";
    }

    /** 确认菜单关闭后恢复暂存的输入 */
    public resume(): void {
        this.isSuspended = false;
        this.renderInputLine();
    }

    /** 渲染当前执行态输入条 */
    private renderInputLine(): void {
        if (!this.isActive() || !process.stdout.isTTY) {
            return;
        }

        const writeFn = this.originalWrite || process.stdout.write.bind(process.stdout);
        const content = this.buffer.length > 0
            ? `\x1b[38;5;255m${wrapTerminalText(this.buffer, Math.max(2, getTerminalWidth() - 2)).at(-1)}`
            : [this.taskStatus, this.status].filter(Boolean).join(" · ") || "\x1b[38;5;242m(Agent 执行中，可继续输入)\x1b[0m";

        this.renderedLine = truncateTerminalText(`\x1b[38;5;250m› ${content}`);
        writeFn(`\r\x1b[2K${this.renderedLine}\x1b[0m`);
    }

    /** 启动执行期输入框监听，允许用户在 Agent 运算期间键入内容 */
    public start(onSubmit?: (input: string) => Promise<void>): void {
        if (this.isRunning || !process.stdin.isTTY) {
            return;
        }

        this.isRunning = true;
        this.isSuspended = false;
        this.buffer = "";
        this.pendingInputs = [];
        this.onSubmit = onSubmit;
        process.stdout.on("resize", this.onResize);

        // 劫持 stdout.write，在日志输出前抹除输入条，输出后恢复输入条
        this.originalWrite = process.stdout.write.bind(process.stdout);
        this.originalErrorWrite = process.stderr.write.bind(process.stderr);
        process.stdout.write = this.wrapOutput(this.originalWrite);
        process.stderr.write = this.wrapOutput(this.originalErrorWrite);

        const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
        readline.emitKeypressEvents(input);

        input.on("keypress", this.onKeypress);
        this.renderInputLine();
    }

    /** 输出日志时让出输入行，保留无换行输出和错误信息 */
    private wrapOutput(write: typeof process.stdout.write): typeof process.stdout.write {
        return ((chunk: any, encoding?: any, callback?: any) => {
            if (this.isActive()) {
                this.originalWrite?.("\r\x1b[2K");
            }
            const result = write(chunk, encoding, callback);
            if (this.isActive()) {
                const text = String(chunk);
                if (text.length > 0 && !text.endsWith("\n")) {
                    this.originalWrite?.("\n");
                }
                this.renderInputLine();
            }
            return result;
        }) as typeof process.stdout.write;
    }

    /** 窗口改变后按当前列数重绘输入条 */
    private onResize = (): void => {
        if (!this.isActive()) {
            return;
        }

        // 窗口缩小时先移除旧输入条折出的行，避免残留在新状态上方
        const rows = wrapTerminalText(this.renderedLine, getTerminalWidth() + 1).length;
        if (rows > 1) {
            this.originalWrite?.(`\r\x1b[${rows - 1}A\x1b[0J`);
        }
        this.renderInputLine();
    };

    /** 响应执行期间的键盘按键并维护输入缓冲 */
    private onKeypress = (str: string, key: readline.Key): void => {
        if (!this.isActive() || !key) {
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
                if (this.onSubmit) {
                    void this.onSubmit(trimmed).catch(error => {
                        const write = this.originalErrorWrite || process.stderr.write.bind(process.stderr);
                        write(`\n输入处理失败：${error instanceof Error ? error.message : String(error)}\n`);
                    });
                } else {
                    this.pendingInputs.push(trimmed);
                }

                // 打印已接收提示并清空缓冲
                const writeFn = this.originalWrite || process.stdout.write.bind(process.stdout);
                writeFn(`\r\x1b[2K\x1b[38;5;250m› \x1b[38;5;255m${trimmed}\x1b[0m \x1b[90m(正在接收新要求)\x1b[0m\n`);
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
        process.stdout.off("resize", this.onResize);
        const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
        input.off("keypress", this.onKeypress);

        if (this.originalWrite) {
            this.originalWrite("\r\x1b[2K");
            process.stdout.write = this.originalWrite;
            this.originalWrite = undefined;
        }
        if (this.originalErrorWrite) {
            process.stderr.write = this.originalErrorWrite;
            this.originalErrorWrite = undefined;
        }

        const captured = [...this.pendingInputs];
        if (this.buffer.trim().length > 0) {
            captured.push(this.buffer.trim());
        }
        this.buffer = "";
        this.pendingInputs = [];
        this.status = "";
        this.isSuspended = false;
        this.renderedLine = "";
        this.taskStatus = "";
        this.onSubmit = undefined;

        return captured;
    }
}

export const liveInputManager = new LiveInputManager();
