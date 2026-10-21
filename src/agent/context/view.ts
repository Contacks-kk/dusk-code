import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { contextHash, sourceMessage, type ContextArtifact, type ContextEntry, type ContextMessage, type ContextSource } from "./types";

/** 将消息分成完整工具批次与独立对话消息 */
export function contextEntries(messages: AgentMessage[]): ContextEntry[] {
    for (const [index, message] of messages.entries()) {
        if (!(message as ContextMessage).contextSource) sourceMessage(message, `runtime:${index}:${contextHash(message)}`);
    }
    const entries: ContextEntry[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index] as ContextMessage;
        const source = message.contextSource!;
        const batch = [message];
        const calls = message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : [];
        if (calls.length) {
            while (messages[index + 1]?.role === "toolResult") batch.push(messages[++index] as ContextMessage);
        }
        const results = batch.filter(item => item.role === "toolResult");
        const closed = message.role !== "toolResult" && (!calls.length || (results.length === calls.length &&
            new Set(calls.map(call => call.id)).size === calls.length && new Set(results.map(result => result.toolCallId)).size === results.length && calls.every(call =>
            results.some(result => result.toolCallId === call.id && result.toolName === call.name))));
        entries.push({ messages: batch, sources: batch.map(item => ({ ...(item as ContextMessage).contextSource!, hash: contextHash(item) })),
            turnId: source.turnId, groupId: source.ref, closed });
    }
    return entries;
}

/** 校验覆盖范围的原始来源和内容哈希仍然一致 */
export function matchesSources(entries: ContextEntry[], sources: ContextSource[]): boolean {
    const actual = entries.flatMap(entry => entry.sources);
    return actual.length === sources.length && actual.every((source, index) =>
        source.ref === sources[index].ref && source.hash === sources[index].hash);
}

/** 将已提交的替换记录放回原始历史位置，失效记录自动忽略 */
export function applyContextArtifacts(original: ContextEntry[], artifacts: ContextArtifact[]): ContextEntry[] {
    const entries = [...original];
    for (const artifact of artifacts) {
        if (!artifact.sources.length) continue;
        const start = entries.findIndex(entry => entry.sources[0]?.ref === artifact.sources[0].ref);
        if (start < 0) continue;
        let end = start;
        let count = 0;
        while (end < entries.length && count < artifact.sources.length) count += entries[end++].sources.length;
        if (!entries.slice(start, end).every(entry => entry.closed && !entry.sources.some(source => source.protected)) ||
            !matchesSources(entries.slice(start, end), artifact.sources)) continue;
        entries.splice(start, end - start, { messages: artifact.messages, sources: artifact.sources,
            turnId: entries[start].turnId, groupId: artifact.id, closed: true, artifactId: artifact.id, kind: artifact.kind });
    }
    return entries;
}

/** 验证请求中每批工具调用都有且只有对应结果 */
export function validateToolPairs(messages: AgentMessage[]): void {
    for (const entry of contextEntries(messages)) {
        if (!entry.closed) throw new Error("上下文工具调用尚未完整结算，禁止发送不完整调用链");
    }
}
