import { estimateHistoryTokens, estimateTokenCount } from "./token";

/** 上下文窗口双水位配置：软水位触发分级衰减，硬水位强制丢弃最旧轮次 */
export const CONTEXT_LIMITS = {
    MAX_CONTEXT_TOKENS: 128000,
    TRIGGER_TOKENS: 110000,
    OVERSIZED_TOOL_RESULT_TOKENS: 500
} as const;

/** 单条消息压缩后的占位说明 */
const COMPACT_MARK = "...[历史超长输出已紧凑压缩]...";

/** 将超大 tool_result 内容压缩为短摘要（仅内存操作，不写数据库） */
function compactToolResultContent(content: string): string {
    try {
        const parsed = JSON.parse(content);
        if (typeof parsed.result === "string" && parsed.result.length > 200) {
            parsed.result = parsed.result.slice(0, 200) + `\n${COMPACT_MARK}`;
            return JSON.stringify(parsed);
        }
        if (typeof parsed.result === "object" && parsed.result !== null) {
            const serialized = JSON.stringify(parsed.result);
            if (serialized.length > 200) {
                parsed.result = { summary: serialized.slice(0, 200) + "...", compressed: true };
                return JSON.stringify(parsed);
            }
        }
        return content;
    } catch {
        return content.slice(0, 250) + `\n${COMPACT_MARK}`;
    }
}

/**
 * 分级上下文衰减裁剪（双水位保障）：
 * - 低于软水位：原样返回；
 * - 超过软水位：对超大 tool_result 做内存紧凑压缩（浅拷贝，不污染入参、不写库）；
 * - 超过硬水位：从最旧轮次开始整轮丢弃（保证 tool_call/tool_result 成对），永远保留最新一轮。
 * 超出预算的历史交由 runner 的 fitHistory 二次裁剪。
 */
export function pruneHistoryContext(
    history: Array<{ turn: any; messages: any[] }>,
    inputTokens: number
): Array<{ turn: any; messages: any[] }> {
    if (estimateHistoryTokens(history) + inputTokens <= CONTEXT_LIMITS.TRIGGER_TOKENS) {
        return history;
    }

    // 第 1 级：压缩超大工具结果，返回新的消息数组结构
    let result = history.map(item => ({
        turn: item.turn,
        messages: item.messages.map(msg => {
            if (msg.role !== "tool_result" || estimateTokenCount(msg.content) <= CONTEXT_LIMITS.OVERSIZED_TOOL_RESULT_TOKENS) {
                return msg;
            }
            return { ...msg, content: compactToolResultContent(msg.content) };
        })
    }));

    // 第 2 级：仍超过硬水位时，从最旧轮次开始整轮丢弃，至少保留最新一轮
    while (result.length > 1 && estimateHistoryTokens(result) + inputTokens > CONTEXT_LIMITS.MAX_CONTEXT_TOKENS) {
        result = result.slice(1);
    }

    return result;
}
