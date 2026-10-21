import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { GenerationUsage } from "../types";

export interface ContextSource {
    ref: string;
    hash: string;
    turnId: number;
    turnNo: number;
    protected?: boolean;
}

export type ContextMessage = AgentMessage & { contextSource?: ContextSource };

export interface ContextEntry {
    messages: AgentMessage[];
    sources: ContextSource[];
    turnId: number;
    groupId: string;
    closed: boolean;
    artifactId?: string;
    kind?: "summary" | "excerpt" | "omission";
}

export interface SummaryItem {
    text: string;
    status: "confirmed" | "hypothesis" | "superseded";
    sourceRefs: string[];
}

export interface ContextSummary {
    goals: SummaryItem[];
    constraints: SummaryItem[];
    facts: SummaryItem[];
    decisions: SummaryItem[];
    completedActions: SummaryItem[];
    unresolved: SummaryItem[];
    nextSteps: SummaryItem[];
    superseded: SummaryItem[];
    recall: SummaryItem[];
}

export interface ContextArtifact {
    id: string;
    sessionId: number;
    kind: "summary" | "excerpt" | "omission";
    sources: ContextSource[];
    parentIds: string[];
    messages: AgentMessage[];
    summary?: ContextSummary;
    model: string;
    promptVersion: string;
    beforeTokens: number;
    afterTokens: number;
    createdAt: number;
    usage?: GenerationUsage;
    durationMs?: number;
}

export interface ContextEvent {
    kind: "summary" | "excerpt" | "omission" | "summary_failed" | "storage_failed" | "provider_overflow";
    beforeTokens: number;
    afterTokens: number;
    sourceRefs?: string[];
    artifactId?: string;
    error?: string;
    durationMs?: number;
    usage?: GenerationUsage;
}

export interface ContextRecord {
    checks: number;
    revision: number;
    inputBudget: number;
    triggerTokens: number;
    targetTokens: number;
    estimatedInputTokens: number;
    events: ContextEvent[];
}

export interface ContextPersistence {
    sessionId: number;
    revision: number;
    artifacts: ContextArtifact[];
    /** 原子提交替换记录与活动视图 */
    commit(artifacts: ContextArtifact[], added: ContextArtifact, validate: () => boolean): number;
    /** 从当前会话归档找回指定来源 */
    readSources(refs: string[]): Promise<ContextMessage[]>;
}

/** 计算实际回放内容的稳定哈希，排除用量与运行时状态 */
export function contextHash(message: AgentMessage): string {
    const value = message as any;
    return createHash("sha256").update(JSON.stringify({ role: value.role,
        content: typeof value.content === "string" ? [{ type: "text", text: value.content }] : value.content,
        toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError })).digest("hex");
}

/** 为回放消息绑定独立于协议工具标识的原始来源 */
export function sourceMessage<T extends AgentMessage>(message: T, ref: string, turnId = 0, turnNo = turnId): T & { contextSource: ContextSource } {
    return Object.assign(message, { contextSource: { ref, hash: contextHash(message), turnId, turnNo } });
}

/** 创建只承载历史状态的助手消息 */
export function contextNotice(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openai",
        model: "context-summary", stopReason: "stop", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
