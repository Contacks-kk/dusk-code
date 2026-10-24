import type { Request, Response } from "express";
import { agentService } from "../services/agent.service";
import { parseVerificationOptions } from "../agent/acceptance/requirements";

export class AgentController {
    /** 把新要求交给活动运行，重复请求只接收一次 */
    public async input(req: Request, res: Response): Promise<void> {
        const { sessionId, runId, inputId, message } = req.body ?? {};
        if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || typeof runId !== "string" || !runId ||
            typeof inputId !== "string" || !inputId || inputId.length > 128 || typeof message !== "string" || !message.trim()) {
            res.status(400).json({ error: "需要合法的 sessionId、runId、inputId 和非空 message" });
            return;
        }
        try {
            res.status(202).json(await agentService.input(sessionId, runId, inputId, message));
        } catch (error) {
            const failure = error as Error & { statusCode?: number };
            res.status(failure.statusCode ?? 500).json({ error: failure.message });
        }
    }
    /** 处理用户对话请求并运行 Agent Loop 交互接口 */
    public async chat(req: Request, res: Response): Promise<void> {
        const controller = new AbortController();
        /** 客户端提前断开时取消模型并保存已收到的片段 */
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", disconnected);
        try {
            const userInput = req.body.message ?? req.body.input;
            if (!userInput || typeof userInput !== "string") {
                res.status(400).json({ error: "请求体必须包含非空的 message 或 input 字符串" });
                return;
            }

            const sessionId = req.body.sessionId !== undefined ? Number(req.body.sessionId) : undefined;
            const verification = parseVerificationOptions(req.body.verification);
            const result = await agentService.chat(sessionId, userInput, { signal: controller.signal, verification });

            if (!res.destroyed) res.json({ data: result });
        } catch (error: any) {
            if (!res.destroyed) res.status(error.statusCode ?? 500).json({ error: error.message || "Agent 执行异常" });
        } finally {
            res.off("close", disconnected);
        }
    }

    /** 处理用户对话请求并以 SSE 流式输出 Agent 执行链路步骤与最终答复 */
    public async chatStream(req: Request, res: Response): Promise<void> {
        const controller = new AbortController();
        /** SSE 连接提前断开时取消活动任务 */
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", disconnected);
        try {
            const userInput = req.body?.message ?? req.body?.input ?? req.query?.message;
            if (!userInput || typeof userInput !== "string") {
                res.status(400).json({ error: "请求必须包含非空的 message 或 input 字符串" });
                return;
            }

            const rawSessionId = req.body?.sessionId ?? req.query?.sessionId;
            const sessionId = rawSessionId !== undefined ? Number(rawSessionId) : undefined;
            const verification = parseVerificationOptions(req.body?.verification ?? req.query?.verification);

            // 建立标准 SSE 传输连接
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            // 驱动 Agent Loop 并将每一步生命周期事件实时写入 SSE 流
            const result = await agentService.chat(sessionId, userInput, {
                onActive: value => {
                    if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ type: "active", ...value })}\n\n`);
                    }
                },
                signal: controller.signal,
                verification,
                onStep: step => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "step", step })}\n\n`); }
            });

            // 推送最终完成信号与整体载荷
            if (!res.destroyed) {
                res.write(`data: ${JSON.stringify({
                    type: "done",
                    executionStatus: result.status,
                    deliveryStatus: result.delivery?.status,
                    data: result
                })}\n\n`);
                res.end();
            }
        } catch (error: any) {
            if (res.destroyed) return;
            if (!res.headersSent) {
                res.status(error.statusCode ?? 500).json({ error: error.message || "Agent 执行异常" });
            } else {
                res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
                res.end();
            }
        } finally {
            res.off("close", disconnected);
        }
    }
}

export const agentController = new AgentController();
