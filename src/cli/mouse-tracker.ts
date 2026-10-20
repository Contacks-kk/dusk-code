export interface ClickRegion {
    id: string;
    row: number;
    startCol?: number;
    endCol?: number;
    onClick: () => void | Promise<void>;
}

export interface ParsedMouseEvent {
    button: number;
    col: number;
    row: number;
    isDown: boolean;
}

export class MouseTracker {
    private isEnabled = false;
    private regions: ClickRegion[] = [];

    /** 开启 SGR 1006 终端鼠标点击跟踪协议 */
    public enable(): void {
        if (!process.stdout.isTTY || this.isEnabled) return;
        process.stdout.write("\x1b[?1000h\x1b[?1006h");
        this.isEnabled = true;
    }

    /** 关闭终端鼠标点击跟踪协议 */
    public disable(): void {
        if (!this.isEnabled) return;
        process.stdout.write("\x1b[?1000l\x1b[?1006l");
        this.isEnabled = false;
    }

    /** 注册可点击交互热区 */
    public registerRegion(region: ClickRegion): void {
        this.regions.push(region);
    }

    /** 清理已登记的所有可点击区域 */
    public clearRegions(): void {
        this.regions = [];
    }

    /** 从原始输入流中提取并清洗 SGR 鼠标序列，防止字符误插入输入框 */
    public extractMouseEvents(chunkStr: string): { cleaned: string; events: ParsedMouseEvent[] } {
        const events: ParsedMouseEvent[] = [];
        const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

        let cleaned = chunkStr.replace(mouseRegex, (_match, btn, col, row, act) => {
            events.push({
                button: parseInt(btn, 10),
                col: parseInt(col, 10),
                row: parseInt(row, 10),
                isDown: act === "M"
            });
            return "";
        });

        // 清理潜在游离的 SGR 前缀残留
        if (cleaned.startsWith("\x1b[<")) {
            cleaned = "";
        }

        return { cleaned, events };
    }

    /** 分发鼠标点击事件并触发命中热区的回调逻辑 */
    public async dispatchClick(col: number, row: number): Promise<boolean> {
        for (const reg of this.regions) {
            if (reg.row === row) {
                if (reg.startCol !== undefined && col < reg.startCol) continue;
                if (reg.endCol !== undefined && col > reg.endCol) continue;
                await reg.onClick();
                return true;
            }
        }
        return false;
    }

    /** 检查当前是否处于鼠标监听激活状态 */
    public isActive(): boolean {
        return this.isEnabled;
    }
}

export const mouseTracker = new MouseTracker();
