import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple, type AssistantMessage, type ImageContent, type Model } from "@mariozechner/pi-ai";
import type { AgentExecutionStep, ExecutionRecord, GenerationAttempt, GenerationCall, GenerationUsage, RunStatus } from "./types";
import { toolRegistry } from "./tools/registry";
import { permissionManager, READ_TOOLS } from "./runtime/permission-manager";
import { generationPolicy, isMiMoModel, type GenerationPolicy, type ReasoningEffort } from "./runtime/generation-policy";
import { ContextCoordinator } from "./context/coordinator";
import { sourceMessage, type ContextMessage, type ContextPersistence } from "./context/types";
import { historyToolId, restoreRecordedMessages } from "./context/history";
import { prepareModelRequest } from "./runtime/model-adapter";
import { salvageResponse, composeReply, composeIncompleteReport, type ResponseQuality, type SalvagedContent } from "./runtime/response-salvager";
import {
    detectTruncationStage,
    buildRecoveryPrompt,
    aggregateTextChunks
} from "./runtime/truncation-recovery";

export interface RunnerOptions extends Partial<GenerationPolicy> {
    baseUrl: string;
    model: string;
    apiKey: string;
    reasoningEffort?: ReasoningEffort;
    contextWindow?: number;
    compactionEnabled?: boolean;
    contextPersistence?: ContextPersistence;
    currentTurnId?: number;
    currentTurnNo?: number;
    userMessageId?: number;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    tools?: AgentTool<any>[];
    onStep?: (step: AgentExecutionStep) => void;
    onAskPermission?: (prompt: string) => Promise<boolean>;
    onExecution?: (snapshot: ExecutionRecord, settledSteps?: AgentExecutionStep[]) => void;
    signal?: AbortSignal;
}

export interface RunnerOutput {
    reply: string;
    modelReply: string;
    steps: AgentExecutionStep[];
    contextSteps: AgentExecutionStep[];
    newMessages: AgentMessage[];
    totalDurationMs: number;
    status: RunStatus;
    stopReason?: string;
    isTruncated: boolean;
    execution: ExecutionRecord;
    responseQuality: ResponseQuality;
    salvaged: SalvagedContent;
}

/** 提取指定助手消息中的正文 */
const textOf = (message?: AssistantMessage): string => message?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
/** 创建未获得供应商统计时的用量记录 */
const unknownUsage = (): GenerationUsage => ({ inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, totalTokens: null });

/** 将 SDK 用量转换为包含缓存输入的执行统计 */
function usageOf(message: AssistantMessage): GenerationUsage {
    const usage = message.usage;
    if (!usage || usage.totalTokens <= 0) return unknownUsage();
    return {
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
        reasoningTokens: null, cacheReadTokens: usage.cacheRead, totalTokens: usage.totalTokens
    };
}

export class AgentRunner {
    private readonly policy: GenerationPolicy;
    private readonly tools: AgentTool<any>[];
    private readonly systemPrompt: string;
    private readonly contextWindow: number;
    private readonly steps: AgentExecutionStep[] = [];
    private persistenceError?: string;
    private originalUser?: AgentMessage;
    private contextCoordinator?: ContextCoordinator;

    /** 保存本轮模型连接与生成策略 */
    constructor(private readonly options: RunnerOptions) {
        this.policy = generationPolicy(options, options.model);
        this.tools = options.tools ?? toolRegistry.getAll();
        this.systemPrompt = options.systemPrompt ?? "你是一个具备工具调用能力的专业 AI 助手，在需要时自主使用工具解决问题。";
        this.contextWindow = options.contextWindow ?? 128000;
    }

    /**
     * 记录并推送带尝试编号的执行事件
     * @param step 排除时间字段
     */
    private emit(step: Omit<AgentExecutionStep, "timestamp">): void {
        // 新建对象，浅拷贝step字段值，并且补齐timestamp字段值
        const event = { ...step, timestamp: Date.now() };
        // 将事件推入steps中
        this.steps.push(event);
        // 回调onStep函数
        this.options.onStep?.(event);
    }

    /** 提取错误说明并清除当前接口密钥 */
    private safeError(error: unknown): string {
        const text = error instanceof Error ? error.message : String(error);
        return this.options.apiKey ? text.split(this.options.apiKey).join("[REDACTED]") : text;
    }

    /** 为循环中新生成的工具结果与恢复指令绑定稳定来源 */
    private annotateCurrent(messages: AgentMessage[], summary: GenerationAttempt): void {
        for (const message of messages as ContextMessage[]) {
            if (message.contextSource) continue;
            let ref = `t:${this.options.currentTurnId ?? 0}:recovery:${summary.attemptNo}`;
            if (message.role === "toolResult") {
                const ids = /^dusk_a(\d+)_c(\d+)_/.exec(message.toolCallId);
                ref = `t:${this.options.currentTurnId ?? 0}:a:${ids?.[1] ?? summary.attemptNo}:c:${ids?.[2] ?? summary.calls.at(-1)?.callNo ?? 1}:tool:${message.toolCallId}`;
            } else if (message === this.originalUser) ref = this.options.userMessageId ? `m:${this.options.userMessageId}` : `t:${this.options.currentTurnId ?? 0}:user`;
            sourceMessage(message, ref, this.options.currentTurnId, this.options.currentTurnNo);
        }
    }

    /** 充当安全沙箱与治理中枢，在每一次独立的 ReAct 周期内，
     * 负责上下文自动压缩、工具执行权限拦截、检查点落库、流式事件转译与异常数据打捞。*/
    private async attempt(
        prompt: string,
        images: ImageContent[] | undefined,
        history: AgentMessage[],
        summary: GenerationAttempt,
        execution: ExecutionRecord,
        onCallCompleted: (settledSteps?: AgentExecutionStep[]) => void,
        overrideEffort?: ReasoningEffort
    ): Promise<{ messages: AgentMessage[]; modelReply: string; salvaged: SalvagedContent }> {
        const began = Date.now();
        const effort = overrideEffort ?? this.options.reasoningEffort ?? "high";
        let originalLength: GenerationCall | undefined;
        const starts = new Map<string, number>();
        const toolSteps = new Map<string, AgentExecutionStep>();
        const originalIndex = history.indexOf(this.originalUser);
        const oldHistoryLength = originalIndex < 0 ? history.length : originalIndex;
        let agent: Agent;
        /** 在实际工具调用前记录可能发生的副作用 */
        const tools = this.tools.map(tool => ({
            ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => {
                if (args[2]?.aborted || this.options.signal?.aborted || originalLength || this.persistenceError) {
                    throw new Error("生成已终止，禁止执行工具");
                }
                if (!READ_TOOLS.has(tool.name)) {
                    summary.sideEffectStarted = true;
                    const call = summary.calls.at(-1);
                    if (call) {
                        call.sideEffectStarted = true;
                    }
                }
                execution.pendingToolCallIds.push(args[0]);
                /** 执行工具前先保存待结算状态，写库失败时禁止产生副作用 */
                onCallCompleted();
                return tool.execute(...args);
            }
        }));
        const model: Model<"openai-completions"> = {
            id: this.options.model,
            name: this.options.model,
            api: "openai-completions",
            provider: "openai",
            baseUrl: this.options.baseUrl.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/i, ""),
            reasoning: effort !== "off", input: ["text", "image"],
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0
            },
            contextWindow: this.contextWindow,
            maxTokens: summary.maxTokens,
            headers: {
                Authorization: `Bearer ${this.options.apiKey}`
            }
        };
        this.contextCoordinator ??= new ContextCoordinator({
            model,
            apiKey: this.options.apiKey,
            systemPrompt: this.systemPrompt,
            tools: this.tools,
            turnId: this.options.currentTurnId ?? 0,
            enabled: this.options.compactionEnabled !== false,
            persistence: this.options.contextPersistence,
            onStatus: content => this.emit({ type: "status", content })
        });
        execution.context = this.contextCoordinator.record;
        /** 包装单次模型流，显式传递预算、思考开关和取消信号 */
        const streamFn: StreamFn = (callModel, context, options) => {
            if (options.signal?.aborted || this.options.signal?.aborted || originalLength || this.persistenceError) {
                throw new Error("生成已终止");
            }
            const stream = createAssistantMessageEventStream();
            const controller = new AbortController();
            /** 将 Agent 取消信号转发给当前模型请求 */
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            let callStart = 0;
            let lastTokenTime = Date.now();
            let partial: AssistantMessage | undefined;
            let dirty = false;
            const call: GenerationCall = {
                phase: "streaming",
                callNo: summary.calls.length + 1,
                maxTokens: summary.maxTokens,
                status: "failed",
                durationMs: 0,
                usage: unknownUsage(),
                thinkingChars: 0,
                hasText: false,
                toolCallCount: 0,
                sideEffectStarted: false
            };
            summary.calls.push(call);
            let timedOut = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const progress = setInterval(() => {
                if (callStart && Date.now() - lastTokenTime >= 20000) {
                    this.emit({
                        type: "status", attemptNo: summary.attemptNo,
                        content: `模型生成中，已等待 ${Math.floor((Date.now() - callStart) / 1000)} 秒；输出预算 ${summary.maxTokens} token`
                    });
                }
            }, 30000);
            /** 保存供应商返回的完整消息与本次调用统计 */
            const captureResponse = (message: AssistantMessage): void => {
                call.phase = "finished";
                call.response = structuredClone(message);
                if (call.response.errorMessage) {
                    call.response.errorMessage = this.safeError(call.response.errorMessage);
                }
                call.stopReason = message.stopReason;
                call.usage = usageOf(message);
                call.hasText = Boolean(textOf(message));
                call.thinkingChars = message.content.reduce((sum, block) =>
                    sum + (block.type === "thinking" ? block.thinking.length : 0), 0);
                call.toolCallCount = message.content.filter(block => block.type === "toolCall").length;
                call.status = timedOut ? "timeout" : message.stopReason === "length" ? "truncated" :
                    message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "aborted" :
                        call.hasText || call.toolCallCount ? "completed" : "empty";
                if (message.errorMessage) {
                    call.error = this.safeError(message.errorMessage);
                }
                if (message.stopReason === "length") {
                    originalLength = call;
                }
                call.durationMs = callStart ? Date.now() - callStart : 0;
                summary.status = call.status;
                summary.stopReason = call.stopReason;
                summary.error = call.error;
                summary.durationMs = Date.now() - began;
                if ((message.stopReason === "stop" || message.stopReason === "toolUse" || message.stopReason === "length") &&
                    !execution.effectiveCallRefs.some(ref => ref.attemptNo === summary.attemptNo && ref.callNo === call.callNo)) {
                    execution.effectiveCallRefs.push({ attemptNo: summary.attemptNo, callNo: call.callNo });
                }
            };
            /** 定期保存收到的流片段，不把 SDK 的临时 stop 标记当成完成 */
            const checkpoint = setInterval(() => {
                if (!dirty || !partial || call.phase !== "streaming" || this.persistenceError) return;
                dirty = false;
                call.response = structuredClone(partial);
                call.durationMs = Date.now() - callStart;
                call.thinkingChars = partial.content.reduce((sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0), 0);
                call.hasText = Boolean(textOf(partial));
                call.toolCallCount = partial.content.filter(block => block.type === "toolCall").length;
                summary.durationMs = Date.now() - began;
                try { onCallCompleted(); } catch { controller.abort(); }
            }, 2000);
            void (async () => {
                try {
                    /** 原文先落库，再为每次循环准备压缩或裁剪后的请求视图 */
                    onCallCompleted();
                    if (summary.attemptNo === 1 && call.callNo === 1) {
                        this.originalUser = context.messages[oldHistoryLength];
                    }
                    this.annotateCurrent(context.messages, summary);

                    // 判断是否需要进行压缩，需要时则阻塞压缩，并向UI推送“正在压缩的消息
                    let fitted = await this.contextCoordinator.prepare(context.messages, summary.maxTokens, controller.signal);

                    controller.signal.throwIfAborted();
                    onCallCompleted();
                    /** 上下文准备完毕后才启动主模型的生成超时 */
                    callStart = lastTokenTime = Date.now();
                    if (this.policy.generationTimeoutMs) timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.policy.generationTimeoutMs);
                    for (let overflowRetry = 0; overflowRetry < 2; overflowRetry++) {
                        const request = prepareModelRequest({ ...context, messages: fitted }, callModel, effort, options.onPayload);
                        const source = streamSimple(
                            callModel,
                            request.context, {
                            ...options,
                            signal: controller.signal,
                            maxTokens: summary.maxTokens,
                            maxRetries: 0,
                            timeoutMs: this.policy.generationTimeoutMs && this.policy.generationTimeoutMs > 0 ? this.policy.generationTimeoutMs : undefined,
                            onPayload: request.onPayload
                        });
                        let overflow = false;
                        let pendingStart: { type: "start"; partial: AssistantMessage } | undefined;
                        for await (const event of source) {
                            lastTokenTime = Date.now();
                            if (event.type === "start") {
                                pendingStart = event;
                                continue;
                            }
                            if ("partial" in event) { partial = event.partial; dirty = true; }
                            if (event.type === "done" || event.type === "error") {
                                const message = await source.result();
                                if (overflowRetry === 0 && message.stopReason === "error" && !message.content.length &&
                                    /context.{0,40}(length|window|limit)|maximum context|too many tokens|prompt.{0,30}(too long|tokens)|上下文.*(超|长)/i.test(message.errorMessage ?? "")) {
                                    overflow = true;
                                    break;
                                }
                                partial = message;
                                if (pendingStart) { stream.push(pendingStart); pendingStart = undefined; }
                                captureResponse(message);
                                this.contextCoordinator.observe(call.usage.inputTokens ?? 0);
                                /** 先持久化完整响应，再让 Agent 继续执行工具或下一次请求 */
                                onCallCompleted();
                                if (event.type === "done") {
                                    const delivered = structuredClone(message);
                                    /** 截断调用只归档；给 Pi 完整临时副本使循环自然停止 */
                                    delivered.content = delivered.content.filter(block => block.type !== "toolCall" || message.stopReason !== "length");
                                    for (const block of delivered.content) {
                                        if (block.type === "toolCall") block.id = historyToolId(summary.attemptNo, call.callNo, block.id);
                                    }
                                    sourceMessage(delivered, `t:${this.options.currentTurnId ?? 0}:a:${summary.attemptNo}:c:${call.callNo}`,
                                        this.options.currentTurnId, this.options.currentTurnNo);
                                    stream.push({ ...event, message: delivered });
                                    continue;
                                }
                            }
                            if (pendingStart) { stream.push(pendingStart); pendingStart = undefined; }
                            stream.push(event);
                        }
                        if (!overflow) break;

                        // 判断是否需要进行压缩，需要时则阻塞压缩，并向UI推送“正在压缩的消息
                        fitted = await this.contextCoordinator.prepare(context.messages, summary.maxTokens, controller.signal, true);
                        onCallCompleted();
                    }
                } catch (error) {
                    call.phase = "finished";
                    call.status = timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "failed";
                    call.stopReason = controller.signal.aborted ? "aborted" : "error";
                    call.error = this.persistenceError ?? this.safeError(error);
                    const message: AssistantMessage = {
                        role: "assistant",
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        content: structuredClone(partial?.content ?? []),
                        timestamp: Date.now(),
                        stopReason: call.stopReason as "error" | "aborted",
                        errorMessage: call.error,
                        usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 0,
                            cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: 0
                            }
                        }
                    };
                    if (partial?.usage) message.usage = structuredClone(partial.usage);
                    if (!this.persistenceError) {
                        captureResponse(message);
                        try { onCallCompleted(); } catch { /* 持久化错误统一交由本轮结束状态处理。 */ }
                    }
                    if (this.persistenceError) {
                        call.status = "failed";
                        call.error = this.persistenceError;
                        message.stopReason = "error";
                        message.errorMessage = this.persistenceError;
                    }
                    stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
                } finally {
                    call.durationMs = callStart ? Date.now() - callStart : 0;
                    if (timeout) clearTimeout(timeout);
                    clearInterval(progress);
                    clearInterval(checkpoint);
                    options.signal?.removeEventListener("abort", abort);
                    stream.end();
                }
            })();
            return stream;
        };
        agent = new Agent({
            initialState: { systemPrompt: this.systemPrompt, model, tools, messages: history, thinkingLevel: effort },
            getApiKey: () => this.options.apiKey, streamFn,
            beforeToolCall: async context => {
                if (this.persistenceError) {
                    agent.abort();
                    return { block: true, reason: this.persistenceError };
                }
                if (this.options.signal?.aborted) return { block: true, reason: "任务已取消，禁止执行后续工具" };
                if (originalLength || context.assistantMessage.stopReason === "length") {
                    return { block: true, reason: "工具调用来自被截断的生成，已阻止执行" };
                }
                const check = await permissionManager.checkToolPermission(context.toolCall.name, context.args as Record<string, any>, this.options.onAskPermission);
                return check.allowed ? undefined : { block: true, reason: check.reason ?? "权限不足" };
            }
        });
        let currentTurnNo = 1;
        let thinkingStart = 0;
        agent.subscribe(event => {
            if (event.type === "turn_start") {
                this.emit({
                    type: "turn_start",
                    attemptNo: summary.attemptNo,
                    turnNo: currentTurnNo
                });
            } else if (event.type === "message_update") {
                const assistantEvent = (event as any).assistantMessageEvent;
                if (assistantEvent) {
                    if (assistantEvent.type === "thinking_start") {
                        thinkingStart = Date.now();
                    } else if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
                        if (!thinkingStart) thinkingStart = Date.now();
                        this.emit({
                            type: "thinking_delta",
                            attemptNo: summary.attemptNo,
                            turnNo: currentTurnNo,
                            delta: assistantEvent.delta
                        });
                    } else if (assistantEvent.type === "thinking_end") {
                        const duration = thinkingStart ? Date.now() - thinkingStart : 0;
                        this.emit({
                            type: "thought",
                            attemptNo: summary.attemptNo,
                            turnNo: currentTurnNo,
                            content: assistantEvent.content,
                            durationMs: duration
                        });
                        thinkingStart = 0;
                    }
                }
            } else if (event.type === "message_end" && event.message.role === "assistant") {
                const assistantMsg = event.message as AssistantMessage;
                // 若有未闭合的思考块，补发思考结束事件
                if (thinkingStart > 0) {
                    this.emit({
                        type: "thought",
                        attemptNo: summary.attemptNo,
                        turnNo: currentTurnNo,
                        durationMs: Date.now() - thinkingStart
                    });
                    thinkingStart = 0;
                }

                // 提取助手发言，若本轮有工具调用且产生非空文本说明，作为中间回复派发
                const hasToolCalls = assistantMsg.content.some(b => b.type === "toolCall");
                const text = textOf(assistantMsg);
                if (hasToolCalls && text) {
                    this.emit({
                        type: "intermediate_text",
                        attemptNo: summary.attemptNo,
                        turnNo: currentTurnNo,
                        content: text
                    });
                }
            } else if (event.type === "tool_execution_start") {
                starts.set(event.toolCallId, Date.now());
                toolSteps.set(event.toolCallId, {
                    type: "tool_call", attemptNo: summary.attemptNo, callNo: summary.calls.at(-1)?.callNo,
                    turnNo: currentTurnNo, toolName: event.toolName, toolCallId: event.toolCallId,
                    args: event.args, timestamp: Date.now()
                });
                this.emit({
                    type: "tool_call",
                    attemptNo: summary.attemptNo,
                    callNo: summary.calls.at(-1)?.callNo,
                    turnNo: currentTurnNo,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    args: event.args
                });
            } else if (event.type === "tool_execution_end") {
                const resultStep: AgentExecutionStep = {
                    type: "tool_result",
                    attemptNo: summary.attemptNo,
                    callNo: summary.calls.at(-1)?.callNo,
                    turnNo: currentTurnNo,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    result: event.result,
                    isError: event.isError,
                    durationMs: Date.now() - (starts.get(event.toolCallId) ?? Date.now()),
                    timestamp: Date.now()
                };
                this.emit(resultStep);
                execution.pendingToolCallIds = execution.pendingToolCallIds.filter(id => id !== event.toolCallId);
                /** 工具结果先落库，再允许循环发起下一次请求 */
                onCallCompleted([toolSteps.get(event.toolCallId)!, resultStep]);
                starts.delete(event.toolCallId);
            } else if (event.type === "turn_end") {
                this.emit({
                    type: "turn_end",
                    attemptNo: summary.attemptNo,
                    turnNo: currentTurnNo
                });
                currentTurnNo++;
            }
        });
        /** 将外部取消信号传递到活动模型请求和工具循环 */
        const abortRun = () => agent.abort();
        this.options.signal?.addEventListener("abort", abortRun, { once: true });
        const startIndex = history.length;
        try {
            if (this.options.signal?.aborted) {
                summary.status = "aborted";
            }
            else {
                // 调用Pi的内层loop循环，请求模型->执行工具->把结果塞给上下文->再次请求模型
                await agent.prompt(prompt, images);
            }
        }
        catch (error) { summary.error = this.safeError(error); }
        finally { this.options.signal?.removeEventListener("abort", abortRun); }
        const messages = agent.state.messages.slice(startIndex);
        const lastAssistant = messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
        const lastCall = summary.calls.at(-1);
        const runtimeError = agent.state.errorMessage || lastAssistant?.errorMessage;
        summary.status = this.persistenceError ? "failed" : this.options.signal?.aborted ? "aborted" : originalLength ? "truncated" : lastCall?.status === "timeout" ? "timeout" :
            runtimeError && lastAssistant?.stopReason !== "aborted" ? "failed" : lastCall?.status ?? "failed";
        summary.stopReason = originalLength ? "length" : lastCall?.stopReason;
        summary.error = this.persistenceError ?? summary.error ?? (runtimeError ? this.safeError(runtimeError) : lastCall?.error);
        if (summary.status === "completed" && !textOf(lastAssistant)) {
            summary.status = "empty";
        }
        summary.durationMs = Date.now() - began;

        // 始终打捞模型产出，无论 finish_reason 是什么
        const salvaged = salvageResponse(messages, summary);
        const modelReply = salvaged.text;
        return { messages, modelReply, salvaged };
    }



    
    /** 编排保留本轮进展的截断恢复并保存执行检查点 */
    public async run(prompt: string, images?: ImageContent[]): Promise<RunnerOutput> {
        const started = Date.now();
        this.steps.length = 0;
        this.persistenceError = undefined;
        this.contextCoordinator = undefined;
        this.originalUser = {
            role: "user", timestamp: started,
            content: images?.length ? [{ type: "text", text: prompt }, ...images] : prompt
        };
        const execution: ExecutionRecord = {
            phase: "running", status: "failed", effectiveCallRefs: [], pendingToolCallIds: [],
            config: {
                ...this.policy, model: this.options.model,
                requestedReasoningEffort: this.options.reasoningEffort ?? "high",
                contextWindow: this.contextWindow,
                thinking: isMiMoModel(this.options.model) ? (this.options.reasoningEffort === "off" ? "disabled" : "enabled") : "sdk-default"
            },
            attempts: [], recoverySteps: [], totalDurationMs: 0
        };
        const settledSteps: AgentExecutionStep[] = [];
        /** 保存执行快照与本次新增的已结算工具步骤 */
        const persistExecution = (newSteps: AgentExecutionStep[] = []): void => {
            settledSteps.push(...newSteps);
            execution.status = execution.attempts.at(-1)?.status ?? "failed";
            execution.totalDurationMs = Date.now() - started;
            try {
                this.options.onExecution?.(structuredClone(execution), structuredClone(newSteps));
            } catch (error) {
                this.persistenceError = "执行记录持久化失败: " + this.safeError(error);
                throw new Error(this.persistenceError);
            }
        };
        /** 通过统一投影还原跨恢复尝试的有效本轮消息 */
        const currentMessages = (): AgentMessage[] => restoreRecordedMessages({
            turn: { id: this.options.currentTurnId, turnNo: this.options.currentTurnNo, executionJson: execution },
            messages: settledSteps.filter(step => step.type === "tool_result").map(step => ({
                role: "tool_result", createdAt: step.timestamp,
                content: JSON.stringify({
                    id: step.toolCallId, tool: step.toolName, attemptNo: step.attemptNo, callNo: step.callNo,
                    result: step.result, isError: step.isError
                })
            }))
        }) ?? [];
        const maxRecoveryAttempts = 2;
        const maxTokens = Math.min(this.policy.maxTokens, this.policy.retryMaxTokens);
        let activePrompt = prompt;
        let effort = this.options.reasoningEffort ?? "high";
        let latestSalvaged: SalvagedContent;
        let messages: AgentMessage[] = [];
        let contextError = "";
        let continuation = false;
        let chunks: string[] = [];

        // 外层自愈循环：用于解决超长输时的模型截断自动续写与自愈
        while (true) {
            const summary: GenerationAttempt = {
                attemptNo: execution.attempts.length + 1, maxTokens,
                status: "failed", durationMs: 0, sideEffectStarted: false, calls: []
            };
            execution.attempts.push(summary);
            execution.phase = "running";
            try { persistExecution(); }
            catch { contextError = this.persistenceError; break; }
            const history = summary.attemptNo === 1 ? this.options.initialMessages ?? [] :
                [...this.options.initialMessages ?? [], this.originalUser, ...currentMessages()];

            // 
            const result = await this.attempt(activePrompt, summary.attemptNo === 1 ? images : undefined,
                history, summary, execution, persistExecution, effort);
            
            messages = result.messages;
            latestSalvaged = result.salvaged;
            if (latestSalvaged.text) {
                if (continuation) chunks.push(latestSalvaged.text);
                else chunks = [latestSalvaged.text];
            }
            if (this.persistenceError) { contextError = this.persistenceError; break; }
            try { persistExecution(); }
            catch { contextError = this.persistenceError; break; }

            const previousRecovery = execution.recoverySteps.at(-1);
            if (previousRecovery) previousRecovery.success = summary.status === "completed";
            if (summary.status !== "truncated") {
                if (execution.pendingToolCallIds.length) contextError = "存在执行结果未知的工具操作，已停止自动恢复。";
                break;
            }
            summary.recoveryStage = detectTruncationStage(messages, summary);
            if (this.options.signal?.aborted || execution.pendingToolCallIds.length) {
                contextError = execution.pendingToolCallIds.length ? "存在执行结果未知的工具操作，已停止自动恢复。" : "";
                break;
            }
            const recoveryCount = execution.recoverySteps.length;
            if (recoveryCount >= maxRecoveryAttempts) break;

            const stage = summary.recoveryStage;
            continuation = stage === "text";
            effort = "off";
            activePrompt = buildRecoveryPrompt(stage);
            const action = stage === "thinking" ? "checkpoint_continue" : stage === "text" ? "text_continuation" : "retry_tool_call";
            summary.recoveryAction = action;
            execution.recoverySteps.push({
                recoveryAttemptNo: recoveryCount + 1, stage, actionTaken: action,
                previousTokens: maxTokens, newTokens: maxTokens,
                accumulatedTextLength: aggregateTextChunks(chunks).length,
                success: false, note: activePrompt
            });
            execution.phase = "recovering";
            /** 决策先落库，再进入下一次请求 */
            try { persistExecution(); }
            catch { contextError = this.persistenceError; break; }
            const stageName = stage === "tool_call" ? "工具参数" : stage === "text" ? "正文" : "思考";
            this.emit({
                type: "status", attemptNo: summary.attemptNo,
                content: stageName + "达到单次输出上限，保留本轮进展并请求关闭思考继续（" +
                    (recoveryCount + 1) + "/" + maxRecoveryAttempts + "，预算 " + maxTokens + " token）。"
            });
        }

        const last = execution.attempts.at(-1);
        execution.phase = "finished";
        if (contextError) {
            execution.error = contextError;
            if (this.persistenceError || last?.status !== "truncated") {
                if (last) last.status = "failed";
            }
        }
        if (this.options.signal?.aborted && !this.persistenceError && last) last.status = "aborted";
        if (last?.error && !execution.error) execution.error = last.error;
        if (!this.persistenceError) {
            try { persistExecution(); } catch { /* 下方统一返回持久化失败。 */ }
        }
        execution.totalDurationMs = Date.now() - started;
        execution.status = this.persistenceError ? "failed" : last?.status ?? "failed";
        if (this.persistenceError) execution.error = this.persistenceError;
        const modelReply = aggregateTextChunks(chunks);
        const finalSalvaged = latestSalvaged ?? salvageResponse(messages, last);
        if (modelReply) {
            finalSalvaged.text = modelReply;
            finalSalvaged.hasUsableContent = true;
            if (execution.status !== "completed") finalSalvaged.quality = "partial_text";
        }
        const reply = this.persistenceError
            ? (modelReply ? modelReply + "\n\n" : "") + "⚠️ " + this.persistenceError + "，已停止后续请求与工具执行。"
            : execution.status === "completed" ? modelReply
                : execution.status === "truncated" && execution.recoverySteps.length
                    ? composeIncompleteReport(finalSalvaged, last, execution.recoverySteps.length, last?.recoveryStage) +
                    (contextError ? "\n" + contextError : "")
                    : composeReply(finalSalvaged, execution.status, last, execution.error, this.policy.generationTimeoutMs);
        return {
            reply, modelReply, steps: [...this.steps], contextSteps: settledSteps,
            newMessages: [this.originalUser, ...currentMessages()],
            totalDurationMs: execution.totalDurationMs, status: execution.status, stopReason: last?.stopReason,
            isTruncated: execution.status === "truncated", execution,
            responseQuality: finalSalvaged.quality, salvaged: finalSalvaged
        };
    }
}
