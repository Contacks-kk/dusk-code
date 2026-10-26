import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type StreamFn } from "@mariozechner/pi-agent-core";
import * as path from "node:path";
import { createAssistantMessageEventStream, streamSimple, type AssistantMessage, type ImageContent } from "@mariozechner/pi-ai";
import type { AgentExecutionStep, ExecutionRecord, GenerationAttempt, GenerationCall, GenerationUsage, RunStatus } from "./types";
import { toolRegistry } from "./tools/registry";
import { bindCommandTools } from "./tools/command-tools";
import { permissionManager, isReadOnlyTool } from "./runtime/permission-manager";
import { generationPolicy, type GenerationPolicy, type ReasoningEffort } from "./runtime/generation-policy";
import { ContextCoordinator } from "./context/coordinator";
import { sourceMessage, type ContextMessage, type ContextPersistence } from "./context/types";
import { historyToolId, restoreRecordedMessages } from "./context/history";
import { finishRequestDiagnostics, prepareModelRequest, type RequestDiagnostics } from "./runtime/model-adapter";
import { resolveModelCapabilities, sdkModel, type ResolvedModelCapabilities } from "./runtime/model-profile";
import type { SkillRuntime } from "./skills/runtime";
import type { AcceptanceRuntime } from "./acceptance/runtime";
import { isManagedToolFailure, isToolRecord } from "./tools/result";
import { controlPrompt, controlToolRejection, withoutRuntimeControl, type TurnControl } from "./runtime/turn-control";
import { salvageResponse, composeReply, composeIncompleteReport, type ResponseQuality, type SalvagedContent } from "./runtime/response-salvager";
import {
    detectTruncationStage,
    buildRecoveryPrompt,
    aggregateTextChunks
} from "./runtime/truncation-recovery";
import { TaskStatusBarTracker } from "./status/tracker";
import { createTodoWriteTool } from "./status/todo.tool";
import type { StatusBarMode } from "./status/types";
import { SpillPolicy } from "./spill/spill-policy";
import { ToolBatchScheduler, parallelToolLimit, type ToolSettlement } from "./runtime/tool-batch";

export interface RunnerOptions extends Partial<GenerationPolicy> {
    control?: TurnControl;
    beforeAction?: () => Promise<void>;
    skillRuntime?: SkillRuntime;
    acceptance?: AcceptanceRuntime;
    auxiliaryRequests?: RequestDiagnostics[];
    baseUrl: string;
    model: string;
    apiKey: string;
    reasoningEffort?: ReasoningEffort;
    contextWindow?: number;
    capabilities?: ResolvedModelCapabilities;
    compactionEnabled?: boolean;
    contextPersistence?: ContextPersistence;
    currentTurnId?: number;
    currentTurnNo?: number;
    userMessageId?: number;
    systemPrompt?: string;
    projectRoot?: string;
    initialMessages?: AgentMessage[];
    tools?: AgentTool<any>[];
    onStep?: (step: AgentExecutionStep) => void;
    onAskPermission?: (prompt: string) => Promise<boolean>;
    onExecution?: (snapshot: ExecutionRecord, settledSteps?: AgentExecutionStep[]) => void;
    statusBarTracker?: TaskStatusBarTracker;
    statusBarMode?: StatusBarMode;
    sessionId?: number;
    spillPolicy?: SpillPolicy;
    maxParallelToolCalls?: number;
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
    private readonly capabilities: ResolvedModelCapabilities;
    private readonly steps: AgentExecutionStep[] = [];
    private persistenceError?: string;
    private originalUser?: AgentMessage;
    private contextCoordinator?: ContextCoordinator;
    private imageInputUnavailable = false;
    private readonly statusBar?: TaskStatusBarTracker;
    private readonly spillPolicy: SpillPolicy;

    /** 让文件和命令工具使用目标项目目录，权限检查与实际操作采用相同路径 */
    private projectArguments<T>(name: string, args: T): T {
        if (!this.options.projectRoot || !isToolRecord(args)) {
            return args;
        }
        const fields: Record<string, string> = {
            read_file: "filePath",
            read_image: "filePath",
            write_file: "filePath",
            apply_patch: "filePath",
            list_files: "directoryPath",
            grep_search: "searchPath",
            git_status: "repoPath",
            git_diff: "repoPath",
            execute_command: "cwd"
        };
        const field = fields[name];
        if (!field) {
            return args;
        }
        const value = args[field];
        if ((value !== undefined && typeof value !== "string") || (value === undefined && field === "filePath")) {
            return args;
        }
        return { ...args, [field]: typeof value === "string" ? path.resolve(this.options.projectRoot, value) : this.options.projectRoot };
    }

    /** 在工具实际启动边界核对取消、指令和验收限制 */
    private assertToolBoundary(name: string, args: Record<string, unknown>, signal?: AbortSignal): void {
        signal?.throwIfAborted();
        this.options.signal?.throwIfAborted();
        const rejection = this.persistenceError ??
            (this.options.control && controlToolRejection(this.options.control, name, args)) ??
            this.options.acceptance?.beforeTool(name);
        if (rejection) {
            throw new Error(rejection);
        }
    }

    /** 调度许可后检查权限，交互等待结束时再次核对最新指令 */
    private async authorizeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        await this.options.beforeAction?.();
        this.assertToolBoundary(name, args, signal);
        const check = await permissionManager.checkToolPermission(name, args, this.options.onAskPermission, {
            workspaceRoot: this.options.projectRoot,
            readRoots: [
                ...(this.options.acceptance ? [this.options.acceptance.evidence.directory] : []),
                ...(this.options.skillRuntime?.record.snapshots.filter(item => item.status === "loaded").map(item => item.skillDir) ?? [])
            ]
        });
        await this.options.beforeAction?.();
        this.assertToolBoundary(name, args, signal);
        if (!check.allowed) {
            throw new Error(check.reason ?? "权限不足");
        }
    }

    /** 保存本轮模型连接与生成策略 */
    constructor(private readonly options: RunnerOptions) {
        parallelToolLimit(options.maxParallelToolCalls);
        this.policy = generationPolicy(options, options.model);
        this.tools = bindCommandTools(options.tools ?? toolRegistry.getAll(), {
            projectRoot: options.projectRoot ?? process.cwd(),
            sessionId: options.sessionId ?? 0
        });
        this.systemPrompt = options.systemPrompt ?? "你是一个具备工具调用能力的专业 AI 助手，在需要时自主使用工具解决问题。";
        this.capabilities = options.capabilities ?? resolveModelCapabilities({
            model: options.model,
            baseUrl: options.baseUrl,
            windowTokens: options.contextWindow,
            windowExplicit: options.contextWindow !== undefined
        });
        this.contextWindow = this.capabilities.contextWindow;
        this.statusBar = options.statusBarTracker ?? (options.projectRoot ? new TaskStatusBarTracker(
            options.projectRoot,
            options.control?.intent ?? "执行任务",
            options.statusBarMode ?? "replace",
            this.policy.generationTimeoutMs ?? 180000,
            options.control?.intent
        ) : undefined);
        this.spillPolicy = options.spillPolicy ?? new SpillPolicy();

        // 若启用了状态栏且尚未注入 todo_write 工具，保底注册
        if (this.statusBar && !this.tools.some(t => t.name === "todo_write")) {
            this.tools.push(createTodoWriteTool(this.statusBar));
        }
    }

    /** 将当前最新的任务状态栏动态注入到发送给模型的最后一帧上下文 */
    private injectStatusBar(messages: AgentMessage[], callNo: number): AgentMessage[] {
        if (!this.statusBar || messages.length === 0) {
            return messages;
        }
        const cloned = [...messages];
        const lastIndex = cloned.length - 1;
        const lastMsg = cloned[lastIndex];
        const statusText = this.statusBar.render(
            this.options.currentTurnNo ?? 1,
            callNo,
            this.options.acceptance?.record
        );

        // 为字符串类型内容追加状态栏
        if (lastMsg.role === "runtime_control" || (lastMsg.role === "user" && typeof lastMsg.content === "string")) {
            cloned[lastIndex] = {
                ...lastMsg,
                content: `${lastMsg.content}\n\n${statusText}`
            };
            return cloned;
        }

        // 为多块类型内容追加文本块
        if (lastMsg.role === "assistant") {
            cloned[lastIndex] = { ...lastMsg, content: [...lastMsg.content, { type: "text", text: `\n\n${statusText}` }] };
        } else if (lastMsg.role === "toolResult") {
            cloned[lastIndex] = {
                ...lastMsg,
                content: [
                    ...lastMsg.content,
                    {
                        type: "text" as const,
                        text: `\n\n${statusText}`
                    }
                ]
            };
            return cloned;
        } else if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
            cloned[lastIndex] = { ...lastMsg, content: [...lastMsg.content, { type: "text", text: `\n\n${statusText}` }] };
        }
        return cloned;
    }

    /**
     * 记录并推送带尝试编号的执行事件
     * @param step 排除时间字段
     */
    private emit(step: Omit<AgentExecutionStep, "timestamp">): void {
        // 新建对象，浅拷贝step字段值，并且补齐timestamp字段值
        const event = { instructionRevision: this.options.control?.instructionRevision, ...step, timestamp: Date.now() };
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

    /** 将无法送达的图片替换为说明，原始消息仍保留在归档中 */
    private requestMessages(messages: AgentMessage[]): AgentMessage[] {
        messages = withoutRuntimeControl(messages);
        if (!this.imageInputUnavailable) {
            return messages;
        }
        return messages.map(message => this.messageWithoutImages(message));
    }

    /** 为仅接受文字的请求保留消息身份并替换图片块 */
    private messageWithoutImages(message: AgentMessage): AgentMessage {
        if (message.role === "assistant" || message.role === "runtime_control" || typeof message.content === "string") {
            return message;
        }
        return {
            ...message,
            content: message.content.map(block => block.type === "image"
                ? { type: "text" as const, text: "[图片未送达：当前接口拒绝图片输入，视觉未验收]" }
                : block)
        };
    }

    /** 同步完整技能指令并在预算不足时按优先级明确降级 */
    private async prepareContext(messages: AgentMessage[], outputBudget: number, signal?: AbortSignal, force = false): Promise<{ messages: AgentMessage[]; systemPrompt: string }> {
        const coordinator = this.contextCoordinator;
        if (!coordinator) {
            throw new Error("上下文协调器尚未初始化");
        }
        while (true) {
            signal?.throwIfAborted();
            await this.options.beforeAction?.();
            const systemPrompt = this.systemPrompt + (this.options.skillRuntime?.prompt() ?? "") + (this.options.acceptance?.prompt() ?? "") +
                (this.options.control ? controlPrompt(this.options.control) : "");
            coordinator.setSystemPrompt(systemPrompt);
            try {
                const fitted = await coordinator.prepare(messages, outputBudget, signal, force);
                return { messages: this.requestMessages(fitted), systemPrompt };
            } catch (error) {
                signal?.throwIfAborted();
                if (!/上下文基础预算不足|上下文裁剪后仍无法容纳/.test(String(error)) || !this.options.skillRuntime?.excludeForBudget()) {
                    throw error;
                }
            }
        }
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
        let batch: ToolBatchScheduler | undefined;
        const boundedCalls = new Set<string>();
        const originalIndex = history.indexOf(this.originalUser);
        const oldHistoryLength = originalIndex < 0 ? history.length : originalIndex;
        let agent: Agent;
        /** 对正常结果和预校验错误统一归档并明确归档失败 */
        const boundResult = async (name: string, id: string, result: AgentToolResult<unknown>): Promise<AgentToolResult<unknown>> => {
            try {
                return await this.spillPolicy.processResult(name, id, result, {
                    sessionId: this.options.sessionId ?? 0,
                    projectRoot: this.options.projectRoot ?? process.cwd()
                });
            } catch (error) {
                const reason = this.safeError(error).slice(0, 512);
                const text = `工具输出归档失败：${reason}。请核实已执行操作，不得直接重放。`;
                return {
                    content: [{ type: "text", text }],
                    details: {
                        error: text,
                        outputIncomplete: true,
                        operationStarted: starts.has(id)
                    }
                };
            }
        };
        /** 按模型顺序提交结果，提交完成后才能发布完成通知 */
        const settleTool = async (value: ToolSettlement): Promise<void> => {
            const step = toolSteps.get(value.id);
            if (!step) {
                throw new Error(`工具调用记录缺失：${value.id}`);
            }
            this.statusBar?.recordToolCall(step.toolName, step.args ?? {}, value.isError,
                value.isError ? JSON.stringify(value.result.content).slice(0, 300) : undefined);
            this.options.skillRuntime?.observeTool(step.toolName, step.args ?? {}, value.result, value.id, value.isError);
            const resultStep: AgentExecutionStep = {
                ...step,
                type: "tool_result",
                result: value.result,
                isError: value.isError,
                durationMs: Date.now() - (starts.get(value.id) ?? Date.now()),
                timestamp: Date.now()
            };
            if (!value.isError) {
                await this.options.acceptance?.observeTool(step.toolName, step.args ?? {});
            }
            const pending = execution.pendingToolCallIds;
            execution.pendingToolCallIds = pending.filter(id => id !== value.id);
            try {
                onCallCompleted([step, resultStep]);
            } catch (error) {
                execution.pendingToolCallIds = pending;
                throw error;
            }
            this.emit(resultStep);
            starts.delete(value.id);
        };
        /** 在实际工具调用前记录可能发生的副作用 */
        const tools = this.tools.map(tool => ({
            ...tool,
            executionMode: "parallel" as const,
            prepareArguments: (args: unknown) => this.projectArguments(tool.name, tool.prepareArguments ? tool.prepareArguments(args) : args),
            execute: async (...args: Parameters<typeof tool.execute>) => {
                if (!batch) {
                    throw new Error("工具批次尚未建立");
                }
                return batch.run(args[0], async () => {
                    const toolArgs = isToolRecord(args[1]) ? args[1] : {};
                    await this.authorizeTool(tool.name, toolArgs, args[2]);
                    if (originalLength) {
                        throw new Error("工具调用来自被截断的响应，禁止执行");
                    }
                    const step = toolSteps.get(args[0]);
                    if (!step) {
                        throw new Error("实际执行缺少工具调用记录");
                    }
                    step.args = toolArgs;
                    step.timestamp = Date.now();
                    starts.set(args[0], step.timestamp);
                    this.emit(step);
                    if (!isReadOnlyTool(tool.name, toolArgs)) {
                        summary.sideEffectStarted = true;
                        const call = summary.calls.at(-1);
                        if (call) {
                            call.sideEffectStarted = true;
                        }
                    }
                    execution.pendingToolCallIds.push(args[0]);

                    // 待结算状态先落库，再允许工具产生副作用
                    onCallCompleted();
                    return tool.execute(...args);
                });
            }
        }));
        const model = sdkModel(this.capabilities);
        this.contextCoordinator ??= new ContextCoordinator({
            model,
            capabilities: this.capabilities,
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
                instructionRevision: this.options.control?.instructionRevision,
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
                this.options.skillRuntime?.observeResponse(message, `${summary.attemptNo}:${call.callNo}`);
                call.phase = "finished";
                call.response = structuredClone(message);
                if (call.response.errorMessage) {
                    call.response.errorMessage = this.safeError(call.response.errorMessage);
                }
                if (call.diagnostics) {
                    finishRequestDiagnostics(call.diagnostics, message, callStart || Date.now());
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
                    let prepared = await this.prepareContext(context.messages, Math.min(summary.maxTokens, this.capabilities.maxOutputTokens ?? summary.maxTokens), controller.signal);

                    controller.signal.throwIfAborted();
                    onCallCompleted();
                    /** 上下文准备完毕后才启动主模型的生成超时 */
                    callStart = lastTokenTime = Date.now();
                    if (this.policy.generationTimeoutMs) timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.policy.generationTimeoutMs);
                    let overflowRetried = false;
                    for (let requestAttempt = 0; requestAttempt < 3; requestAttempt++) {
                        const requestMessages = withoutRuntimeControl(this.injectStatusBar(prepared.messages, call.callNo));
                        const request = prepareModelRequest({ ...context, systemPrompt: prepared.systemPrompt, messages: requestMessages }, this.capabilities,
                            summary.attemptNo === 1 ? "task" : "recovery", effort, summary.maxTokens, {
                                ...options,
                                apiKey: this.options.apiKey,
                                signal: controller.signal,
                                maxRetries: 0,
                                timeoutMs: this.policy.generationTimeoutMs
                            });
                        call.diagnostics = request.diagnostics;
                        call.maxTokens = request.diagnostics.maxTokens;
                        this.options.skillRuntime?.observeRequest(request.context.messages, `${summary.attemptNo}:${call.callNo}`);
                        if (request.diagnostics.downgrade) {
                            this.emit({ type: "status", content: request.diagnostics.downgrade });
                        }
                        const source = streamSimple(request.model, request.context, request.options);
                        let overflow = false;
                        let imageRejected = false;
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
                                if (requestAttempt < 2 && !this.imageInputUnavailable && message.stopReason === "error" && !message.content.length &&
                                    prepared.messages.some(item => typeof item.content !== "string" && item.content.some(block => block.type === "image")) &&
                                    /image|vision|multimodal|图片|图像|多模态/i.test(message.errorMessage ?? "")) {
                                    imageRejected = true;
                                    this.imageInputUnavailable = true;
                                    request.diagnostics.failure = "image_input_rejected";
                                    finishRequestDiagnostics(request.diagnostics, message, callStart);
                                    this.options.auxiliaryRequests?.push({ ...request.diagnostics });
                                    this.options.skillRuntime?.imageFailure(this.safeError(message.errorMessage || "当前接口拒绝图片输入"));
                                    break;
                                }
                                if (!overflowRetried && requestAttempt < 2 && message.stopReason === "error" && !message.content.length &&
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
                        if (!overflow && !imageRejected) {
                            break;
                        }
                        overflowRetried ||= overflow;

                        // 判断是否需要进行压缩，需要时则阻塞压缩，并向UI推送“正在压缩的消息
                        prepared = await this.prepareContext(context.messages, call.maxTokens, controller.signal, overflow);
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
            toolExecution: "parallel",
            convertToLlm: withoutRuntimeControl,
            initialState: { systemPrompt: this.systemPrompt, model, tools, messages: history, thinkingLevel: effort },
            getApiKey: () => this.options.apiKey, streamFn,
            /** 让工具失败标记在实时消息、检查点和历史回放中保持一致 */
            afterToolCall: async context => {
                const result = await boundResult(context.toolCall.name, context.toolCall.id, context.result);
                boundedCalls.add(context.toolCall.id);
                return {
                    ...result,
                    isError: context.isError || isManagedToolFailure(context.toolCall.name, context.result) ||
                        isManagedToolFailure(context.toolCall.name, result)
                };
            }
        });
        let currentTurnNo = 1;
        let thinkingStart = 0;
        agent.subscribe(async event => {
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
                const calls = assistantMsg.content.filter(block => block.type === "toolCall");
                if (calls.length) {
                    batch = new ToolBatchScheduler(calls, parallelToolLimit(this.options.maxParallelToolCalls), settleTool, () => agent.abort());
                }
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
                toolSteps.set(event.toolCallId, {
                    instructionRevision: summary.calls.at(-1)?.instructionRevision,
                    type: "tool_call", attemptNo: summary.attemptNo, callNo: summary.calls.at(-1)?.callNo,
                    turnNo: currentTurnNo, toolName: event.toolName, toolCallId: event.toolCallId,
                    args: event.args, timestamp: Date.now()
                });
            } else if (event.type === "tool_execution_end") {
                if (!batch) {
                    throw new Error("工具结算没有对应批次");
                }
                if (!boundedCalls.delete(event.toolCallId)) {
                    const bounded = await boundResult(event.toolName, event.toolCallId, event.result);
                    Object.assign(event.result, bounded);
                }
                batch.complete({ id: event.toolCallId, result: event.result, isError: event.isError });
            } else if (event.type === "turn_end") {
                await batch?.drain();
                batch = undefined;
                this.emit({
                    type: "turn_end",
                    attemptNo: summary.attemptNo,
                    turnNo: currentTurnNo
                });
                currentTurnNo++;
                const call = summary.calls.at(-1);
                if (event.message.role === "assistant" && event.message.stopReason === "stop" && call?.status === "completed" && !originalLength &&
                    !this.persistenceError && !execution.pendingToolCallIds.length && !this.options.signal?.aborted) {
                    await this.options.beforeAction?.();
                    let revision: number | undefined;
                    let followUp: AgentMessage | undefined;
                    do {
                        revision = this.options.control?.instructionRevision;
                        followUp = await this.options.acceptance?.candidate({ attemptNo: summary.attemptNo, callNo: call.callNo }, textOf(event.message));
                        await this.options.beforeAction?.();
                    } while (!this.options.signal?.aborted && revision !== this.options.control?.instructionRevision);

                    // 续修指令先落库，再交给同一个 Agent 继续执行
                    onCallCompleted();
                    if (followUp && !this.options.signal?.aborted && revision === this.options.control?.instructionRevision) {
                        agent.followUp(followUp);
                    }
                }
            }
        });
        /** 将外部取消信号传递到活动模型请求和工具循环 */
        const abortRun = () => {
            batch?.stop(new Error("任务已取消，工具未启动"));
            agent.abort();
        };
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
        finally {
            await batch?.drain().catch(error => { summary.error = this.safeError(error); });
            this.options.signal?.removeEventListener("abort", abortRun);
        }
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
        this.imageInputUnavailable = false;
        this.originalUser = {
            role: "user", timestamp: started,
            content: images?.length ? [{ type: "text", text: prompt }, ...images] : prompt
        };

        // 统一准备模型历史与请求，保留 SDK 的默认兼容处理
        const initialRequest = prepareModelRequest(
            { messages: [] },
            this.capabilities,
            "task",
            this.options.reasoningEffort ?? "high",
            this.policy.maxTokens
        ).diagnostics;
        const execution: ExecutionRecord = {
            control: this.options.control,
            skills: this.options.skillRuntime?.record,
            delivery: this.options.acceptance?.record,
            auxiliaryRequests: this.options.auxiliaryRequests,
            phase: "running", status: "failed", effectiveCallRefs: [], pendingToolCallIds: [],
            config: {
                // ...this.policy 将policy的属性浅拷贝到 ExecutionRecord.config允许配置符合对象中
                ...this.policy,
                diagnostics: initialRequest,
                model: this.options.model,
                requestedReasoningEffort: this.options.reasoningEffort ?? "high",
                thinking: initialRequest.effectiveThinking === "sdk-default" ? "sdk-default" : initialRequest.effectiveThinking === "disabled" ? "disabled" : "enabled",
                contextWindow: this.contextWindow
            },
            attempts: [],
            recoverySteps: [],
            totalDurationMs: 0
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
            turn: {
                id: this.options.currentTurnId,
                turnNo: this.options.currentTurnNo,
                executionJson: execution
            },
            messages: settledSteps.filter(step => step.type === "tool_result").map(step => ({
                role: "tool_result",
                createdAt: step.timestamp,
                content: JSON.stringify({
                    id: step.toolCallId,
                    tool: step.toolName,
                    attemptNo: step.attemptNo,
                    callNo: step.callNo,
                    result: step.result,
                    isError: step.isError
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
            try {
                persistExecution();
            }
            catch {
                contextError = this.persistenceError;
                break;
            }
            const history = summary.attemptNo === 1
                // 首次尝试的历史
                ? this.options.initialMessages ?? []
                // 自愈重试时的历史
                : [...this.options.initialMessages ?? [], this.originalUser, ...currentMessages()];

            // 保留本轮已结算内容并继续当前尝试
            const result = await this.attempt(
                activePrompt,
                summary.attemptNo === 1 ? images : undefined,
                history,
                summary,
                execution,
                persistExecution,
                effort
            );
            messages = result.messages;
            latestSalvaged = result.salvaged;
            if (latestSalvaged.text) {
                if (continuation) chunks.push(latestSalvaged.text);
                else chunks = [latestSalvaged.text];
            }
            if (this.persistenceError) {
                contextError = this.persistenceError; break;
            }
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
            // 超过最大重试次数，停止
            if (recoveryCount >= maxRecoveryAttempts) break;

            const stage = summary.recoveryStage;
            continuation = stage === "text";
            effort = "off";
            activePrompt = buildRecoveryPrompt(stage);
            const action = stage === "thinking" ? "checkpoint_continue" : stage === "text" ? "text_continuation" : "retry_tool_call";
            summary.recoveryAction = action;
            execution.recoverySteps.push({
                recoveryAttemptNo: recoveryCount + 1,
                stage,
                actionTaken: action,
                previousTokens: maxTokens,
                newTokens: maxTokens,
                accumulatedTextLength: aggregateTextChunks(chunks).length,
                success: false,
                note: activePrompt
            });
            execution.phase = "recovering";
            /** 决策先落库，再进入下一次请求 */
            try { persistExecution(); }
            catch { contextError = this.persistenceError; break; }
            const stageName = stage === "tool_call" ? "工具参数" : stage === "text" ? "正文" : "思考";
            this.emit({
                type: "status", attemptNo: summary.attemptNo,
                content: stageName + "达到单次输出上限，保留本轮进展并按辅助请求思考策略继续（" +
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
            try { persistExecution(); }
            catch { /* 下方统一返回持久化失败。 */ }
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
        let reply = this.persistenceError
            ? (modelReply ? modelReply + "\n\n" : "") + "⚠️ " + this.persistenceError + "，已停止后续请求与工具执行。"
            : execution.status === "completed" ? modelReply
                : execution.status === "truncated" && execution.recoverySteps.length
                    ? composeIncompleteReport(finalSalvaged, last, execution.recoverySteps.length, last?.recoveryStage) +
                    (contextError ? "\n" + contextError : "")
                    : composeReply(finalSalvaged, execution.status, last, execution.error, this.policy.generationTimeoutMs);
        if (execution.delivery && execution.status !== "completed") {
            execution.delivery.stoppedReason ??= execution.error ?? `本轮生成执行状态：${execution.status}，验收未完成`;
        }
        reply = this.options.acceptance?.finish(execution.status, reply) ?? reply;
        if (!this.persistenceError) {
            try {
                persistExecution();
            } catch {
                execution.status = "failed";
                execution.error = this.persistenceError;
                if (execution.delivery?.status === "passed") {
                    execution.delivery.status = "unverified";
                    execution.delivery.stoppedReason = this.persistenceError;
                    reply = this.options.acceptance?.finish("failed", reply) ?? reply;
                }
            }
        }
        return {
            reply,
            modelReply,
            steps: [...this.steps],
            contextSteps: settledSteps,
            newMessages: [this.originalUser, ...currentMessages()],
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
