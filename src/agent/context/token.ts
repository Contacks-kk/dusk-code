import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

/** 估算纯文本内容的 Token 消耗量 */
export function estimateTokenCount(text?: string | null): number {
    if (!text) {
        return 0;
    }

    // 匹配 CJK 中文字符（中日韩统一表意文字）
    const cjkMatches = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    /** 其他文本按 UTF-8 字节保守估算 */
    const nonCjkTokens = Math.ceil(Buffer.byteLength(text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, ""), "utf8") / 3);

    /** 中文及相邻文字每字预留两个 Token */
    const cjkTokens = cjkCount * 2;

    return Math.max(1, cjkTokens + nonCjkTokens);
}

/** 估算一条多模态消息及完整思考内容的上下文用量 */
export function messageTokens(message: AgentMessage): number {
    const extra = message.role === "toolResult" ? estimateTokenCount(message.toolCallId) + estimateTokenCount(message.toolName) : 0;
    if (typeof message.content === "string") return 12 + extra + estimateTokenCount(message.content);
    return 12 + extra + message.content.reduce((total, block: any) => total + (block.type === "image" ? 8192 :
        estimateTokenCount(block.text ?? block.thinking ?? JSON.stringify(block))), 0);
}

/** 统一估算本次真正发送的系统提示、工具定义与消息 */
export function requestTokens(messages: AgentMessage[], systemPrompt: string, tools: AgentTool<any>[]): number {
    return 16 + estimateTokenCount(systemPrompt) + estimateTokenCount(JSON.stringify(tools.map(({ name, description, parameters }) =>
        ({ name, description, parameters })))) + messages.reduce((sum, message) => sum + messageTokens(message), 0);
}
