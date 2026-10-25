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
    private renderedLines: string[] = [];
    private onSubmit?: (input: string) => Promise<void>;
    private taskStatus = "";

    /** 显示宿主任务状态，独立于模型思考提示 */
    public setTaskStatus(status: string): void {
        this.taskStatus = status;
        this.renderInputLine();
    }

    /** 更新底部执行状态并保留正在输入的内容 */
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
            this.clearInputLines();
        }
        this.isSuspended = true;
    }

    /** 确认菜单关闭后恢复暂存的输入 */
    public resume(): void {
        this.isSuspended = false;
        this.renderInputLine();
    }

    /** 清除底部临时区域，终端缩放后按实际折行数回到起点 */
    private clearInputLines(): void {
        if (!this.renderedLines.length) {
            return;
        }
        const rows = this.renderedLines.reduce((total, line) => total + wrapTerminalText(line, getTerminalWidth() + 1).length, 0);
        const write = this.originalWrite || process.stdout.write.bind(process.stdout);
        write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[0J`);
        this.renderedLines = [];
    }

    /** 分行显示等待状态与输入内容，输入时仍能看见当前进度 */
    private renderInputLine(): void {
        if (!this.isActive() || !process.stdout.isTTY) {
            return;
        }

        const writeFn = this.originalWrite || process.stdout.write.bind(process.stdout);
        const status = [this.status, this.taskStatus].filter(Boolean).join(" · ") || "\x1b[90m正在处理请求\x1b[0m";
        const content = this.buffer.length > 0
            ? `\x1b[37m${wrapTerminalText(this.buffer, Math.max(1, getTerminalWidth() - 2)).at(-1)}`
            : "\x1b[90m输入新要求，Enter 发送\x1b[0m";
        this.clearInputLines();
        const input = truncateTerminalText(`\x1b[37m› ${content}`);
        this.renderedLines = process.stdout.rows && process.stdout.rows < 3 ? [this.buffer ? input : truncateTerminalText(status)] :
            [truncateTerminalText(`  ${status}`), input];
        writeFn(this.renderedLines.map(line => `\r\x1b[2K${line}\x1b[0m`).join("\n"));
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

        // 日志输出前让出底部区域，输出后恢复状态与输入
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
                this.clearInputLines();
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

        // 回车提交当前输入
        if (key.name === "return" || key.name === "enter") {
            const trimmed = this.buffer.trim();
            if (trimmed.length > 0) {
                if (this.onSubmit) {
                    void this.onSubmit(trimmed).catch(error => {
                        process.stderr.write(`输入未接收：${error instanceof Error ? error.message : String(error)}\n`);
                    });
                } else {
                    this.pendingInputs.push(trimmed);
                }

                // 回显用户提交的要求
                process.stdout.write(`\x1b[37m› ${trimmed}\x1b[0m\n`);
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

        this.clearInputLines();
        this.isRunning = false;
        process.stdout.off("resize", this.onResize);
        const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
        input.off("keypress", this.onKeypress);

        if (this.originalWrite) {
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
        this.renderedLines = [];
        this.taskStatus = "";
        this.onSubmit = undefined;

        return captured;
    }
}

export const liveInputManager = new LiveInputManager();
