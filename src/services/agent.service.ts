import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { turn, message } from "../db/schema";
import { sessionService } from "./session.service";
import { AgentRunner } from "../agent/runner";
import { getAppConfig } from "../config/env";
import type { AgentRunResult, AgentExecutionStep } from "../agent/types";
import { pruneHistoryContext, CONTEXT_LIMITS } from "../agent/context/pruner";
import { estimateTokenCount } from "../agent/context/token";
import { buildSystemPrompt } from "../agent/prompt";
import { permissionManager } from "../agent/runtime/permission-manager";
import { modelConfigManager } from "../agent/runtime/model-config";
import { loadImageAsImageContent } from "../utils/image";
import { restoreRecordedMessages } from "../agent/context/history";

export class AgentService {
    /** 将数据库中的历史消息转换为 Pi Agent 可理解的上下文格式，支持多模态图片还原与工具调用分组规整 */
    private async convertDbMessagesToAgent(dbHistory: Array<{ turn: any; messages: any[] }>): Promise<AgentMessage[]> {
        const agentMessages: AgentMessage[] = [];

        for (const item of dbHistory) {
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
                const msgTime = msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now();

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
                    agentMessages.push({
                        role: "user",
                        content: [
                            { type: "text", text: textContent },
                            ...imageContents
                        ],
                        timestamp: msgTime
                    });
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
            if (recordedMessages !== undefined) agentMessages.push(...recordedMessages);
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

        // 2. 加载该 Session 的原始历史并进行分级上下文衰减裁剪（128K 上限与双水位保障）
        const rawHistory = await sessionService.getSessionHistory(targetSession.id);
        const persistentContent = imagePaths.length > 0
            ? JSON.stringify({ text: userInput, imagePaths })
            : userInput;

        // 2.1 估算此次输入的tokens数，用于后续上下文预算
        const inputTokens = estimateTokenCount(persistentContent);

        // 2.2 裁剪原始历史，保留足够的可理解的上下文（考虑预留给输出的最大token数）
        const safeHistory = pruneHistoryContext(rawHistory, inputTokens);

        // 2.3 将数据库中的历史消息转换为 Pi Agent 可理解的上下文格式
        const initialMessages = await this.convertDbMessagesToAgent(safeHistory);

        // 3. 计算本轮 turn 序号并写入 turn 表
        const nextTurnNo = rawHistory.length + 1;
        const createdTurn = db.insert(turn).values({
            sessionId: targetSession.id,
            turnNo: nextTurnNo
        }).returning().get();

        // 4. 将用户本次输入持久化到 message 表
        db.insert(message).values({
            turnId: createdTurn.id,
            role: "user",
            content: persistentContent
        }).run();

        // 5. 每轮快照模型配置，重试沿用同一权限、输入与预算策略
        const currentPermissionMode = permissionManager.getMode();
        const systemPrompt = buildSystemPrompt({ permissionMode: currentPermissionMode });

        const runner = new AgentRunner({
            baseUrl: modelConfig.baseUrl || config.llm.baseUrl,
            model: modelConfig.model || config.llm.model,
            apiKey: modelConfig.apiKey || config.llm.apiKey,
            reasoningEffort: modelConfig.reasoningEffort,
            systemPrompt,
            contextWindow: CONTEXT_LIMITS.MAX_CONTEXT_TOKENS,
            maxTokens: modelConfig.maxTokens,
            retryMaxTokens: modelConfig.retryMaxTokens,
            generationTimeoutMs: modelConfig.generationTimeoutMs,
            initialMessages,
            onStep: opts.onStep,
            onAskPermission: opts.onAskPermission,
            /** 在下一次请求或工具执行前保存本次调用快照 */
            onExecution: snapshot => {
                db.update(turn).set({ executionJson: snapshot }).where(eq(turn.id, createdTurn.id)).run();
            }
        });

        // 6. 编排状态机恢复算法并返回可持久化的最终执行结果
        const output = await runner.run(userInput, imageContents);

        // 7. 持久化工具调用过程及最终助手回复
        for (const step of output.contextSteps) {
            if (step.type === "tool_call") {
                db.insert(message).values({
                    turnId: createdTurn.id,
                    role: "tool_call",
                    content: JSON.stringify({
                        tool: step.toolName,
                        id: step.toolCallId,
                        args: step.args
                    })
                }).run();
            } else if (step.type === "tool_result") {
                db.insert(message).values({
                    turnId: createdTurn.id,
                    role: "tool_result",
                    content: JSON.stringify({
                        tool: step.toolName,
                        id: step.toolCallId,
                        result: step.result,
                        isError: step.isError
                    })
                }).run();
            }
        }

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
    }
}

export const agentService = new AgentService();
