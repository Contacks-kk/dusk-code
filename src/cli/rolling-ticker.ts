import { colors, formatDuration } from "./theme";
import { mouseTracker } from "./mouse-tracker";
import { liveInputManager } from "./live-input";
import { truncateTerminalText } from "./terminal-layout";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class RollingTicker {
    private buffer = "";
    private startTime = 0;
    private isActive = false;
    private spinnerIndex = 0;
    private stage = "正在准备请求";
    private timer?: NodeJS.Timeout;

    /** 提交任务后立即显示状态并定时刷新等待进度 */
    public start(): void {
        this.flush();
        this.buffer = "";
        this.startTime = Date.now();
        this.isActive = true;
        this.spinnerIndex = 0;
        this.stage = "正在准备请求";
        this.render();
        this.timer = setInterval(() => this.render(), 120);
        this.timer.unref();
    }

    /** 切换请求、生成和工具执行阶段 */
    public setStage(stage: string): void {
        if (!this.isActive) {
            this.start();
        }
        this.stage = stage;
        this.render();
    }

    /** 弹出交互菜单前暂停刷新 */
    public pause(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** 菜单关闭后继续刷新并保留任务总耗时 */
    public resume(): void {
        if (!this.isActive || this.timer) {
            return;
        }
        this.render();
        this.timer = setInterval(() => this.render(), 120);
        this.timer.unref();
    }

    /** 缓存完整思考并切换底部状态 */
    public update(delta: string): void {
        if (!this.isActive) {
            this.start();
        }
        this.stage = "正在思考";
        this.buffer += delta;
    }

    /** 原地刷新等待状态，不向历史记录追加定时进度 */
    private render(): void {
        if (!this.isActive) {
            return;
        }

        const now = Date.now();
        const elapsed = formatDuration(now - this.startTime);
        const spinner = SPINNER_FRAMES[this.spinnerIndex++ % SPINNER_FRAMES.length];
        const status = `${this.stage} (${elapsed})`;

        if (!process.stdout.isTTY) {
            return;
        }

        const line = `${colors.gray}${spinner} ${status}${colors.reset}`;
        if (liveInputManager.isActive()) {
            liveInputManager.setStatus(line);
        } else {
            process.stdout.write(`\r${truncateTerminalText(`  ${line}`)}\x1b[0m\x1b[K`);
        }
    }

    /** 保存思考全文并继续显示正文生成状态 */
    public finish(durationMs?: number): void {
        if (!this.isActive) {
            return;
        }
        const timeText = formatDuration(durationMs ?? (Date.now() - this.startTime));
        if (this.buffer.trim()) {
            mouseTracker.writeThought(`已思考 ${timeText}`, this.buffer);
        }
        this.buffer = "";
        this.setStage("正在生成回复");
    }

    /** 清除定时器和当前活动提示 */
    public flush(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        if (!this.isActive) {
            return;
        }
        this.isActive = false;
        if (liveInputManager.isActive()) {
            liveInputManager.setStatus("");
        } else if (process.stdout.isTTY) {
            process.stdout.write("\r\x1b[K");
        }
    }

    /** 获取尚未折叠的完整思考文本 */
    public getFullText(): string {
        return this.buffer;
    }
}

export const rollingTicker = new RollingTicker();
