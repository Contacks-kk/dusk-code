import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { turn, message } from "../db/schema";
import { sessionService } from "./session.service";
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
import { modelConfigManager } from "../agent/runtime/model-config";
import { loadImageAsImageContent } from "../utils/image";
import { restoreRecordedMessages, annotateLegacyMessages } from "../agent/context/history";

export class AgentService {
    /** 显式压缩已有会话视图，保留所有原始历史 */
    public async compact(sessionId: number, onStatus?: (text: string) => void, signal?: AbortSignal) {
        if (!await sessionService.getSessionById(sessionId)) throw new Error("会话不存在");
        const store = new ContextStore(sqlite, sessionId, history => this.convertDbMessagesToAgent(history));
        store.acquire();
        try {
            const config = getAppConfig();
            const selected = modelConfigManager.getModelConfig();
            const model: Model<"openai-completions"> = { id: selected.model, name: selected.model, api: "openai-completions", provider: "openai",
                baseUrl: (selected.baseUrl || config.llm.baseUrl).replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/i, ""), reasoning: false,
                input: ["text", "image"], contextWindow: config.context.windowTokens, maxTokens: selected.maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
            const systemPrompt = buildSystemPrompt({ permissionMode: permissionManager.getMode() });
            const tools = [...toolRegistry.getAll(), createRecallTool(store)];
            const messages = await this.convertDbMessagesToAgent(await sessionService.getSessionHistory(sessionId));
            const before = applyContextArtifacts(contextEntries(messages), store.artifacts).flatMap(entry => entry.messages);
            const coordinator = new ContextCoordinator({ model, apiKey: selected.apiKey || config.llm.apiKey, systemPrompt, tools,
                turnId: -1, enabled: true, persistence: store, onStatus });
            await coordinator.prepare(messages, selected.maxTokens, signal, false, true);
            return { beforeTokens: requestTokens(before, systemPrompt, tools), afterTokens: coordinator.record.estimatedInputTokens,
                context: coordinator.record };
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
                        let resultText = "";
                        if (parsed.result && typeof parsed.result === "object" && parsed.result.content && Array.isArray(parsed.result.content)) {
                            resultText = parsed.result.content.map((c: any) => c.text || "").join("\n");
                        } else if (typeof parsed.result === "string") {
                            resultText = parsed.result;
                        } else {
                            resultText = JSON.stringify(parsed.result);
                        }
                        agentMessages.push({
                            role: "toolResult",
                            toolCallId: parsed.id,
                            toolName: parsed.tool,
                            content: [{ type: "text", text: resultText }],
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
    public async chat(
        sessionId: number | undefined,
        userInput: string,
        optionsOrStep?: {
            projectId?: number;
            onStep?: (step: AgentExecutionStep) => void;
            onAskPermission?: (prompt: string) => Promise<boolean>;
            imagePaths?: string[];
            signal?: AbortSignal;
        } | ((step: AgentExecutionStep) => void)
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
            const initialTitle = userInput.slice(0, 30) || "新对话";
            targetSession = await sessionService.createSession(initialTitle, opts.projectId);
        }

        const contextStore = new ContextStore(sqlite, targetSession.id, history => this.convertDbMessagesToAgent(history));
        contextStore.acquire();
        try {
            /** 原始历史仅投影，不在入口预先截短或删除 */
            const rawHistory = await sessionService.getSessionHistory(targetSession.id);
            const persistentContent = imagePaths.length > 0
                ? JSON.stringify({ text: userInput, imagePaths })
                : userInput;

            const initialMessages = await this.convertDbMessagesToAgent(rawHistory);

            // 3. 计算本轮 turn 序号并写入 turn 表
            const nextTurnNo = rawHistory.length + 1;
            const createdTurn = db.insert(turn).values({
                sessionId: targetSession.id,
                turnNo: nextTurnNo
            }).returning().get();

            // 4. 将用户本次输入持久化到 message 表
            const userMessage = db.insert(message).values({
                turnId: createdTurn.id,
                role: "user",
                content: persistentContent
            }).returning().get();

            // 5. 每轮快照模型配置，重试沿用同一权限、输入与预算策略
            const currentPermissionMode = permissionManager.getMode();
            const systemPrompt = buildSystemPrompt({ permissionMode: currentPermissionMode });
            const persistedSteps = new Set<string>();
            /** 原子保存执行快照和新增工具步骤，重复检查点不重复插入 */
            const saveCheckpoint = (snapshot: ExecutionRecord, steps: AgentExecutionStep[] = []): void => {
                contextStore.assertLease();
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
                });
                for (const key of newKeys) persistedSteps.add(key);
            };

            const runner = new AgentRunner({
                baseUrl: modelConfig.baseUrl || config.llm.baseUrl,
                model: modelConfig.model || config.llm.model,
                apiKey: modelConfig.apiKey || config.llm.apiKey,
                reasoningEffort: modelConfig.reasoningEffort,
                systemPrompt,
                contextWindow: config.context.windowTokens,
                compactionEnabled: config.context.compactionEnabled,
                contextPersistence: contextStore,
                currentTurnId: createdTurn.id,
                currentTurnNo: nextTurnNo,
                userMessageId: userMessage.id,
                tools: [...toolRegistry.getAll(), createRecallTool(contextStore)],
                maxTokens: modelConfig.maxTokens,
                retryMaxTokens: modelConfig.retryMaxTokens,
                generationTimeoutMs: modelConfig.generationTimeoutMs,
                initialMessages,
                onStep: opts.onStep,
                onAskPermission: opts.onAskPermission,
                signal: opts.signal,
                /** 在下一次请求或工具执行前保存本次调用快照 */
                onExecution: saveCheckpoint
            });

            // 6. 编排状态机恢复算法并返回可持久化的最终执行结果
            const output = await runner.run(userInput, imageContents);

            // 7. 持久化工具调用过程及最终助手回复
            saveCheckpoint(output.execution, output.contextSteps);

            // 无论是否被截断，优先持久化打捞到的模型正文；无正文时持久化兜底说明，确保每轮会话数据完整
            const assistantContent = output.modelReply || output.reply;
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
                responseQuality: output.responseQuality,
                salvaged: output.salvaged
            };
        } finally {
            contextStore.release();
        }
    }
}

export const agentService = new AgentService();
