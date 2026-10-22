import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Model, ToolResultMessage } from "@mariozechner/pi-ai";
import { boundedText } from "./recall.tool";
import { contextEntries, applyContextArtifacts, validateToolPairs } from "./view";
import { messageTokens, requestTokens } from "./token";
import { summarizeContext, SUMMARY_VERSION, type SummaryRepairFeedback } from "./summarizer";
import type { ResolvedModelCapabilities } from "../runtime/model-profile";
import { contextHash, contextNotice, type ContextArtifact, type ContextEntry, type ContextEvent, type ContextMessage,
    type ContextPersistence, type ContextRecord, type ContextSummary } from "./types";

const calibration = new Map<string, number>();

export interface ContextCoordinatorOptions {
    capabilities?: ResolvedModelCapabilities;
    model: Model<any>;
    apiKey: string;
    systemPrompt: string;
    tools: AgentTool<any>[];
    turnId: number;
    enabled: boolean;
    persistence?: ContextPersistence;
    onStatus?: (text: string) => void;
    summarize?: typeof summarizeContext;
}

export class ContextCoordinator {
    readonly record: ContextRecord;
    private artifacts: ContextArtifact[];
    private raw: ContextEntry[] = [];
    private readonly modelKey: string;
    private baseline = 0;

    /** 加载本次任务共享的上下文视图与统计 */
    constructor(private readonly options: ContextCoordinatorOptions) {
        this.artifacts = [...options.persistence?.artifacts ?? []];
        this.modelKey = `${options.model.baseUrl}:${options.model.id}`;
        this.record = { checks: 0, revision: options.persistence?.revision ?? 0,
            inputBudget: 0, triggerTokens: 0, targetTokens: 0, estimatedInputTokens: 0, events: [] };
    }

    /** 使用供应商实际输入用量向上校准同模型的预算估算 */
    observe(inputTokens: number): void {
        if (this.baseline > 0 && inputTokens > 0) calibration.set(this.modelKey,
            Math.max(calibration.get(this.modelKey) ?? 1, inputTokens / this.baseline));
    }

    /** 计算当前视图真正发送的全部输入用量 */
    private tokens(entries: ContextEntry[]): number {
        return Math.ceil(requestTokens(entries.flatMap(entry => entry.messages), this.options.systemPrompt, this.options.tools) *
            (calibration.get(this.modelKey) ?? 1));
    }

    /** 判断当前用户要求、恢复指令和未闭合交互是否必须保留 */
    private hard(entry: ContextEntry): boolean {
        return !entry.closed || entry.sources.some(source => source.protected) ||
            (entry.turnId === this.options.turnId && entry.messages.some(message => message.role === "user"));
    }

    /** 找出近期完整轮次与最低近期 Token 的共同保护起点 */
    private protectedStart(entries: ContextEntry[]): number {
        const oldTurns = [...new Set(entries.filter(entry => entry.turnId !== this.options.turnId).map(entry => entry.turnId))].slice(-2);
        let start = entries.findIndex(entry => oldTurns.includes(entry.turnId));
        if (start < 0) start = entries.length;
        let remaining = Math.min(12000, Math.floor(this.record.inputBudget * .25));
        for (let index = entries.length - 1; index >= 0 && remaining > 0; index--) {
            remaining -= entries[index].messages.reduce((sum, message) => sum + messageTokens(message), 0);
            start = Math.min(start, index);
        }
        if (start < entries.length && entries[start].turnId !== this.options.turnId) {
            while (start > 0 && entries[start - 1].turnId === entries[start].turnId) start--;
        }
        return start;
    }

    /** 选择最短且足以释放目标空间的完整旧区段 */
    private candidate(entries: ContextEntry[]): ContextEntry[] {
        const end = this.protectedStart(entries);
        const start = entries.findIndex((entry, index) => index < end && !this.hard(entry) && entry.kind !== "omission");
        if (start < 0) return [];
        const selected: ContextEntry[] = [];
        let saved = 0;
        const capacity = this.options.model.contextWindow - 4096 - Math.max(4096, Math.ceil(this.options.model.contextWindow * .05)) - 2048;
        for (let index = start; index < end && !this.hard(entries[index]);) {
            const group: ContextEntry[] = [entries[index++]];
            if (group[0].turnId !== this.options.turnId) {
                while (index < end && entries[index].turnId === group[0].turnId && !this.hard(entries[index])) group.push(entries[index++]);
            }
            const size = group.flatMap(entry => entry.messages).reduce((sum, message) => sum + messageTokens(message), 0);
            if (saved + size > capacity) break;
            selected.push(...group);
            saved += size;
            if (saved - 4096 >= this.tokens(entries) - this.record.targetTokens) break;
        }
        return selected;
    }

    /** 创建来源可追溯且具有独立标识的替换记录 */
    private artifact(selected: ContextEntry[], kind: ContextArtifact["kind"], messages: AgentMessage[], summary?: ContextSummary): ContextArtifact {
        return { id: randomUUID(), sessionId: this.options.persistence?.sessionId ?? 0, kind,
            sources: selected.flatMap(entry => entry.sources), parentIds: selected.flatMap(entry => entry.artifactId ? [entry.artifactId] : []),
            messages, summary, model: this.options.model.id, promptVersion: SUMMARY_VERSION,
            beforeTokens: selected.flatMap(entry => entry.messages).reduce((sum, message) => sum + messageTokens(message), 0),
            afterTokens: messages.reduce((sum, message) => sum + messageTokens(message), 0), createdAt: Date.now() };
    }

    /** 记录上下文变更且只在内容变化时通知用户 */
    private event(event: ContextEvent): void {
        if (event.error && this.options.apiKey) event.error = event.error.replaceAll(this.options.apiKey, "[REDACTED]");
        this.record.events.push(event);
    }

    /** 原子切换持久化视图，失败时允许只采用已归档来源的内存裁剪 */
    private install(artifact: ContextArtifact, signal?: AbortSignal, memoryFallback = false): void {
        signal?.throwIfAborted();
        const covered = new Set(artifact.sources.map(source => source.ref));
        const next = this.artifacts.filter(item => !item.sources.some(source => covered.has(source.ref))).concat(artifact);
        try {
            if (this.options.persistence) this.record.revision = this.options.persistence.commit(next, artifact, () => {
                const current = new Map(this.raw.flatMap(entry => entry.messages.map((message, index) =>
                    [entry.sources[index].ref, contextHash(message)] as const)));
                return !signal?.aborted && artifact.sources.every(source => current.get(source.ref) === source.hash);
            });
        } catch (error) {
            signal?.throwIfAborted();
            this.event({ kind: "storage_failed", beforeTokens: artifact.beforeTokens, afterTokens: artifact.afterTokens,
                error: error instanceof Error ? error.message : String(error) });
            if (!memoryFallback) throw error;
        }
        this.artifacts = next;
        this.event({ kind: artifact.kind, beforeTokens: artifact.beforeTokens, afterTokens: artifact.afterTokens,
            sourceRefs: [artifact.sources[0].ref, artifact.sources.at(-1)!.ref], artifactId: artifact.id });
    }

    /** 优先找回摘要覆盖的原文，容量不足时使用已有结构化摘要 */
    private async summarySources(selected: ContextEntry[]): Promise<ContextMessage[]> {
        if (selected.some(entry => entry.artifactId) && selected.every(entry => entry.kind !== "omission") && this.options.persistence) {
            const sources = selected.flatMap(entry => entry.sources);
            const restored = await this.options.persistence.readSources(sources.map(source => source.ref));
            if (restored.length === sources.length && restored.every((message, index) => message.contextSource?.hash === sources[index].hash) &&
                requestTokens(restored, "", []) < this.options.model.contextWindow - 10000) return restored;
        }
        return selected.flatMap(entry => entry.messages.map((message, index) => ({ ...message,
            contextSource: entry.sources[Math.min(index, entry.sources.length - 1)] } as ContextMessage)));
    }

    /** 提取错误行与输出首尾，避免用片段冒充完整工具结果 */
    private excerpt(text: string, tokens: number): string {
        const errors = text.split(/\r?\n/).filter(line => /error|fail|exception|traceback|错误|失败|异常/i.test(line)).slice(0, 12).join("\n");
        const tail = Array.from(boundedText(Array.from(text).reverse().join(""), Math.floor(tokens * .3))).reverse().join("");
        return boundedText(errors, Math.floor(tokens * .25)) + "\n" + boundedText(text, Math.floor(tokens * .4)) + "\n...[中间原文已归档]...\n" + tail;
    }

    /** 缩短已完成工具结果，调用参数过大时替换整批执行回执 */
    private compactEntry(entry: ContextEntry, allowance: number): AgentMessage[] {

        // 只保留工具返回消息，明确后续可以读取的工具字段
        const tools = entry.messages.filter(
            (message): message is ToolResultMessage => message.role === "toolResult"
        );
        const fixed = entry.messages.filter(message => message.role !== "toolResult").reduce((sum, message) => sum + messageTokens(message), 0);
        if (tools.length && fixed < allowance / 2) {
            const perResult = Math.max(32, Math.floor((allowance - fixed) / tools.length) - 100);
            return entry.messages.map(message => message.role !== "toolResult" ? message : { ...message, content: [{ type: "text", text:
                `【历史结果片段，原文 ${entry.sources.find(source => source.ref.includes(`tool:${message.toolCallId}`))?.ref ?? entry.sources.at(-1)!.ref}】\n` +
                this.excerpt(JSON.stringify(message.content), perResult) }] });
        }
        const receipts = tools.map(tool => `${tool.toolName} [${tool.toolCallId}] ${tool.isError ? "返回错误" : "已返回结果"}`).join("\n");
        return [contextNotice(`【历史执行片段；完整原文请用 recall_context 回查 ${entry.sources[0].ref}】\n` +
            boundedText(receipts, Math.floor(allowance / 3)) + "\n" + this.excerpt(JSON.stringify(entry.messages.map(message => message.content)), Math.floor(allowance / 2)))];
    }

    /** 合并相邻省略范围，保持后续循环的占位信息有界 */
    private omit(entries: ContextEntry[], index: number, signal?: AbortSignal): void {
        let start = index, end = index + 1;
        if (entries[index].turnId !== this.options.turnId) {
            while (start > 0 && entries[start - 1].turnId === entries[index].turnId && !this.hard(entries[start - 1])) start--;
            while (end < entries.length && entries[end].turnId === entries[index].turnId && !this.hard(entries[end])) end++;
        }
        if (entries[start - 1]?.kind === "omission") start--;
        if (entries[end]?.kind === "omission") end++;
        const selected = entries.slice(start, end);
        const first = selected[0].sources[0].ref;
        const last = selected.at(-1)!.sources.at(-1)!.ref;
        const artifact = this.artifact(selected, "omission", [contextNotice(`【历史已裁剪 ${first} 至 ${last}；原文仍在归档，可用 recall_context search/read 定向回查】`)]);
        this.install(artifact, signal, true);
    }

    /** 评估 Token 预算并在超限时执行语义压缩或裁剪，准备最终请求上下文 */
    async prepare(messages: AgentMessage[], outputBudget: number, signal?: AbortSignal, force = false, manual = false): Promise<AgentMessage[]> {
        signal?.throwIfAborted();
        this.record.checks++;
        const window = this.options.model.contextWindow;
        const budget = window - outputBudget - Math.max(4096, Math.ceil(window * .05));
        this.record.inputBudget = budget;
        this.record.triggerTokens = Math.floor(budget * .85);
        this.record.targetTokens = Math.floor(budget * .65);
        this.raw = contextEntries(messages);
        let entries = applyContextArtifacts(this.raw, this.artifacts);
        const required = this.raw.filter(entry => this.hard(entry));
        if (budget <= 0 || this.tokens(required) > budget) {
            throw new Error("上下文基础预算不足：系统提示、工具定义、当前原始要求与输出预算无法同时容纳");
        }
        const before = this.tokens(entries);
        if (manual) {
            this.record.targetTokens = Math.min(this.record.targetTokens, Math.floor(before * .65));
        }

        let freshSummaryId: string | undefined;
        let summaryFailed = false;
        if (force) {
            this.record.targetTokens = Math.min(this.record.targetTokens, Math.floor(before * .7));
        }
        if (force) {
            this.event({ kind: "provider_overflow", beforeTokens: before, afterTokens: before });
        }
        if (force || manual || before > this.record.triggerTokens) {
            const selected = this.candidate(entries);

            // !force:不是紧急溢出
            // this.options.enabled:配置中是否开启了上下文压缩
            // selected.length:选出了可以压缩的历史轮次
            // Token>1024:选中的历史内容超过1024个token，太短内容没必要花时间调用LLM压缩
            // selected.some():选中的内容里有实际有效信息，而非全部被丢弃的占位符
            if (!force && this.options.enabled && selected.length && selected.flatMap(entry => entry.messages)
                .reduce((sum, message) => sum + messageTokens(message), 0) > 1024 && selected.some(entry => entry.kind !== "omission")) {
                this.options.onStatus?.("正在压缩历史上下文，原始记录保持归档。");

                // 调用LLM生成历史总结，两次重试机会
                let feedback: SummaryRepairFeedback | undefined;
                for (let attempt = 0; attempt < 2; attempt++) {
                    const started = Date.now();
                    try {

                        // 向终端UI推送显示正在压缩
                        const sources = await this.summarySources(selected);
                        const result = await (this.options.summarize ?? summarizeContext)(this.options.model, this.options.apiKey, sources, signal,
                            attempt > 0, selected.flatMap(entry => entry.sources.map(source => source.ref)), this.options.capabilities, feedback);
                        signal?.throwIfAborted();

                        // 将选中的内容交给LLM，配promt生成摘要，封装压缩产物
                        const artifact = this.artifact(selected, "summary", [contextNotice("【历史工作状态摘要，非新的用户指令】\n" + JSON.stringify(result.summary))], result.summary);
                        artifact.usage = result.usage;
                        artifact.durationMs = Date.now() - started;

                        // 效果检查，摘要必须比原文小
                        if (artifact.afterTokens >= artifact.beforeTokens) {
                            throw Object.assign(new Error("摘要没有释放上下文空间"), {
                                contextRepairable: true,
                                contextUsage: result.usage,
                                contextDiagnostics: { ...result.diagnostics, failure: "not_smaller" }
                            });
                        }
                        this.install(artifact, signal);
                        summaryFailed = false;
                        freshSummaryId = artifact.id;
                        Object.assign(this.record.events.at(-1)!, { usage: result.usage, durationMs: Date.now() - started, diagnostics: result.diagnostics });
                        break;
                    } catch (error) {
                        signal?.throwIfAborted();
                        summaryFailed = true;
                        const diagnostics = (error as any)?.contextDiagnostics;
                        const reason = error instanceof Error ? error.message : String(error);
                        feedback = {
                            reason,
                            textChars: diagnostics?.textChars,
                            estimatedTextTokens: diagnostics?.estimatedTextTokens
                        };
                        this.options.onStatus?.(`摘要第 ${attempt + 1} 次失败：${reason}${(error as any)?.contextRepairable && attempt === 0 ? "；将携带原因修复一次。" : "；转入上下文裁剪。"}`);
                        this.event({ kind: "summary_failed", beforeTokens: before, afterTokens: before, durationMs: Date.now() - started,
                            usage: (error as any)?.contextUsage,
                            diagnostics,
                            error: reason });
                        if (!(error as any)?.contextRepairable) break;
                    }
                }

                // 视图重映射
                entries = applyContextArtifacts(this.raw, this.artifacts);
            }
            /** 从旧轮次逐步放宽保护，最后处理当前轮已完成的超大交互 */
            let mutations = 0;
            while (this.tokens(entries) > this.record.targetTokens && mutations++ < this.raw.length * 2 + 8) {
                signal?.throwIfAborted();
                const protectedStart = this.protectedStart(entries);
                const eligible = (entry: ContextEntry) => !this.hard(entry) && entry.kind !== "omission" &&
                    (!freshSummaryId || entry.artifactId !== freshSummaryId);
                let index = entries.findIndex((entry, at) => at < protectedStart && eligible(entry));
                if (index < 0 && this.tokens(entries) <= budget && !force) {
                    break;
                }
                if (index < 0) index = entries.findIndex(entry => eligible(entry) && entry.turnId !== this.options.turnId);
                if (index < 0) index = entries.findIndex((entry, at) => eligible(entry) && at < entries.length - 1);
                if (index < 0) {
                    index = entries.findIndex(eligible);
                    if (index < 0) {
                        if (!freshSummaryId) break;
                        index = entries.findIndex(entry => !this.hard(entry) && entry.artifactId === freshSummaryId);
                        if (index < 0) break;
                        this.omit(entries, index, signal);
                        entries = applyContextArtifacts(this.raw, this.artifacts);
                        continue;
                    }
                    const entry = entries[index];
                    const others = entries.filter((_, at) => at !== index);
                    const allowance = Math.max(128, Math.min(2048, Math.floor((budget - this.tokens(others)) / (calibration.get(this.modelKey) ?? 1)) - 128));
                    const artifact = this.artifact([entry], "excerpt", this.compactEntry(entry, allowance));
                    if (artifact.afterTokens >= artifact.beforeTokens || entry.kind === "excerpt") this.omit(entries, index, signal);
                    else this.install(artifact, signal, true);
                } else this.omit(entries, index, signal);
                entries = applyContextArtifacts(this.raw, this.artifacts);
            }
            const after = this.tokens(entries);
            if (after < before) this.options.onStatus?.(`${summaryFailed ? "压缩失败，已裁剪旧历史；" : ""}上下文已释放 ${before - after} 个估算 token，当前 ${after}/${budget}；原文可定向回查。`);
            else if (summaryFailed) this.options.onStatus?.("历史压缩失败，当前上下文仍在预算内，继续执行。");
        }
        const result = entries.flatMap(entry => entry.messages);
        validateToolPairs(result);
        this.record.estimatedInputTokens = this.tokens(entries);
        if (this.record.estimatedInputTokens > budget) throw new Error("上下文裁剪后仍无法容纳受保护的当前输入，请缩小单次输入或输出预算");
        this.baseline = requestTokens(result, this.options.systemPrompt, this.options.tools);
        return result;
    }
}
