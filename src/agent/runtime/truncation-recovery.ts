import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { GenerationAttempt, TruncationStage } from "../types";

/** 提取助手消息中的完整思考文本 */
export function thinkingOf(message?: AssistantMessage): string {
    return message?.content.filter(block => block.type === "thinking").map(block => block.thinking).join("\n") ?? "";
}

/** 优先定位供应商真实的截断响应 */
export function findLastAssistant(messages: AgentMessage[], summary?: GenerationAttempt): AssistantMessage | undefined {
    return [...(summary?.calls ?? [])].reverse().find(call => call.stopReason === "length")?.response ??
        summary?.calls.at(-1)?.response ?? messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
}

/** 按真实响应识别工具参数、正文或思考截断 */
export function detectTruncationStage(messages: AgentMessage[], summary?: GenerationAttempt): TruncationStage {
    const content = findLastAssistant(messages, summary)?.content ?? [];
    if (content.some(block => block.type === "toolCall")) return "tool_call";
    return content.some(block => block.type === "text" && block.text.length > 0) ? "text" : "thinking";
}

/** 提取有界的思考检查点，原始响应仍完整归档 */
export function generateThinkingCheckpoint(thinkingText: string): string {
    const lines = thinkingText.split("\n").filter(line => /步骤|方案|设计|规划|目标|实现|plan|implement|next/i.test(line)).slice(-8);
    return [...lines, thinkingText.slice(-4096)].join("\n").slice(-6144);
}

/** 构造保留已有进展的阶段恢复指令 */
export function buildRecoveryPrompt(stage: TruncationStage): string {
    const instruction = stage === "tool_call"
        ? "上一条工具调用参数生成被截断，整批调用均未执行。不要拼接残缺 JSON，请重新生成完整且较小的工具调用。长文件先用 write_file 创建较小的可运行骨架，再用 apply_patch 分步补齐，避免一次输出整个长文件。"
        : stage === "text"
            ? "上一条正文被截断。已有正文完整保留在上下文中，请从末尾直接输出剩余内容，不重复前文，不新增或补闭代码围栏，保留接续所需的空白和换行。"
            : "上一阶段思考达到单次输出上限。请根据已保留的思考和工具结果直接执行剩余任务，避免重新规划。";
    return `【截断恢复】${instruction}\n原始需求和已完成步骤已保留，请继续完成剩余工作，不要重复执行已有明确结果的操作。`;
}

/** 原样拼接正文续写片段 */
export function aggregateTextChunks(chunks: string[]): string {
    return chunks.join("");
}
