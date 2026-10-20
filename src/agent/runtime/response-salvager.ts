import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { RunStatus, GenerationAttempt } from "../types";

/** 响应内容可用性分级（从高到低） */
export type ResponseQuality =
    | "complete"      // finish_reason=stop，正文完整
    | "partial_text"  // 被截断但已有可用正文片段
    | "tools_only"    // 仅产出了工具调用，无正文
    | "thinking_only" // 仅消耗在思考阶段，无正文无工具
    | "empty";        // 完全没有内容

export interface SalvagedContent {
    quality: ResponseQuality;
    text: string;
    thinkingChars: number;
    toolCallCount: number;
    hasUsableContent: boolean;
    truncationNote?: string;
}

/** 从助手消息块中提取正文 */
function extractText(message?: AssistantMessage): string {
    if (!message) return "";
    return message.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
        .trim();
}

/** 从助手消息块中提取思考文本总字符数 */
function extractThinkingChars(message?: AssistantMessage): number {
    if (!message) return 0;
    return message.content.reduce(
        (sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0), 0
    );
}

/** 从助手消息块中统计工具调用次数 */
function extractToolCallCount(message?: AssistantMessage): number {
    if (!message) return 0;
    return message.content.filter(block => block.type === "toolCall").length;
}

/** 从消息序列中定位最后一条助手消息 */
function findLastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
    return messages
        .filter((m): m is AssistantMessage => m.role === "assistant")
        .at(-1);
}

/** 对被截断的正文进行自愈修剪与闭合处理 */
function cleanTruncatedText(text: string): { text: string; healedBlock: boolean } {
    if (!text) return { text, healedBlock: false };

    // 检查是否有未闭合的代码块围栏 (奇数个 ```)
    const fences = text.match(/```/g);
    let healedBlock = false;
    let result = text;
    if (fences && fences.length % 2 !== 0) {
        result = result.trimEnd() + "\n```";
        healedBlock = true;
    }

    return { text: result.trim(), healedBlock };
}

/** 从模型生成结果中尽最大努力打捞可用内容 */
export function salvageResponse(
    messages: AgentMessage[],
    summary: GenerationAttempt
): SalvagedContent {
    const lastAssistant = findLastAssistant(messages);
    const rawText = extractText(lastAssistant);
    const thinkingChars = extractThinkingChars(lastAssistant);
    const toolCallCount = extractToolCallCount(lastAssistant);
    const isTruncated = summary.status === "truncated" || summary.stopReason === "length";

    // 未获取到任何内容
    if (!rawText && toolCallCount === 0 && thinkingChars === 0) {
        return {
            quality: "empty",
            text: "",
            thinkingChars: 0,
            toolCallCount: 0,
            hasUsableContent: false
        };
    }

    // 仅消耗在思考，无正文无工具
    if (!rawText && toolCallCount === 0) {
        return {
            quality: "thinking_only",
            text: "",
            thinkingChars,
            toolCallCount: 0,
            hasUsableContent: false,
            truncationNote: isTruncated
                ? `思考阶段消耗 ${thinkingChars.toLocaleString()} 字符后达到输出上限 ${summary.maxTokens} token，正文未开始生成`
                : undefined
        };
    }

    // 有工具调用但无正文
    if (!rawText && toolCallCount > 0) {
        return {
            quality: "tools_only",
            text: "",
            thinkingChars,
            toolCallCount,
            hasUsableContent: true
        };
    }

    // 有正文且未被截断 → 完整响应
    if (!isTruncated) {
        return {
            quality: "complete",
            text: rawText,
            thinkingChars,
            toolCallCount,
            hasUsableContent: true
        };
    }

    // 有正文但被截断 → 清洗与自愈后作为部分可用内容返回
    const { text: cleaned, healedBlock } = cleanTruncatedText(rawText);
    const healingNote = healedBlock ? "，已自动闭合未结束代码块" : "";
    return {
        quality: "partial_text",
        text: cleaned,
        thinkingChars,
        toolCallCount,
        hasUsableContent: cleaned.length > 0,
        truncationNote: `正文在 ${rawText.length} 字符处被截断（思考消耗 ${thinkingChars.toLocaleString()} 字符）${healingNote}`
    };
}

/** 基于打捞结果与执行状态，合成最终用户可见的回复文本 */
export function composeReply(
    salvaged: SalvagedContent,
    status: RunStatus,
    summary: GenerationAttempt | undefined,
    contextError?: string,
    generationTimeoutMs?: number
): string {
    // 有完整或部分可用正文时，优先返回模型产出
    if (salvaged.text) {
        if (salvaged.quality === "complete") {
            return salvaged.text;
        }

        // 部分正文：附加截断提示标签与接续指引
        const note = salvaged.truncationNote || "正文在输出上限处被截断";
        return `${salvaged.text}\n\n---\n⚠️ **生成未完成** — ${note}。您可以输入「继续」让模型接续未完成的部分。`;
    }

    // 无正文时，按状态生成兜底说明
    const outputTokens = summary?.calls.at(-1)?.usage.outputTokens;
    const usage = outputTokens == null ? "实际输出用量未知" : `实际输出 ${outputTokens} token`;
    const reason = contextError || summary?.error;

    switch (status) {
        case "truncated": {
            const thinkNote = salvaged.thinkingChars > 0
                ? `思考阶段消耗 ${salvaged.thinkingChars.toLocaleString()} 字符`
                : "";
            const sideEffect = summary?.sideEffectStarted
                ? "本轮已开始执行变更，为避免重复操作未自动重试。"
                : "已停止自动恢复。";
            return `⚠️ 模型生成未完成：达到输出上限 ${summary?.maxTokens} token（${usage}）${thinkNote ? `，${thinkNote}` : ""}，结束原因 length。${sideEffect}${contextError ? ` ${contextError}` : ""}`;
        }
        case "timeout": {
            const waitDesc = generationTimeoutMs ? `单次等待超过 ${generationTimeoutMs / 1000} 秒` : "单次等待超时";
            return `⚠️ 模型生成超时：${waitDesc}，已终止；${usage}，未自动重试。`;
        }
        case "empty":
            return "⚠️ 模型未返回最终正文，生成已结束；本轮执行状态已保存。";
        case "aborted":
            return "⚠️ 模型生成已取消，本轮执行状态已保存。";
        default:
            return `⚠️ 模型调用异常: ${reason || "没有得到有效的模型生成结果"}`;
    }
}

/** 生成达到恢复次数或预算上限时最终输出的结构化未完成报告 */
export function composeIncompleteReport(
    salvaged: SalvagedContent,
    summary: GenerationAttempt | undefined,
    recoveryStepsCount: number,
    finalStage?: string
): string {
    const stageDesc = finalStage === "thinking" ? "思考规划阶段" : finalStage === "tool_call" ? "工具调用生成阶段" : "正文输出阶段";
    const thinkInfo = salvaged.thinkingChars > 0 ? `累计思考 ${salvaged.thinkingChars.toLocaleString()} 字符` : "";
    const prefix = salvaged.text ? `${salvaged.text}\n\n---\n` : "";

    return `${prefix}⚠️ **模型生成未完全结束（已停止自动恢复）**
- **中断阶段**：${stageDesc}
- **恢复尝试**：已自动执行 ${recoveryStepsCount} 轮自愈恢复，已达恢复上限（输出预算 ${summary?.maxTokens ?? 131072} token）
- **状态统计**：${thinkInfo ? `${thinkInfo}，` : ""}已打捞保存已有可见产出
💡 **建议**：您可以输入「继续」在当前基础上无缝接续，或输入 \`/model\` 调整思考预算与配置。`;
}
