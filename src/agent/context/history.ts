import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExecutionRecord } from "../types";

export interface StoredHistoryTurn {
    turn: { executionJson?: ExecutionRecord | null };
    messages: Array<{ role: string; content: string; createdAt?: Date | string | number | null }>;
}

/** 判断助手文本是否为运行时生成的状态说明 */
function isRuntimeReply(content: string): boolean {
    return /^⚠️\s*(?:\*\*)?(?:模型|运行时|执行记录持久化)/.test(content);
}

/** 使用最终尝试的响应快照与已保存工具结果还原有效助手历史 */
export function restoreRecordedMessages(item: StoredHistoryTurn): AgentMessage[] | undefined {
    const calls = item.turn.executionJson?.attempts.at(-1)?.calls;
    if (!calls?.some(call => call.response)) return undefined;
    const responses = calls.map(call => call.response).filter((response): response is AssistantMessage => Boolean(response));
    const results = new Map<string, AgentMessage & { role: "toolResult" }>();
    for (const saved of item.messages) {
        if (saved.role !== "tool_result") continue;
        try {
            const parsed = JSON.parse(saved.content);
            if (!parsed.id || !parsed.tool) continue;
            const text = Array.isArray(parsed.result?.content)
                ? parsed.result.content.map((block: any) => block.text || "").join("\n")
                : typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result) ?? "";
            results.set(parsed.id, {
                role: "toolResult", toolCallId: parsed.id, toolName: parsed.tool,
                content: [{ type: "text", text }], isError: Boolean(parsed.isError),
                timestamp: saved.createdAt ? new Date(saved.createdAt).getTime() : 0
            });
        } catch {
            /** 无法还原的工具结果不参与调用配对 */
        }
    }
    const savedReply = item.messages.filter(saved => saved.role === "assistant" && !isRuntimeReply(saved.content)).at(-1)?.content;
    const messages: AgentMessage[] = [];
    let replyRestored = false;
    for (const [index, response] of responses.entries()) {
        const last = index === responses.length - 1;
        if (response.stopReason !== "stop" && response.stopReason !== "toolUse" && !(last && response.stopReason === "length")) continue;
        const toolCalls = response.content.filter(block => block.type === "toolCall");
        const paired = response.stopReason !== "length" && toolCalls.every(block =>
            results.get(block.id)?.toolName === block.name);
        const restored = structuredClone(response);
        restored.content = restored.content.filter(block => block.type !== "toolCall" || paired);
        if (last && toolCalls.length === 0 && savedReply) {
            /** 最终正文沿用已落库的聚合结果，思考与签名仍来自真实响应 */
            restored.content = [...restored.content.filter(block => block.type !== "text"), { type: "text", text: savedReply }];
            replyRestored = true;
        } else if (last && savedReply && restored.content.some(block => block.type === "text" && block.text === savedReply)) {
            replyRestored = true;
        }
        if (restored.content.some(block => block.type === "toolCall" ||
            (block.type === "thinking" ? block.thinking || block.thinkingSignature : block.text))) {
            messages.push(restored);
        }
        if (paired) {
            for (const block of toolCalls) messages.push(structuredClone(results.get(block.id)!));
        }
    }
    if (savedReply && !replyRestored) {
        const last = responses.at(-1)!;
        messages.push({ ...structuredClone(last), content: [{ type: "text", text: savedReply }],
            stopReason: item.turn.executionJson?.status === "completed" ? "stop" : "length" });
    }
    return messages;
}
