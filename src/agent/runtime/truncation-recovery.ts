import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { GenerationAttempt, TruncationStage } from "../types";

/** 提取助手消息中的全部正文文本 */
function textOf(message?: AssistantMessage): string {
    if (!message) return "";
    return message.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
        .trim();
}

/** 提取助手消息中的完整思考文本 */
export function thinkingOf(message?: AssistantMessage): string {
    if (!message) return "";
    return message.content
        .filter(block => block.type === "thinking")
        .map(block => block.thinking)
        .join("\n")
        .trim();
}

/** 从消息序列中定位最后一条助手消息 */
export function findLastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
    return messages
        .filter((m): m is AssistantMessage => m.role === "assistant")
        .at(-1);
}

/** 识别截断发生在 Thinking、普通正文还是 ToolCall 参数阶段 */
export function detectTruncationStage(
    messages: AgentMessage[],
    _summary?: GenerationAttempt
): TruncationStage {
    const lastAssistant = findLastAssistant(messages);
    if (!lastAssistant) return "thinking";

    const content = lastAssistant.content;
    const hasToolCall = content.some(block => block.type === "toolCall");
    const lastBlock = content.at(-1);

    // 若末尾块或内容中包含工具调用，属于 ToolCall 参数阶段截断
    if (hasToolCall && (lastBlock?.type === "toolCall" || !textOf(lastAssistant))) {
        return "tool_call";
    }

    // 若已有非空正文输出，属于普通正文阶段截断
    const rawText = textOf(lastAssistant);
    if (rawText.length > 0) {
        return "text";
    }

    // 仅有思考块或无文本无工具，属于 Thinking 阶段截断
    return "thinking";
}

/** 判断当前模型与 API 是否支持跨轮次复用未完成的推理思考状态 */
export function canReuseReasoningState(_model: string): boolean {
    /** 回传历史思考不等于恢复供应商内部推理状态，当前不启用精确续推 */
    return false;
}

/** 从未完成的思考过程中提取关键任务检查点与规划大纲 */
export function generateThinkingCheckpoint(thinkingText: string): string {
    if (!thinkingText) return "已完成前期任务拆解与目标分析。";

    // 优先提取思考中的关键规划句或结构化序号行
    const lines = thinkingText.split("\n");
    const keyLines = lines
        .map(l => l.trim())
        .filter(l => /^[0-9一二三四五]+[、. ]|^[-*] |(?:步骤|方案|设计|规划|目标|首先|其次|然后|接着|实现)/.test(l))
        .slice(-8);

    if (keyLines.length > 0) {
        return keyLines.join("\n");
    }

    // 回退截取末尾 300 字符作为检查点上下文
    return thinkingText.slice(-300).trim();
}

/** 构造带历史末尾片段的精准无缝续写提示词 */
export function buildContinuationPrompt(accumulatedText: string, checkpoint?: string): string {
    const tailSnippet = accumulatedText.slice(-260).trim();
    const checkpointNotice = checkpoint ? `【已规划检查点】\n${checkpoint}\n\n` : "";

    return `${checkpointNotice}【系统续写指引】
你的上一次回复因达到单次输出上限被截断。前文末尾内容为：
---
...${tailSnippet}
---
请紧接上述内容末尾无缝接续剩余内容。
要求：严禁重复前文已有的任何字句、段落或代码围栏，直接输出后续正文或代码！`;
}

/** 构造基于任务检查点的直接生成提示词（跳过冗余思考） */
export function buildCheckpointPrompt(originalPrompt: string, checkpoint: string): string {
    return `${originalPrompt}

【系统指引：基于任务检查点直接输出】
在上一阶段思考中，你已完成了如下核心设计与规划：
---
${checkpoint}
---
当前输出预算已达单次上限，请跳过冗余的思考过程，基于上述检查点直接输出最终完整的解决方案与代码！`;
}

/** 智能缝合多个续写片段，消除边界处的重叠冗余并保证格式连贯 */
export function aggregateTextChunks(chunks: string[]): string {
    const validChunks = chunks.map(c => c.trim()).filter(Boolean);
    if (validChunks.length === 0) return "";
    if (validChunks.length === 1) return validChunks[0];

    let merged = validChunks[0];
    for (let i = 1; i < validChunks.length; i++) {
        const next = validChunks[i];
        
        // 探测前后片段是否存在 10~50 字符的重叠前缀/后缀
        let overlap = 0;
        const maxProbe = Math.min(60, merged.length, next.length);
        for (let len = maxProbe; len >= 10; len--) {
            const tail = merged.slice(-len);
            if (next.startsWith(tail)) {
                overlap = len;
                break;
            }
        }

        if (overlap > 0) {
            merged += next.slice(overlap);
        } else {
            // 若上一个片段不是以换行结束且下一个片段不是标点开头，补充必要分隔
            const lastChar = merged.slice(-1);
            const needsNewline = !/[\n\r]/.test(lastChar);
            merged += (needsNewline ? "\n" : "") + next;
        }
    }

    return merged.trim();
}

/** 清理消息序列中未生成完整的残损工具调用 */
export function sanitizeIncompleteToolCalls(messages: AgentMessage[]): AgentMessage[] {
    return messages.map(msg => {
        if (msg.role !== "assistant") return msg;
        const assistant = msg as AssistantMessage;
        const sanitizedContent = assistant.content.filter(block => {
            if (block.type !== "toolCall") return true;
            // 剔除缺少 ID 或参数无法有效解析的残损 toolCall
            if (!block.id || !block.name) return false;
            try {
                if (typeof block.arguments === "string") {
                    JSON.parse(block.arguments);
                }
                return true;
            } catch {
                return false;
            }
        });
        return {
            ...assistant,
            content: sanitizedContent
        };
    });
}
