import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple, type ImageContent } from "@mariozechner/pi-ai";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { turn, message } from "../db/schema";
import { sessionService } from "./session.service";
import { titleService } from "./title.service";
import { AgentRunner } from "../agent/runner";
import { getAppConfig } from "../config/env";
import type { AgentRunResult, AgentExecutionStep, ExecutionRecord } from "../agent/types";
import { ContextStore } from "../agent/context/store";
import { createRecallTool } from "../agent/context/recall.tool";
import { toolRegistry } from "../agent/tools/registry";
import { sourceMessage } from "../agent/context/types";
import { ContextCoordinator } from "../agent/context/coordinator";
import { contextEntries, applyContextArtifacts } from "../agent/context/view";
import { requestTokens } from "../agent/context/token";
import { buildSystemPrompt } from "../agent/prompt";
import { permissionManager } from "../agent/runtime/permission-manager";
import { sdkModel } from "../agent/runtime/model-profile";
import { prepareModelRequest, finishRequestDiagnostics, type RequestDiagnostics } from "../agent/runtime/model-adapter";
import { modelConfigManager } from "../agent/runtime/model-config";
import { loadImageAsImageContent } from "../utils/image";
import { restoreRecordedMessages, annotateLegacyMessages, restoreToolContent } from "../agent/context/history";
import { prepareTurnSkills } from "../agent/skills/preparation";
import { createSkillTools } from "../agent/tools/skill/skill.tool";
import { projectService } from "./project.service";
import { prepareDelivery } from "../agent/acceptance/requirements";
import { AcceptanceRuntime } from "../agent/acceptance/runtime";
import { createAcceptanceTools } from "../agent/acceptance/tools";
import type { VerificationOptions } from "../agent/acceptance/types";
import type { DeliveryRecord } from "../agent/acceptance/types";
import type { ModelConfig } from "../agent/runtime/model-config";
import { classifyTurn, explicitControl, turnControl, executionPolicy, type TurnControl } from "../agent/runtime/turn-control";
import { ActiveRun, type PendingInput } from "../agent/runtime/active-run";
import { TaskStore, taskFacts } from "../agent/acceptance/task-store";

interface ChatOptions {
    projectId?: number;
    onStep?: (step: AgentExecutionStep) => void;
    onAskPermission?: (prompt: string) => Promise<boolean>;
    imagePaths?: string[];
    signal?: AbortSignal;
    verification?: VerificationOptions;
    onActive?: (value: { sessionId: number; runId: string }) => void;
    runtime?: ActiveRun;
    prepared?: PendingInput;
}

export class AgentService {
    private readonly active = new Map<number, ActiveRun>();

    /** 返回活动状态或最后持久化的任务，不触发模型和工具 */
    public status(sessionId: number) {
        const active = this.active.get(sessionId);
        if (active?.status) {
            return active.status;
        }
        const row = sqlite.prepare("SELECT state_json FROM task_state WHERE session_id=? ORDER BY updated_at DESC LIMIT 1")
            .get(sessionId) as { state_json: string } | undefined;
        return row ? { task: JSON.parse(row.state_json), summary: taskFacts(JSON.parse(row.state_json)) } : { summary: taskFacts() };
    }

    /** 在活动持有者内持久化新输入，不申请第二份会话租约 */
    public input(sessionId: number, runId: string, inputId: string, input: string) {
        const active = this.active.get(sessionId);
        if (!active || active.runId !== runId || active.parentSignal?.aborted) {
            throw Object.assign(new Error("活动运行不存在或已经变化"), { statusCode: 409 });
        }
        const duplicate = active.inputs.get(inputId);
        if (duplicate) {
            return duplicate;
        }
        active.hold();
        const revision = ++active.revision;
        const explicit = explicitControl(input, revision);
        if (explicit && !explicit.resumeAfterAnswer) {
            active.controller.abort("用户更新了本轮要求");
        }
        const promise = active.inputTail.then(() => this.acceptInput(active, inputId, input, revision, explicit)).finally(() => active.release());
        active.inputTail = promise.then(() => undefined, () => undefined);
        active.inputs.set(inputId, promise);
        return promise;
    }

    /** 分类并保存控制输入，失败时停止旧流程而不是继续产生副作用 */
    private async acceptInput(active: ActiveRun, inputId: string, input: string, revision: number, explicit?: TurnControl) {
        try {
            active.assertLease?.();
            const history = await sessionService.getSessionHistory(active.sessionId);
            const previous = [...history].reverse().find(item => item.turn.executionJson?.delivery)?.turn.executionJson?.delivery;
            const control = explicit ?? await classifyTurn(input, modelConfigManager.getModelConfig(), previous,
                history.flatMap(item => item.messages.filter(saved => saved.role === "user").map(saved => saved.content)), () => undefined, active.parentSignal, revision);
            const saved = db.transaction(tx => {
                active.assertLease?.();
                const row = sqlite.prepare("SELECT COALESCE(MAX(turn_no),0)+1 AS number FROM turn WHERE session_id=?").get(active.sessionId) as { number: number };
                const created = tx.insert(turn).values({ sessionId: active.sessionId, turnNo: row.number }).returning().get();
                const user = tx.insert(message).values({ turnId: created.id, role: "user", content: input }).returning().get();
                control.userMessageRef = `m:${user.id}`;
                return { inputId, message: input, turnId: created.id, turnNo: row.number, userMessageId: user.id, control };
            });
            if (control.resumeAfterAnswer && active.control && !active.controller.signal.aborted) {
                const summary = this.status(active.sessionId);
                const answer = "summary" in summary ? summary.summary :
                    `当前目标：${summary.goal}\n正在进行：${summary.phase}；已通过 ${summary.counts.passed ?? 0} 项，待评审 ${summary.counts.awaiting_review ?? 0} 项。`;
                const execution = this.shortExecution(control, modelConfigManager.getModelConfig());
                db.transaction(tx => {
                    active.assertLease?.();
                    tx.insert(message).values({ turnId: saved.turnId, role: "assistant", content: answer }).run();
                    tx.update(turn).set({ executionJson: execution }).where(eq(turn.id, saved.turnId)).run();
                });
                this.progressListeners.get(active.runId)?.({ type: "intermediate_text", content: answer, timestamp: Date.now() });
                active.control.instructionRevision = revision;
                active.control.userMessageRef = saved.control.userMessageRef;
            } else {
                active.pending.push(saved);
                active.controller.abort("用户更新了本轮要求");
            }
            return { inputId, instructionRevision: revision, status: "accepted" };
        } catch (error) {
            active.controller.abort("控制输入保存失败，停止后续执行");
            throw error;
        }
    }

    private readonly progressListeners = new Map<string, (step: AgentExecutionStep) => void>();

    /** 串行结算被打断的执行，再从已保存的新消息开始下一轮 */
    public async chat(sessionId: number | undefined, userInput: string,
        optionsOrStep?: ChatOptions | ((step: AgentExecutionStep) => void)): Promise<AgentRunResult> {
        const opts = typeof optionsOrStep === "function" ? { onStep: optionsOrStep } : optionsOrStep ?? {};
        const target = sessionId ? await sessionService.getSessionById(sessionId) : undefined;
        const selected = target ?? await sessionService.createSession("新对话", opts.projectId);
        if (this.active.has(selected.id)) {
            throw Object.assign(new Error("会话正在执行，请通过 /agent/chat/input 提交新要求"), { statusCode: 409 });
        }
        const runtime = new ActiveRun(selected.id);
        this.active.set(selected.id, runtime);
        if (opts.onStep) {
            this.progressListeners.set(runtime.runId, opts.onStep);
        }
        const timeout = AbortSignal.timeout(executionPolicy().runMs);
        const parent = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        runtime.parentSignal = parent;
        let prepared: PendingInput | undefined;
        let result: AgentRunResult;
        try {
            while (true) {
                const signal = AbortSignal.any([parent, runtime.controller.signal]);
                try {
                    result = await this.chatTurn(selected.id, prepared?.message ?? userInput, { ...opts, runtime, prepared, signal,
                        verification: prepared ? undefined : opts.verification, imagePaths: prepared ? undefined : opts.imagePaths });
                } catch (error) {
                    await runtime.ready();
                    if (!runtime.pending.length || parent.aborted) {
                        throw error;
                    }
                }
                await runtime.ready();
                if (!runtime.pending.length || parent.aborted) {
                    break;
                }
                const waiting = runtime.pending.splice(0).sort((left, right) => left.control.instructionRevision - right.control.instructionRevision);
                prepared = waiting.pop();
                for (const superseded of waiting) {
                    db.update(turn).set({ executionJson: { ...this.shortExecution(superseded.control, modelConfigManager.getModelConfig()),
                        status: "aborted", error: "后续用户要求已取代本轮执行，消息仍保留在历史中" } }).where(eq(turn.id, superseded.turnId)).run();
                }
                runtime.controller = new AbortController();
            }
            return result;
        } finally {
            this.active.delete(selected.id);
            this.progressListeners.delete(runtime.runId);
        }
    }

    /** 为无需工具的回答保存完整结束状态 */
    private shortExecution(control: TurnControl, model: ModelConfig): ExecutionRecord {
        return {
            control,
            phase: "finished",
            status: "completed",
            config: {
                model: model.model,
                requestedReasoningEffort: "off",
                thinking: "disabled",
                contextWindow: model.capabilities.contextWindow,
                maxTokens: 4096,
                retryMaxTokens: 4096,
                generationTimeoutMs: executionPolicy().answerMs
            },
            attempts: [],
            totalDurationMs: 0
        };
    }

    /** 纯问答只允许一次无工具请求，失败时返回已经保存的事实 */
    private async answer(input: string, control: TurnControl, task: DeliveryRecord | undefined, model: ModelConfig,
        diagnostics: RequestDiagnostics[], signal?: AbortSignal, recent: Array<{ role: string; content: string }> = [], images: ImageContent[] = []): Promise<string> {
        if (control.clarification) {
            return control.clarification;
        }
        if (control.intent === "stop") {
            return "已停止，不再启动后续工具或验收。\n" + taskFacts(task);
        }
        if (!images.length && (/(?:启动|进度|状态)/.test(input) || /^(?:请)?(?:直接|只)(?:回答|告诉我)(?:[，,].*)?[。！!\s]*$/.test(input))) {
            return taskFacts(task);
        }
        const timeout = AbortSignal.timeout(executionPolicy().answerMs);
        const request = prepareModelRequest({ systemPrompt: "根据已有事实直接回答本轮问题。没有工具，不能宣称重新检查、启动或验证。事实的时间代表最后观察时间，不代表当前状态。",
            messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ input, facts: taskFacts(task), recent }) }, ...images], timestamp: Date.now() }] },
            model.capabilities, "answer", "off", 4096, { apiKey: model.apiKey, maxRetries: 0, timeoutMs: executionPolicy().answerMs,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        const started = Date.now();
        try {
            const response = await streamSimple(request.model, request.context, request.options).result();
            finishRequestDiagnostics(request.diagnostics, response, started);
            signal?.throwIfAborted();
            if (response.stopReason !== "stop" || timeout.aborted) {
                throw new Error("回答未完成");
            }
            return response.content.filter(block => block.type === "text").map(block => block.text).join("") || taskFacts(task);
        } catch {
            signal?.throwIfAborted();
            request.diagnostics.failure = timeout.aborted ? "timeout" : "answer_failed";
            return taskFacts(task);
        } finally {
            request.diagnostics.durationMs = Date.now() - started;
            diagnostics.push(request.diagnostics);
        }
    }
    /** 显式压缩已有会话视图，保留所有原始历史 */
    public async compact(sessionId: number, onStatus?: (text: string) => void, signal?: AbortSignal) {
        if (!await sessionService.getSessionById(sessionId)) throw new Error("会话不存在");
        const store = new ContextStore(sqlite, sessionId, history => this.convertDbMessagesToAgent(history));
        store.acquire();
        try {
            const config = getAppConfig();
            const selected = modelConfigManager.getModelConfig();
            const model = sdkModel(selected.capabilities);
            const systemPrompt = buildSystemPrompt({ permissionMode: permissionManager.getMode() });
            const tools = [...toolRegistry.getAll(), createRecallTool(store)];
            const messages = await this.convertDbMessagesToAgent(await sessionService.getSessionHistory(sessionId));
            const before = applyContextArtifacts(contextEntries(messages), store.artifacts).flatMap(entry => entry.messages);
            const coordinator = new ContextCoordinator({
                model,
                capabilities: selected.capabilities,
                apiKey: selected.apiKey || config.llm.apiKey,
                systemPrompt,
                tools,
                turnId: -1,
                enabled: true,
                persistence: store,
                onStatus
            });
            await coordinator.prepare(
                messages,
                Math.min(selected.maxTokens, selected.capabilities.maxOutputTokens ?? selected.maxTokens),
                signal,
                false,
                true);
            return {
                beforeTokens: requestTokens(before, systemPrompt, tools),
                afterTokens: coordinator.record.estimatedInputTokens,
                context: coordinator.record
            };
        } finally { store.release(); }
    }

    /** 将数据库中的历史消息转换为 Pi Agent 可理解的上下文格式，支持多模态图片还原与工具调用分组规整 */
    private async convertDbMessagesToAgent(dbHistory: Array<{ turn: any; messages: any[] }>): Promise<AgentMessage[]> {
        const agentMessages: AgentMessage[] = [];

        for (const item of dbHistory) {
            const start = agentMessages.length;
            const recordedMessages = restoreRecordedMessages(item);
            let pendingToolCalls: Array<{ id: string; tool: string; args: any }> = [];

            /** 冲刷并生成包含并行 toolCall 块的单个 AssistantMessage */
            const flushPendingToolCalls = (timestamp: number) => {
                if (pendingToolCalls.length === 0) return;
                agentMessages.push({
                    role: "assistant",
                    content: pendingToolCalls.map((tc) => ({
                        type: "toolCall",
                        id: tc.id,
                        name: tc.tool,
                        arguments: tc.args || {}
                    })),
                    api: "openai-completions",
                    provider: "openai",
                    model: "model",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
                    },
                    stopReason: "toolUse",
                    timestamp
                });
                pendingToolCalls = [];
            };

            for (const msg of item.messages) {
                if (recordedMessages !== undefined && msg.role !== "user") continue;
                const msgTime = msg.createdAt ? new Date(msg.createdAt).getTime() : 0;

                // 用户输入消息
                if (msg.role === "user") {
                    flushPendingToolCalls(msgTime);
                    let textContent = msg.content;
                    const imageContents: ImageContent[] = [];

                    if (msg.content.startsWith("{") && msg.content.endsWith("}")) {
                        try {
                            const parsed = JSON.parse(msg.content);
                            if (parsed && typeof parsed.text === "string" && Array.isArray(parsed.imagePaths)) {
                                textContent = parsed.text;
                                for (const imgPath of parsed.imagePaths) {
                                    const img = await loadImageAsImageContent(imgPath);
                                    if (img) {
                                        imageContents.push(img);
                                    }
                                }
                            }
                        } catch {
                            // 保持原始字符串
                        }
                    }

                    // 放入messages集合
                    agentMessages.push(sourceMessage({
                        role: "user",
                        content: [
                            { type: "text", text: textContent },
                            ...imageContents
                        ],
                        timestamp: msgTime
                    }, `m:${msg.id}`, item.turn.id, item.turn.turnNo));
                }
                // 工具调用意图消息：暂存缓冲，待遇到结果或轮次结束时聚合成单一 assistant 消息
                else if (msg.role === "tool_call") {
                    try {
                        const parsed = JSON.parse(msg.content);
                        if (parsed && parsed.id && parsed.tool) {
                            pendingToolCalls.push({
                                id: parsed.id,
                                tool: parsed.tool,
                                args: parsed.args || {}
                            });
                        }
                    } catch {
                        // 忽略解析失败的消息
                    }
                }
                // 工具执行返回结果消息
                else if (msg.role === "tool_result") {
                    // 遇到首个工具结果时，立即冲刷对应的 tool_call 为合法的单一 assistant 消息
                    flushPendingToolCalls(msgTime);
                    try {
                        const parsed = JSON.parse(msg.content);
                        agentMessages.push({
                            role: "toolResult",
                            toolCallId: parsed.id,
                            toolName: parsed.tool,
                            content: restoreToolContent(parsed.result, parsed.tool),
                            isError: !!parsed.isError,
                            timestamp: msgTime
                        });
                    } catch {
                        // 忽略解析失败的消息
                    }
                }
                // 助手文本回复消息
                else if (msg.role === "assistant") {
                    flushPendingToolCalls(msgTime);
                    if (/^⚠️ (模型输出已被截断|模型生成未完成|模型调用异常|运行时异常)/.test(msg.content)) continue;
                    agentMessages.push({
                        role: "assistant",
                        content: [{ type: "text", text: msg.content }],
                        api: "openai-completions",
                        provider: "openai",
                        model: "model",
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
                        },
                        stopReason: "stop",
                        timestamp: msgTime
                    });
                }
            }
            flushPendingToolCalls(Date.now());
            if (recordedMessages !== undefined) {
                agentMessages.push(...recordedMessages);
            }
            annotateLegacyMessages(item, agentMessages.slice(start));
        }

        return agentMessages;
    }

    /** 驱动单轮会话的 Agent Loop 运算并执行完整持久化，支持项目隔离、权限交互与多模态图片传参 */
    private async chatTurn(
        sessionId: number | undefined,
        userInput: string,
        optionsOrStep?: ChatOptions | ((step: AgentExecutionStep) => void)
    ): Promise<AgentRunResult> {
        const config = getAppConfig();
        const modelConfig = modelConfigManager.getModelConfig();

        const opts = typeof optionsOrStep === "function" ? { onStep: optionsOrStep } : (optionsOrStep ?? {});
        const imagePaths = (opts as { imagePaths?: string[] }).imagePaths ?? [];

        // 加载本轮传入的图片资源
        const imageContents: ImageContent[] = [];
        for (const imgPath of imagePaths) {
            const img = await loadImageAsImageContent(imgPath);
            if (img) {
                imageContents.push(img);
            }
        }

        // 1. 获取或创建 Session（绑定所属工程）
        let targetSession = sessionId ? await sessionService.getSessionById(sessionId) : undefined;
        if (!targetSession) {
            targetSession = await sessionService.createSession("新对话", opts.projectId);
        }

        const contextStore = new ContextStore(sqlite, targetSession.id, history => this.convertDbMessagesToAgent(history));
        contextStore.acquire();
        const tasks = new TaskStore(sqlite, targetSession.id, () => contextStore.assertLease());
        if (opts.runtime) {
            opts.runtime.assertLease = () => contextStore.assertLease();
        }
        let acceptance: AcceptanceRuntime | undefined;
        try {
            /** 原始历史仅投影，不在入口预先截短或删除 */
            const rawHistory = (await sessionService.getSessionHistory(targetSession.id)).filter(item =>
                !opts.prepared || item.turn.turnNo < opts.prepared.turnNo);

            // 2. 当会话未设置定制标题或处于首轮问答阶段时，异步启动线程提炼标题
            const needsTitle = rawHistory.length === 0 || !targetSession.title || targetSession.title === "新对话";
            const auxiliaryRequests: RequestDiagnostics[] = [];

            const persistentContent = imagePaths.length > 0
                ? JSON.stringify({ text: userInput, imagePaths })
                : userInput;


            // 3. 计算本轮 turn 序号并写入 turn 表
            const nextTurnNo = opts.prepared?.turnNo ?? rawHistory.length + 1;
            const createdTurn = opts.prepared ? { id: opts.prepared.turnId } : db.insert(turn).values({
                sessionId: targetSession.id,
                turnNo: nextTurnNo
            }).returning().get();

            // 4. 将用户本次输入持久化到 message 表
            const userMessage = opts.prepared ? { id: opts.prepared.userMessageId } : db.insert(message).values({
                turnId: createdTurn.id,
                role: "user",
                content: persistentContent
            }).returning().get();
            if (opts.runtime && !opts.runtime.announced) {
                opts.runtime.announced = true;
                opts.onActive?.({ sessionId: targetSession.id, runId: opts.runtime.runId });
            }

            // 5. 每轮快照模型配置，重试沿用同一权限、输入与预算策略
            const currentPermissionMode = permissionManager.getMode();
            const currentProject = targetSession.projectId ? await projectService.getProjectById(targetSession.projectId) : undefined;
            const projectRoot = currentProject?.rootPath ?? process.cwd();

            // 在技能与验收准备之前确定本轮边界
            const previous = tasks.load(projectRoot, rawHistory, opts.verification?.taskId);
            const revision = opts.runtime?.revision ?? 1;
            const direct = explicitControl(userInput, revision);
            const control = opts.prepared?.control ?? direct ?? (opts.verification?.mode === "only" ? turnControl(userInput, "verify", revision) :
                await classifyTurn(userInput, modelConfig, previous,
                    rawHistory.flatMap(item => item.messages.filter(saved => saved.role === "user").map(saved => saved.content)),
                    value => auxiliaryRequests.push(value), opts.signal, revision));
            control.userMessageRef = `m:${userMessage.id}`;
            control.taskId = previous?.taskId;
            if (opts.verification?.mode === "only" && !["answer", "stop"].includes(control.intent)) {
                control.intent = "verify";
                control.scope = "contract";
                control.resumeTask = true;
                control.allowVerification = true;
                if (/(?:不要|别|停止|不用|先不)(?:再)?(?:测试|验收|验证|测)/.test(userInput)) {
                    control.intent = "answer";
                    control.scope = "none";
                    control.allowVerification = false;
                    control.clarification = "已按本轮不测试的要求停止验收，没有启动新操作。";
                }
            }
            if (opts.verification?.mode === "off") {
                control.allowVerification = false;
            }
            if (opts.runtime) {
                opts.runtime.control = control;
            }

            /** 从宿主状态生成终端及SSE共用的进度 */
            const publish = (record?: DeliveryRecord, phase = "running") => {
                const status = {
                    request: userInput.slice(0, 300),
                    runId: opts.runtime?.runId ?? "",
                    sessionId: targetSession.id,
                    taskId: record?.taskId ?? previous?.taskId,
                    goal: (record?.contract.originalInput ?? previous?.contract.originalInput ?? userInput).slice(0, 300),
                    intent: control.intent,
                    instructionRevision: control.instructionRevision,
                    phase,
                    counts: Object.fromEntries(["pending", "running", "awaiting_review", "passed", "failed", "blocked", "stale"]
                        .map(state => [state, record?.contract.checks.filter(check => check.status === state).length ?? 0])),
                    remainingMs: Math.max(0, Math.min(acceptance?.remainingBudgetMs ?? Infinity,
                        executionPolicy().runMs - (Date.now() - (opts.runtime?.startedAt ?? Date.now())))),
                    stoppedReason: record?.stoppedReason
                };
                if (opts.runtime) {
                    opts.runtime.status = status;
                }
                opts.onStep?.({ type: "task_status", taskStatus: status, timestamp: Date.now() });
                return status;
            };
            publish(previous, "routing");
            opts.signal?.throwIfAborted();
            if (["answer", "stop"].includes(control.intent)) {
                const recent = rawHistory.slice(-2).flatMap(item => item.messages.filter(saved => ["user", "assistant"].includes(saved.role)))
                    .map(saved => ({ role: saved.role, content: saved.content.slice(0, 6000) }));
                const reply = await this.answer(userInput, control, previous, modelConfig, auxiliaryRequests, opts.signal, recent, imageContents);
                const execution = this.shortExecution(control, modelConfig);
                execution.auxiliaryRequests = auxiliaryRequests;
                execution.taskStatus = publish(previous, "finished");
                db.transaction(tx => {
                    contextStore.assertLease();
                    tx.update(turn).set({ executionJson: execution }).where(eq(turn.id, createdTurn.id)).run();
                    tx.insert(message).values({ turnId: createdTurn.id, role: "assistant", content: reply }).run();
                });
                return { sessionId: targetSession.id, turnId: createdTurn.id, turnNo: nextTurnNo, reply, steps: [], status: "completed", execution };
            }

            const initialMessages = await this.convertDbMessagesToAgent(rawHistory);
            const taskHistory = previous ? [...rawHistory, { turn: { executionJson: { delivery: previous } as ExecutionRecord }, messages: [] }] : rawHistory;

            // 单独提取任务约定，技能选择和验收共用同一份产出要求
            const scopeInput = control.scope === "startup" ? "仅检查项目启动并探测服务就绪，不修改源码，不执行完整业务验收" : userInput;
            const verification = control.scope === "startup" || !["execute", "verify"].includes(control.intent) ? { mode: "off" as const } : {
                ...opts.verification, ...(control.resumeTask && previous && previous.status !== "passed" ? { taskId: previous.taskId } : {}),
                ...(control.intent === "verify" ? { mode: "only" as const } : {})
            };
            if (control.intent === "verify" && !previous?.contract.checks.some(check => check.required)) {
                throw new Error("当前没有需要恢复的完整验收任务");
            }
            const delivery = control.scope === "startup" && previous ? structuredClone(previous) :
                await prepareDelivery(scopeInput, projectRoot, taskHistory, modelConfig,
                    verification, diagnostics => auxiliaryRequests.push(diagnostics), opts.signal);
            opts.signal?.throwIfAborted();
            if (control.scope === "startup") {
                if (!previous) {
                    delivery.status = "pending";
                    delivery.contract.originalInput = userInput;
                }
                delivery.continuations = [];
            }
            control.taskId = delivery.taskId;
            let checkpointCurrent: (() => void) | undefined;
            if (delivery.planningError) {
                opts.onStep?.({ type: "status", content: `验收要求提取失败：${delivery.planningError}；继续可完成的开发，本轮保留未验收。`, timestamp: Date.now() });
            }

            // 为当前任务准备会话固定和自动选择的技能
            const skillRuntime = await prepareTurnSkills({
                projectRoot,
                skillState: targetSession.skillStateJson,
                userInput,
                history: rawHistory,
                modelConfig,
                outputs: control.scope !== "startup" && delivery.contract.kind === "implement" ? delivery.contract.outputs : [],
                visualRequired: control.scope !== "startup" && delivery.contract.kind === "implement" && delivery.status !== "not_required" &&
                    delivery.contract.outputs.some(output => output.startsWith("ui-")),
                onStatus: text => opts.onStep?.({ type: "status", content: text, timestamp: Date.now() }),
                onDiagnostics: diagnostics => auxiliaryRequests.push(diagnostics),
                signal: opts.signal
            });
            opts.signal?.throwIfAborted();
            acceptance = new AcceptanceRuntime({
                control,
                onCheckpoint: () => checkpointCurrent?.(),
                record: delivery,
                config: modelConfig,
                skills: skillRuntime,
                authorized: currentPermissionMode !== "read-only" && ["execute", "verify", "inspect"].includes(control.intent),
                turnId: createdTurn.id,
                turnNo: nextTurnNo,
                diagnostics: diagnostics => auxiliaryRequests.push(diagnostics),
                onStatus: text => opts.onStep?.({ type: "status", content: text, timestamp: Date.now() }),
                signal: opts.signal
            });
            await acceptance.initialize();
            skillRuntime.requireVisual(control.scope !== "startup" && delivery.contract.kind === "implement" && delivery.status !== "not_required" &&
                delivery.contract.outputs.some(output => output.startsWith("ui-")));
            const systemPrompt = buildSystemPrompt({ permissionMode: currentPermissionMode, skillCatalog: skillRuntime.registry.generatePromptCatalog() }) +
                `\n目标项目工作目录：${projectRoot}。文件操作使用该目录下的路径，命令的 cwd 明确使用该目录。` +
                (rawHistory.some(item => item.turn.executionJson?.pendingToolCallIds?.length) ?
                    "\n此前有结果未知的工具操作，先读取源码、日志或已有证据核实实际状态，不得直接重放这些副作用。" : "");
            const persistedSteps = new Set<string>();
            let latestSnapshot: ExecutionRecord | undefined;

            /** 原子保存执行快照和新增工具步骤，重复检查点不重复插入 */
            const saveCheckpoint = (snapshot: ExecutionRecord, steps: AgentExecutionStep[] = []): void => {
                contextStore.assertLease();
                snapshot.control = control;
                snapshot.taskStatus = publish(delivery, snapshot.phase === "finished" ? "finished" : delivery.status);
                snapshot.delivery = delivery.status === "not_required" ? undefined : structuredClone(delivery);
                const newKeys: string[] = [];
                db.transaction(tx => {
                    for (const step of steps) {
                        const key = [step.attemptNo, step.callNo, step.toolCallId, step.type].join(":");
                        if (persistedSteps.has(key) || newKeys.includes(key)) continue;
                        if (step.type !== "tool_call" && step.type !== "tool_result") continue;
                        tx.insert(message).values({
                            turnId: createdTurn.id, role: step.type,
                            content: JSON.stringify({
                                tool: step.toolName, id: step.toolCallId, attemptNo: step.attemptNo, callNo: step.callNo,
                                ...(step.type === "tool_call" ? { args: step.args } : { result: step.result, isError: step.isError })
                            })
                        }).run();
                        newKeys.push(key);
                    }
                    tx.update(turn).set({ executionJson: snapshot }).where(eq(turn.id, createdTurn.id)).run();
                    if (snapshot.delivery) {
                        tasks.save(snapshot.delivery);
                    }
                });
                if (snapshot.delivery) {
                    tasks.committed(snapshot.delivery);
                }
                latestSnapshot = snapshot;
                for (const key of newKeys) persistedSteps.add(key);
            };
            checkpointCurrent = () => {
                if (latestSnapshot) {
                    saveCheckpoint(latestSnapshot);
                }
            };

            const runner = new AgentRunner({
                control,
                beforeAction: () => opts.runtime?.ready(opts.signal) ?? Promise.resolve(),
                skillRuntime,
                acceptance,
                auxiliaryRequests,
                baseUrl: modelConfig.baseUrl || config.llm.baseUrl,
                model: modelConfig.model || config.llm.model,
                apiKey: modelConfig.apiKey || config.llm.apiKey,
                reasoningEffort: modelConfig.reasoningEffort,
                systemPrompt,
                projectRoot,
                contextWindow: modelConfig.capabilities.contextWindow,
                capabilities: modelConfig.capabilities,
                compactionEnabled: config.context.compactionEnabled,
                contextPersistence: contextStore,
                currentTurnId: createdTurn.id,
                currentTurnNo: nextTurnNo,
                userMessageId: userMessage.id,
                tools: [...toolRegistry.getAll().filter(tool => tool.name !== "activate_skill" && tool.name !== "read_skill_reference"),
                ...createSkillTools(skillRuntime), ...createAcceptanceTools(acceptance), createRecallTool(contextStore)],
                maxTokens: modelConfig.maxTokens,
                retryMaxTokens: modelConfig.retryMaxTokens,
                generationTimeoutMs: modelConfig.generationTimeoutMs,
                initialMessages,
                onStep: opts.onStep,
                onAskPermission: opts.onAskPermission,
                signal: acceptance.signal,
                /** 在下一次请求或工具执行前保存本次调用快照 */
                onExecution: saveCheckpoint
            });

            // 标题与主任务并行，迟到的诊断只补充当前轮执行记录
            if (needsTitle) {
                titleService.generateSessionTitleAsync(targetSession.id, userInput, modelConfig, diagnostics => {
                    auxiliaryRequests.push(diagnostics);
                    try {
                        db.transaction(tx => {
                            const stored = tx.select({ executionJson: turn.executionJson }).from(turn).where(eq(turn.id, createdTurn.id)).get();
                            if (stored?.executionJson) {
                                tx.update(turn).set({ executionJson: { ...stored.executionJson, auxiliaryRequests } }).where(eq(turn.id, createdTurn.id)).run();
                            }
                        });
                    } catch {
                        // 标题诊断写入失败不影响主任务检查点
                    }
                });
            }

            //* 6. 重点： 编排状态机恢复算法并返回可持久化的最终执行结果
            const output = await runner.run(userInput, imageContents);
            output.reply += skillRuntime.finish();

            // 清理结果先成为事实，再保存最终结论
            await acceptance.close();
            if (control.scope === "startup") {
                output.reply += "\n\n" + taskFacts(delivery);
            }

            // 7. 持久化工具调用过程及最终助手回复（更新DB数据）
            saveCheckpoint(output.execution, output.contextSteps);

            // 无论是否被截断，优先持久化打捞到的模型正文；无正文时持久化兜底说明，确保每轮会话数据完整
            const assistantContent = output.execution.delivery ? output.reply : output.modelReply || output.reply;
            if (assistantContent) {
                db.insert(message).values({
                    turnId: createdTurn.id,
                    role: "assistant",
                    content: assistantContent
                }).run();
            }

            /** 无论是否产生正文，都保存本轮尝试、用量与结束状态 */
            db.update(turn).set({ executionJson: output.execution }).where(eq(turn.id, createdTurn.id)).run();

            // 8. 更新 Session 的最后活跃时间
            await sessionService.updateSession(targetSession.id, { updatedAt: new Date() });

            return {
                sessionId: targetSession.id,
                turnId: createdTurn.id,
                turnNo: nextTurnNo,
                reply: output.reply,
                modelReply: output.modelReply,
                steps: output.steps,
                totalDurationMs: output.totalDurationMs,
                isTruncated: output.isTruncated,
                stopReason: output.stopReason,
                status: output.status,
                execution: output.execution,
                delivery: output.execution.delivery,
                responseQuality: output.responseQuality,
                salvaged: output.salvaged
            };
        } finally {
            try {
                await acceptance?.close();
            } finally {
                await opts.runtime?.ready();
                if (opts.runtime?.parentSignal?.aborted) {
                    for (const pending of opts.runtime.pending.splice(0)) {
                        const snapshot = this.shortExecution(pending.control, modelConfig);
                        snapshot.status = "aborted";
                        snapshot.error = "本次运行已经停止，输入已保存但未执行";
                        contextStore.assertLease();
                        db.update(turn).set({ executionJson: snapshot }).where(eq(turn.id, pending.turnId)).run();
                    }
                }
                if (opts.runtime) {
                    opts.runtime.assertLease = undefined;
                }
                contextStore.release();
            }
        }
    }
}

export const agentService = new AgentService();
