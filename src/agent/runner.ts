import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple, type AssistantMessage, type ImageContent, type Model } from "@mariozechner/pi-ai";
import type { AgentExecutionStep, ExecutionRecord, GenerationAttempt, GenerationCall, GenerationUsage, RunStatus } from "./types";
import { toolRegistry } from "./tools/registry";
import { permissionManager, READ_TOOLS } from "./runtime/permission-manager";
import { generationPolicy, isMiMoModel, escalateBudget, type GenerationPolicy, type ReasoningEffort } from "./runtime/generation-policy";
import { fitHistory } from "./context/budget";
import { estimateTokenCount } from "./context/token";
import { salvageResponse, composeReply, composeIncompleteReport, type ResponseQuality, type SalvagedContent } from "./runtime/response-salvager";
import {
    detectTruncationStage,
    canReuseReasoningState,
    generateThinkingCheckpoint,
    buildContinuationPrompt,
    buildCheckpointPrompt,
    aggregateTextChunks,
    sanitizeIncompleteToolCalls,
    thinkingOf
} from "./runtime/truncation-recovery";

export interface RunnerOptions extends Partial<GenerationPolicy> {
    baseUrl: string;
    model: string;
    apiKey: string;
    reasoningEffort?: ReasoningEffort;
    contextWindow?: number;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    tools?: AgentTool<any>[];
    onStep?: (step: AgentExecutionStep) => void;
    onAskPermission?: (prompt: string) => Promise<boolean>;
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
const textOf = (message?: AssistantMessage): string => message?.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim() ?? "";
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

    /** 为当前输出预算保留可容纳的完整历史轮次 */
    private historyFor(prompt: string, images: ImageContent[] | undefined, maxTokens: number): AgentMessage[] {
        return fitHistory(this.options.initialMessages ?? [], estimateTokenCount(prompt) + (images?.length ?? 0) * 1000,
            this.systemPrompt, this.tools, this.contextWindow, maxTokens);
    }

    /** 执行一次独立 Agent 尝试并保留真实生成结束原因 */
    private async attempt(
        prompt: string,
        images: ImageContent[] | undefined,
        history: AgentMessage[],
        summary: GenerationAttempt,
        overrideEffort?: ReasoningEffort
    ): Promise<{ messages: AgentMessage[]; modelReply: string; salvaged: SalvagedContent }> {
        const began = Date.now();
        const effort = overrideEffort ?? this.options.reasoningEffort ?? "high";
        let originalLength: GenerationCall | undefined;
        const starts = new Map<string, number>();
        let agent: Agent;
        /** 在实际工具调用前记录可能发生的副作用 */
        const tools = this.tools.map(tool => ({
            ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => {
                if (args[2]?.aborted || originalLength) {
                    throw new Error("生成已终止，禁止执行工具");
                }
                if (!READ_TOOLS.has(tool.name)) {
                    summary.sideEffectStarted = true;
                    const call = summary.calls.at(-1);
                    if (call) {
                        call.sideEffectStarted = true;
                    }
                }
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
        /** 包装单次模型流，显式传递预算、思考开关和取消信号 */
        const streamFn: StreamFn = (callModel, context, options) => {
            if (options.signal?.aborted || originalLength) {
                throw new Error("生成已终止");
            }
            const stream = createAssistantMessageEventStream();
            const controller = new AbortController();
            /** 将 Agent 取消信号转发给当前模型请求 */
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            const callStart = Date.now();
            let lastTokenTime = callStart;
            const call: GenerationCall = {
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
            const timeout = this.policy.generationTimeoutMs && this.policy.generationTimeoutMs > 0
                ? setTimeout(() => { timedOut = true; controller.abort(); }, this.policy.generationTimeoutMs)
                : undefined;
            const progress = setInterval(() => {
                if (Date.now() - lastTokenTime >= 20000) {
                    this.emit({
                        type: "status", attemptNo: summary.attemptNo,
                        content: `模型生成中，已等待 ${Math.floor((Date.now() - callStart) / 1000)} 秒；输出预算 ${summary.maxTokens} token`
                    });
                }
            }, 30000);
            void (async () => {
                try {
                    const source = streamSimple(
                        callModel,
                        context, {
                        ...options,
                        signal: controller.signal,
                        maxTokens: summary.maxTokens,
                        maxRetries: 0,
                        timeoutMs: this.policy.generationTimeoutMs && this.policy.generationTimeoutMs > 0 ? this.policy.generationTimeoutMs : undefined,
                        onPayload: isMiMoModel(this.options.model) ? payload => {
                            const request: Record<string, unknown> = {
                                ...(payload as Record<string, unknown>), thinking: { type: effort === "off" ? "disabled" : "enabled" }
                            };
                            delete request.reasoning_effort;
                            return request;
                        } : options.onPayload
                    });
                    for await (const event of source) {
                        lastTokenTime = Date.now();
                        if (event.type === "done" || event.type === "error") {
                            const message = await source.result();
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
                            call.durationMs = Date.now() - callStart;
                        }
                        stream.push(event);
                    }
                } catch (error) {
                    call.status = timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "failed";
                    call.stopReason = controller.signal.aborted ? "aborted" : "error";
                    call.error = this.safeError(error);
                    const message: AssistantMessage = {
                        role: "assistant",
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        content: [],
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
                    stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
                } finally {
                    call.durationMs = Date.now() - callStart;
                    if (timeout) clearTimeout(timeout);
                    clearInterval(progress);
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
                if (originalLength || context.assistantMessage.stopReason === "length") {
                    agent.abort();
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
                if (assistantMsg.stopReason === "length") agent.abort();

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
                this.emit({
                    type: "tool_call",
                    attemptNo: summary.attemptNo,
                    turnNo: currentTurnNo,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    args: event.args
                });
            } else if (event.type === "tool_execution_end") {
                this.emit({
                    type: "tool_result",
                    attemptNo: summary.attemptNo,
                    turnNo: currentTurnNo,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    result: event.result,
                    isError: event.isError,
                    durationMs: Date.now() - (starts.get(event.toolCallId) ?? Date.now())
                });
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
        const startIndex = history.length;
        try { await agent.prompt(prompt, images); }
        catch (error) { summary.error = this.safeError(error); }
        const messages = agent.state.messages.slice(startIndex);
        const lastAssistant = messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
        const lastCall = summary.calls.at(-1);
        const runtimeError = agent.state.errorMessage || lastAssistant?.errorMessage;
        summary.status = originalLength ? "truncated" : lastCall?.status === "timeout" ? "timeout" :
            runtimeError && lastAssistant?.stopReason !== "aborted" ? "failed" : lastCall?.status ?? "failed";
        summary.stopReason = originalLength ? "length" : lastCall?.stopReason;
        summary.error = summary.error ?? (runtimeError ? this.safeError(runtimeError) : lastCall?.error);
        if (summary.status === "completed" && !textOf(lastAssistant)) {
            summary.status = "empty";
        }
        summary.durationMs = Date.now() - began;

        // 始终打捞模型产出，无论 finish_reason 是什么
        const salvaged = salvageResponse(messages, summary);
        const modelReply = salvaged.text;
        return { messages, modelReply, salvaged };
    }

    /** 编排状态机恢复算法并返回可持久化的最终执行结果 */
    public async run(prompt: string, images?: ImageContent[]): Promise<RunnerOutput> {
        let latestSalvaged: SalvagedContent | undefined;
        const started = Date.now();
        this.steps.length = 0;
        const execution: ExecutionRecord = {
            status: "failed", config: {
                ...this.policy,
                model: this.options.model,
                requestedReasoningEffort: this.options.reasoningEffort ?? "high",
                contextWindow: this.contextWindow,
                thinking: isMiMoModel(this.options.model) ? (this.options.reasoningEffort === "off" ? "disabled" : "enabled") : "sdk-default"
            },
            attempts: [],
            recoverySteps: [],
            totalDurationMs: 0
        };

        const maxRecoveryAttempts = 3;
        const maxBudgetCeiling = isMiMoModel(this.options.model) ? 131072 : Math.max(65536, this.policy.retryMaxTokens);
        let currentMaxTokens = this.policy.maxTokens;
        let activePrompt = prompt;
        let activeImages = images;
        let activeReasoningEffort = this.options.reasoningEffort ?? "high";
        const accumulatedChunks: string[] = [];
        let messages: AgentMessage[] = [];
        let modelReply = "";
        let contextError = "";
        let isDone = false;

        /** 状态机主循环：驱动单次执行并在截断时依阶段分支自愈 */
        while (!isDone) {
            let history: AgentMessage[];
            try {
                history = this.historyFor(activePrompt, activeImages, currentMaxTokens);
            } catch (error) {
                contextError = this.safeError(error);
                break;
            }

            const summary: GenerationAttempt = {
                attemptNo: execution.attempts.length + 1,
                maxTokens: currentMaxTokens,
                status: "failed",
                durationMs: 0,
                sideEffectStarted: false,
                calls: []
            };
            execution.attempts.push(summary);

            // 执行模型单次尝试（对应流程图：Pi SDK 返回）
            const attemptResult = await this.attempt(activePrompt, activeImages, history, summary, activeReasoningEffort);
            messages = attemptResult.messages;
            latestSalvaged = attemptResult.salvaged;

            // 持久化 Partial Response（在 execution.attempts 中已保留完整记录）

            // 判断本轮是否发生截断
            const isTruncated = summary.status === "truncated" || summary.stopReason === "length";
            if (!isTruncated) {
                // 本轮成功：回到正常 Agent Loop
                if (accumulatedChunks.length > 0) {
                    if (latestSalvaged.text) accumulatedChunks.push(latestSalvaged.text);
                    modelReply = aggregateTextChunks(accumulatedChunks);
                } else {
                    modelReply = latestSalvaged.text;
                }
                if (execution.recoverySteps && execution.recoverySteps.length > 0) {
                    execution.recoverySteps[execution.recoverySteps.length - 1].success = true;
                }
                isDone = true;
                break;
            }

            // 截断发生在此什么阶段？
            const stage = detectTruncationStage(messages, summary);
            summary.recoveryStage = stage;

            // 若本轮已经执行了写工具等外部变更，禁止重跑以防重复副作用
            if (summary.sideEffectStarted) {
                break;
            }

            // 检查是否达到最大恢复次数
            const recoveryCount = execution.recoverySteps?.length ?? 0;
            if (recoveryCount >= maxRecoveryAttempts) {
                break;
            }

            // 分阶段恢复算法分支
            if (stage === "thinking") {
                // Thinking 阶段截断
                const canReuse = canReuseReasoningState(this.options.model);
                if (canReuse) {
                    // 保留合法的推理状态发起续接请求
                    execution.recoverySteps?.push({
                        recoveryAttemptNo: recoveryCount + 1,
                        stage: "thinking",
                        actionTaken: "reuse_reasoning",
                        previousTokens: currentMaxTokens,
                        newTokens: currentMaxTokens,
                        accumulatedTextLength: 0,
                        success: false
                    });
                } else {
                    const escalation = escalateBudget(currentMaxTokens, maxBudgetCeiling);
                    if (escalation.canEscalate) {
                        // 可提高输出预算？-> 是：提高 maxTokens 重新调用原始请求
                        const prev = currentMaxTokens;
                        currentMaxTokens = escalation.nextTokens;
                        this.emit({
                            type: "status",
                            attemptNo: summary.attemptNo,
                            content: `Thinking 阶段预算耗尽，提高输出预算：${prev} → ${currentMaxTokens} token，重新发起原始请求`
                        });
                        execution.recoverySteps?.push({
                            recoveryAttemptNo: recoveryCount + 1,
                            stage: "thinking",
                            actionTaken: "boost_budget_original",
                            previousTokens: prev,
                            newTokens: currentMaxTokens,
                            accumulatedTextLength: 0,
                            success: false
                        });
                    } else {
                        // 可提高输出预算？-> 否：保留可见进展 生成任务检查点并继续
                        const lastAssistant = messages.filter((m): m is AssistantMessage => m.role === "assistant").at(-1);
                        const checkpoint = generateThinkingCheckpoint(thinkingOf(lastAssistant));
                        this.emit({
                            type: "status",
                            attemptNo: summary.attemptNo,
                            content: `Thinking 阶段预算已达上限，已提取思考检查点，关闭冗余思考直接生成正文`
                        });
                        activePrompt = buildCheckpointPrompt(prompt, checkpoint);
                        activeReasoningEffort = "off";
                        execution.recoverySteps?.push({
                            recoveryAttemptNo: recoveryCount + 1,
                            stage: "thinking",
                            actionTaken: "checkpoint_continue",
                            previousTokens: currentMaxTokens,
                            newTokens: currentMaxTokens,
                            accumulatedTextLength: 0,
                            success: false,
                            note: checkpoint
                        });
                    }
                }
            } else if (stage === "text") {
                // 普通正文阶段截断
                // 1. 保存完整可见文本片段
                if (latestSalvaged.text) {
                    accumulatedChunks.push(latestSalvaged.text);
                }
                const currentAggregated = aggregateTextChunks(accumulatedChunks);
                // 2. 根据历史文本发起续写
                this.emit({
                    type: "status",
                    attemptNo: summary.attemptNo,
                    content: `正文生成达单次上限（已打捞 ${currentAggregated.length} 字符），正在无缝发起续写 (${recoveryCount + 1}/${maxRecoveryAttempts})...`
                });
                activePrompt = buildContinuationPrompt(currentAggregated);
                const escalation = escalateBudget(currentMaxTokens, maxBudgetCeiling);
                const prev = currentMaxTokens;
                if (escalation.canEscalate) {
                    currentMaxTokens = escalation.nextTokens;
                }
                execution.recoverySteps?.push({
                    recoveryAttemptNo: recoveryCount + 1,
                    stage: "text",
                    actionTaken: "text_continuation",
                    previousTokens: prev,
                    newTokens: currentMaxTokens,
                    accumulatedTextLength: currentAggregated.length,
                    success: false
                });
                // 3. 分段呈现与聚合在循环结束或下轮由 aggregateTextChunks 统一缝合
            } else if (stage === "tool_call") {
                // ToolCall 参数阶段截断
                // 1. 禁止执行不完整工具调用
                messages = sanitizeIncompleteToolCalls(messages);
                // 2. 提高预算并重试该模型步骤
                const escalation = escalateBudget(currentMaxTokens, maxBudgetCeiling);
                const prev = currentMaxTokens;
                if (escalation.canEscalate) {
                    currentMaxTokens = escalation.nextTokens;
                }
                this.emit({
                    type: "status",
                    attemptNo: summary.attemptNo,
                    content: `ToolCall 参数截断，已拦截未完成工具调用；提升输出预算至 ${currentMaxTokens} token 重试本步骤`
                });
                execution.recoverySteps?.push({
                    recoveryAttemptNo: recoveryCount + 1,
                    stage: "tool_call",
                    actionTaken: "retry_tool_call",
                    previousTokens: prev,
                    newTokens: currentMaxTokens,
                    accumulatedTextLength: 0,
                    success: false
                });
            }
        }

        const last = execution.attempts.at(-1);
        execution.status = last?.status ?? "failed";
        if (contextError || last?.error) {
            execution.error = contextError || last?.error;
        }
        execution.totalDurationMs = Date.now() - started;

        // 如果在正文阶段累积了分段续写片段，聚合并更新 modelReply
        if (accumulatedChunks.length > 0) {
            if (latestSalvaged?.text && !accumulatedChunks.includes(latestSalvaged.text)) {
                accumulatedChunks.push(latestSalvaged.text);
            }
            modelReply = aggregateTextChunks(accumulatedChunks);
        } else {
            modelReply = latestSalvaged?.text ?? "";
        }

        const finalSalvaged: SalvagedContent = latestSalvaged ?? salvageResponse(messages, last!);
        if (modelReply) {
            finalSalvaged.text = modelReply;
            finalSalvaged.hasUsableContent = true;
        }

        // 合成最终呈现回复：完成则直接展示正文，达到恢复上限仍截断则输出未完成报告
        let reply: string;
        if (execution.status === "completed") {
            reply = modelReply;
        } else if (execution.status === "truncated") {
            const recoveryCount = execution.recoverySteps?.length ?? 0;
            if (recoveryCount > 0) {
                reply = composeIncompleteReport(finalSalvaged, last, recoveryCount, last?.recoveryStage);
            } else {
                reply = composeReply(finalSalvaged, execution.status, last, contextError, this.policy.generationTimeoutMs);
            }
        } else {
            reply = composeReply(finalSalvaged, execution.status, last, contextError, this.policy.generationTimeoutMs);
        }

        const validCalls = new Set(messages.filter((message): message is AssistantMessage => message.role === "assistant" &&
            (message.stopReason === "stop" || message.stopReason === "toolUse"))
            .flatMap(message => message.content.filter(block => block.type === "toolCall")
                .map(block => block.id)));
        const pairedCalls = new Set(messages.filter(message => message.role === "toolResult" && validCalls.has(message.toolCallId)).map(message => (message as any).toolCallId));
        const contextSteps = this.steps.filter(step => step.attemptNo === last?.attemptNo &&
            (step.type === "tool_call" || step.type === "tool_result") && pairedCalls.has(step.toolCallId));

        return {
            reply,
            modelReply,
            steps: [...this.steps],
            contextSteps,
            newMessages: messages,
            totalDurationMs: execution.totalDurationMs,
            status: execution.status,
            stopReason: last?.stopReason,
            isTruncated: execution.status === "truncated",
            execution,
            responseQuality: finalSalvaged.quality,
            salvaged: finalSalvaged
        };
    }
}
