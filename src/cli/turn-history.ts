export interface ToolCallDetail {
    id: string;
    name: string;
    args: Record<string, any>;
    result?: any;
    durationMs?: number;
    isError?: boolean;
}

export interface TurnRecord {
    turnNo: number;
    thinkingText: string;
    thinkingDurationMs: number;
    intermediateText?: string;
    toolCalls: ToolCallDetail[];
    startedAt: number;
    finishedAt?: number;
    isExpanded?: boolean;
}

export class TurnHistoryManager {
    private turns: Map<number, TurnRecord> = new Map();
    private totalOutputLines = 0;
    private turnLineOffsets: Map<number, { startLine: number; thoughtLine?: number }> = new Map();

    /** 记录输出渲染增加的终端行数 */
    public recordOutputLines(lines: number): void {
        this.totalOutputLines += Math.max(0, lines);
    }

    /** 记录指定轮次标题所在的输出行号 */
    public recordTurnStartLine(turnNo: number): void {
        const entry = this.turnLineOffsets.get(turnNo) || { startLine: this.totalOutputLines };
        entry.startLine = this.totalOutputLines;
        this.turnLineOffsets.set(turnNo, entry);
    }

    /** 记录指定轮次思考卡片所在的输出行号 */
    public recordThoughtLine(turnNo: number): void {
        const entry = this.turnLineOffsets.get(turnNo) || { startLine: this.totalOutputLines };
        entry.thoughtLine = this.totalOutputLines;
        this.turnLineOffsets.set(turnNo, entry);
    }

    /** 获取指定轮次在输出流中的行偏移信息 */
    public getTurnLineOffsets(turnNo: number): { startLine: number; thoughtLine?: number } | undefined {
        return this.turnLineOffsets.get(turnNo);
    }

    /** 获取当前累计输出的物理行数 */
    public getTotalOutputLines(): number {
        return this.totalOutputLines;
    }

    /** 切换指定轮次的折叠/展开状态 */
    public toggleExpanded(turnNo: number): boolean {
        const record = this.recordTurnStart(turnNo);
        record.isExpanded = !record.isExpanded;
        return record.isExpanded;
    }

    /** 获取指定轮次的展开状态 */
    public isExpanded(turnNo: number): boolean {
        return !!this.turns.get(turnNo)?.isExpanded;
    }

    /** 开启或获取指定轮次的历史容器 */
    public recordTurnStart(turnNo: number): TurnRecord {
        let record = this.turns.get(turnNo);
        if (!record) {
            record = {
                turnNo,
                thinkingText: "",
                thinkingDurationMs: 0,
                toolCalls: [],
                startedAt: Date.now(),
                isExpanded: false
            };
            this.turns.set(turnNo, record);
        }
        return record;
    }

    /** 向指定轮次追加思考文本 */
    public appendThinking(turnNo: number, delta: string): void {
        const record = this.recordTurnStart(turnNo);
        record.thinkingText += delta;
    }

    /** 记录指定轮次的思考用时 */
    public finishThinking(turnNo: number, durationMs: number): void {
        const record = this.recordTurnStart(turnNo);
        record.thinkingDurationMs = durationMs;
    }

    /** 记录指定轮次的中间发言说明 */
    public recordIntermediateText(turnNo: number, text: string): void {
        const record = this.recordTurnStart(turnNo);
        record.intermediateText = text;
    }

    /** 记录指定轮次的工具调用 */
    public recordToolCall(turnNo: number, tool: ToolCallDetail): void {
        const record = this.recordTurnStart(turnNo);
        const existing = record.toolCalls.find(t => t.id === tool.id);
        if (existing) {
            Object.assign(existing, tool);
        } else {
            record.toolCalls.push({ ...tool });
        }
    }

    /** 记录指定轮次中具体工具的执行结果 */
    public recordToolResult(
        turnNo: number,
        toolCallId: string,
        result: any,
        durationMs?: number,
        isError?: boolean
    ): void {
        const record = this.recordTurnStart(turnNo);
        const existing = record.toolCalls.find(t => t.id === toolCallId);
        if (existing) {
            existing.result = result;
            existing.durationMs = durationMs;
            existing.isError = isError;
        } else {
            record.toolCalls.push({
                id: toolCallId,
                name: "unknown",
                args: {},
                result,
                durationMs,
                isError
            });
        }
    }

    /** 标记指定轮次结束 */
    public finishTurn(turnNo: number): void {
        const record = this.turns.get(turnNo);
        if (record) {
            record.finishedAt = Date.now();
        }
    }

    /** 获取所有已记录的轮次列表 */
    public getTurns(): TurnRecord[] {
        return Array.from(this.turns.values()).sort((a, b) => a.turnNo - b.turnNo);
    }

    /** 获取指定编号的轮次数据 */
    public getTurn(turnNo: number): TurnRecord | undefined {
        return this.turns.get(turnNo);
    }

    /** 清空历史记录 */
    public reset(): void {
        this.turns.clear();
    }
}

export const turnHistoryManager = new TurnHistoryManager();
