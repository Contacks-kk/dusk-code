import stringWidth from "string-width";
import { colors, formatDuration } from "./theme";
import { mouseTracker } from "./mouse-tracker";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class RollingTicker {
    private buffer = "";
    private startTime = 0;
    private isActive = false;
    private currentTurnNo = 1;
    private spinnerIndex = 0;
    private lastRenderTime = 0;
    private isStdinSilenced = false;

    /** 思考期间拦截键盘输入，防止回车生成新行，保留 Ctrl+C 退出 */
    private onStdinData = (chunk: Buffer): void => {
        if (!this.isActive) return;
        // Ctrl+C (\x03) 允许用户退出
        if (chunk.length > 0 && chunk[0] === 3) {
            this.disableKeyboardSilence();
            process.stdout.write("\n");
            process.emit("SIGINT");
        }
        // 其余输入（特别是 Enter \r \n）完全静音吞掉，不产生回显
    };

    /** 开启键盘静音拦截模式 */
    private enableKeyboardSilence(): void {
        if (!process.stdin.isTTY || this.isStdinSilenced || mouseTracker.isActive()) return;
        try {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", this.onStdinData);
            this.isStdinSilenced = true;
        } catch {
            // 忽略非标准环境异常
        }
    }

    /** 关闭键盘静音拦截模式 */
    private disableKeyboardSilence(): void {
        if (!this.isStdinSilenced) return;
        try {
            process.stdin.off("data", this.onStdinData);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            this.isStdinSilenced = false;
        } catch {
            // 忽略非标准环境异常
        }
    }

    /** 启动思考状态显示，开辟单行就地刷新区域并开启键盘静音 */
    public start(turnNo = 1): void {
        this.buffer = "";
        this.startTime = Date.now();
        this.isActive = true;
        this.currentTurnNo = turnNo;
        this.spinnerIndex = 0;
        this.lastRenderTime = 0;
        this.enableKeyboardSilence();
        this.render(true);
    }

    /** 写入思考增量文本并节流触发单行原地刷新 */
    public update(delta: string): void {
        if (!this.isActive) {
            this.start(this.currentTurnNo);
        }
        this.buffer += delta;

        // 60ms 节流，避免高频 Token 输出引起终端闪烁或重复
        const now = Date.now();
        if (now - this.lastRenderTime >= 60) {
            this.render();
        }
    }

    /** 基于字符实际显示列宽安全截断末尾单行预览文本 */
    private truncateByDisplayWidth(text: string, maxWidth: number): string {
        const totalW = stringWidth(text);
        if (totalW <= maxWidth) return text;

        let accumulated = 0;
        let sliceStart = text.length;
        for (let i = text.length - 1; i >= 0; i--) {
            const charW = stringWidth(text[i]);
            if (accumulated + charW + 3 > maxWidth) {
                break;
            }
            accumulated += charW;
            sliceStart = i;
        }
        return "..." + text.slice(sliceStart);
    }

    /** 在同一物理行上通过 \r 原地重绘，计算实际列宽杜绝隐式换行 */
    private render(force = false): void {
        if (!process.stdout.isTTY || !this.isActive) return;

        const now = Date.now();
        if (!force && now - this.lastRenderTime < 60) return;
        this.lastRenderTime = now;

        const elapsed = Math.max(0, Math.floor((now - this.startTime) / 1000));
        const spinner = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
        this.spinnerIndex++;

        // 提取末尾最新的一句思考文本作为单行预览，消除换行符
        const cleanSnippet = this.buffer
            .slice(-120)
            .replace(/[\r\n\t]+/g, " ")
            .trim();

        const cols = Math.max(40, process.stdout.columns || 80);
        const prefixRaw = `  ${spinner} Thinking (${elapsed}s)... `;
        const prefixWidth = stringWidth(prefixRaw);
        const prefix = `  ${colors.cyan}${spinner}${colors.reset} ${colors.gray}Thinking (${elapsed}s)...${colors.reset} `;

        // 留出 4 字符安全余量，防止终端边界触发行折叠
        const maxSnippetWidth = Math.max(10, cols - prefixWidth - 4);
        const preview = this.truncateByDisplayWidth(cleanSnippet, maxSnippetWidth);

        // 核心：严格使用 \r 回到行首，绝不写入 \n，末尾用 \x1b[K 清除行末残余字符
        process.stdout.write(`\r${prefix}${colors.gray}${colors.dim}${preview}${colors.reset}\x1b[K`);
    }

    /** 思考完成时原地替换为一行精简折叠卡片并换行收尾，解除键盘静音 */
    public finish(durationMs?: number): void {
        if (!this.isActive) return;
        this.isActive = false;
        this.disableKeyboardSilence();

        const totalChars = this.buffer.length;
        const timeText = formatDuration(durationMs ?? (Date.now() - this.startTime));

        /** 保存此条思考快照供 Ctrl+O 查看，避免循环编号重用时混入其他原文 */
        mouseTracker.writeThought(`Thought for ${timeText} (${totalChars.toLocaleString()} chars)`, this.buffer);
    }

    /** 清理当前行未闭合的刷新状态并解除键盘静音 */
    public flush(): void {
        this.disableKeyboardSilence();
        if (this.isActive) {
            process.stdout.write("\r\x1b[K");
            this.isActive = false;
        }
    }

    /** 获取当前缓冲区的完整思考文本 */
    public getFullText(): string {
        return this.buffer;
    }
}

export const rollingTicker = new RollingTicker();
