import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExecutionRecord } from "../types";
import { createHash } from "node:crypto";
import { sourceMessage, type ContextMessage } from "./types";
import { isToolRecord, readToolContent, readToolDetails } from "../tools/result";

/** 判断旧版激活结果是否携带已经过期的完整技能正文 */
function isLegacyActivation(content: unknown[] | undefined, toolName?: string): boolean {
    return toolName === "activate_skill" && Boolean(content?.some(block => isToolRecord(block) &&
        block.type === "text" && typeof block.text === "string" && block.text.includes("### 技能执行规范与工作流")));
}

/** 还原工具文本和图片，旧版激活正文只转换为历史回执 */
export function restoreToolContent(result: unknown, toolName?: string): Array<TextContent | ImageContent> {
    const blocks = readToolContent(result);
    if (isLegacyActivation(blocks, toolName)) {
        const details = readToolDetails(result);
        return [{ type: "text", text: `历史技能加载回执：${details?.skillName ?? "详见归档"}；当前是否生效以本轮技能状态为准。${details?.error ? `失败：${details.error}` : ""}` }];
    }
    if (!blocks) {
        return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) ?? "" }];
    }
    const content: Array<TextContent | ImageContent> = [];
    for (const block of blocks) {
        if (!isToolRecord(block)) {
            continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
            content.push({ type: "text", text: block.text });
        } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
            content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        }
    }
    return content.length ? content : [{ type: "text", text: "工具未返回可还原的内容" }];
}

export interface StoredHistoryTurn {
    turn: { id?: number; turnNo?: number; executionJson?: ExecutionRecord | null };
    messages: Array<{ id?: number; role: string; content: string; createdAt?: Date | string | number | null }>;
}

/** 判断助手文本是否为运行时生成的状态说明 */
function isRuntimeReply(content: string): boolean {
    return /^⚠️\s*(?:\*\*)?(?:模型|运行时|执行记录持久化)/.test(content);
}

/** 为有效调用生成跨尝试唯一且符合协议的工具标识 */
export function historyToolId(attemptNo: number, callNo: number, id: string): string {
    return `dusk_a${attemptNo}_c${callNo}_${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
}

/** 使用有效调用链的响应快照与已保存工具结果还原历史 */
export function restoreRecordedMessages(item: StoredHistoryTurn): AgentMessage[] | undefined {
    const execution = item.turn.executionJson;
    const linked = execution?.effectiveCallRefs !== undefined;
    const calls = linked ? execution.effectiveCallRefs.flatMap(ref => {
        const call = execution.attempts.find(attempt => attempt.attemptNo === ref.attemptNo)?.calls.find(call => call.callNo === ref.callNo);
        return call?.response && call.phase !== "streaming" ? [{ ...ref, response: call.response }] : [];
    }) : (execution?.attempts.at(-1)?.calls ?? []).filter(call => call.response).map(call => ({
        attemptNo: execution.attempts.at(-1).attemptNo, callNo: call.callNo, response: call.response
    }));
    if (!calls.length) {
        return linked ? [] : undefined;
    }
    const results = new Map<string, AgentMessage & { role: "toolResult" }>();
    for (const saved of item.messages) {
        if (saved.role !== "tool_result") continue;
        try {
            const parsed = JSON.parse(saved.content);
            if (!parsed.id || !parsed.tool) {
                continue;
            }
            results.set(parsed.id, sourceMessage({
                role: "toolResult", toolCallId: parsed.id, toolName: parsed.tool,
                content: restoreToolContent(parsed.result, parsed.tool), isError: Boolean(parsed.isError),
                timestamp: saved.createdAt ? new Date(saved.createdAt).getTime() : 0
            }, parsed.attemptNo !== undefined && parsed.callNo !== undefined ? `t:${item.turn.id ?? 0}:a:${parsed.attemptNo}:c:${parsed.callNo}:tool:${parsed.id}` :
                saved.id ? `m:${saved.id}` : `t:${item.turn.id ?? 0}:a:1:c:1:tool:${parsed.id}`,
                item.turn.id, item.turn.turnNo));
        } catch {
            /** 无法还原的工具结果不参与调用配对 */
        }
    }
    const savedReply = item.messages.filter(saved => saved.role === "assistant" && !isRuntimeReply(saved.content)).at(-1)?.content;
    const messages: AgentMessage[] = [];
    let replyRestored = false;
    for (const [index, source] of calls.entries()) {
        const { response } = source;
        const last = index === calls.length - 1;
        if (response.stopReason !== "stop" && response.stopReason !== "toolUse" && !((linked || last) && response.stopReason === "length")) {
            continue;
        }
        const restored = structuredClone(response);
        if (linked) {
            for (const block of restored.content) {
                if (block.type === "toolCall") block.id = historyToolId(source.attemptNo, source.callNo, block.id);
            }
        }
        const toolCalls = restored.content.filter(block => block.type === "toolCall");
        const paired = response.stopReason !== "length" && toolCalls.every(block =>
            results.get(block.id)?.toolName === block.name);
        restored.content = restored.content.filter(block => block.type !== "toolCall" || paired);
        if (!linked && last && toolCalls.length === 0 && savedReply) {
            /** 最终正文沿用已落库的聚合结果，思考与签名仍来自真实响应 */
            restored.content = [...restored.content.filter(block => block.type !== "text"), { type: "text", text: savedReply }];
            replyRestored = true;
        } else if (last && savedReply && restored.content.some(block => block.type === "text" && block.text === savedReply)) {
            replyRestored = true;
        }
        if (restored.content.some(block => block.type === "toolCall" ||
            (block.type === "thinking" ? block.thinking || block.thinkingSignature : block.text))) {
            messages.push(sourceMessage(restored, `t:${item.turn.id ?? 0}:a:${source.attemptNo}:c:${source.callNo}`,
                item.turn.id, item.turn.turnNo));
        }
        if (paired) {
            for (const block of toolCalls) {
                messages.push(structuredClone(results.get(block.id)!));
            }
        }
        for (const internal of execution?.delivery?.continuations ?? []) {
            if (internal.afterCall.attemptNo === source.attemptNo && internal.afterCall.callNo === source.callNo) {
                const restored = { role: "runtime_control" as const, content: internal.message.content as string,
                    timestamp: internal.message.timestamp, instructionRevision: internal.instructionRevision ?? 0 };
                messages.push(sourceMessage(restored, `t:${item.turn.id ?? 0}:delivery:${internal.id}`,
                    item.turn.id, item.turn.turnNo));
            }
        }
    }
    if (!linked && savedReply && !replyRestored) {
        const last = calls.at(-1)!.response;
        const saved = item.messages.filter(saved => saved.role === "assistant" && !isRuntimeReply(saved.content)).at(-1);
        messages.push(sourceMessage({ ...structuredClone(last), content: [{ type: "text", text: savedReply }],
            stopReason: item.turn.executionJson?.status === "completed" ? "stop" : "length" },
            saved?.id ? `m:${saved.id}` : `t:${item.turn.id ?? 0}:reply`, item.turn.id, item.turn.turnNo));
    }
    const report = execution?.delivery?.finalReport;
    if (report) {
        messages.push(sourceMessage({ ...structuredClone(calls.at(-1)!.response), content: [{ type: "text", text: report }], stopReason: "stop" },
            `t:${item.turn.id ?? 0}:delivery:report`, item.turn.id, item.turn.turnNo));
    }
    return messages;
}

/** 为旧版数据库投影补全消息来源 */
export function annotateLegacyMessages(item: StoredHistoryTurn, messages: AgentMessage[]): void {
    const remaining = [...item.messages];
    for (const message of messages as ContextMessage[]) {
        if (message.contextSource) continue;
        const role = message.role === "toolResult" ? "tool_result" :
            message.role === "assistant" && message.content.some(block => block.type === "toolCall") ? "tool_call" : message.role;
        const index = remaining.findIndex(saved => saved.role === role);
        const saved = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
        sourceMessage(message, saved?.id ? `m:${saved.id}` : `t:${item.turn.id ?? 0}:legacy:${messages.indexOf(message)}`,
            item.turn.id, item.turn.turnNo);
    }
    const pending = Boolean(item.turn.executionJson?.pendingToolCallIds?.length || item.turn.executionJson?.attempts.some(attempt =>
        attempt.calls.some(call => call.phase === "streaming" && call.response)));
    if (pending) for (const message of messages as ContextMessage[]) message.contextSource!.protected = true;
}
