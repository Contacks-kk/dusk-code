import type { Request, Response } from "express";
import { agentService } from "../services/agent.service";

export class AgentController {
    /** 处理用户对话请求并运行 Agent Loop 交互接口 */
    public async chat(req: Request, res: Response): Promise<void> {
        try {
            const userInput = req.body.message ?? req.body.input;
            if (!userInput || typeof userInput !== "string") {
                res.status(400).json({ error: "请求体必须包含非空的 message 或 input 字符串" });
                return;
            }

            const sessionId = req.body.sessionId !== undefined ? Number(req.body.sessionId) : undefined;
            const result = await agentService.chat(sessionId, userInput);

            res.json({ data: result });
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Agent 执行异常" });
        }
    }

    /** 处理用户对话请求并以 SSE 流式输出 Agent 执行链路步骤与最终答复 */
    public async chatStream(req: Request, res: Response): Promise<void> {
        try {
            const userInput = req.body?.message ?? req.body?.input ?? req.query?.message;
            if (!userInput || typeof userInput !== "string") {
                res.status(400).json({ error: "请求必须包含非空的 message 或 input 字符串" });
                return;
            }

            const rawSessionId = req.body?.sessionId ?? req.query?.sessionId;
            const sessionId = rawSessionId !== undefined ? Number(rawSessionId) : undefined;

            // 建立标准 SSE 传输连接
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            // 驱动 Agent Loop 并将每一步生命周期事件实时写入 SSE 流
            const result = await agentService.chat(sessionId, userInput, (step) => {
                res.write(`data: ${JSON.stringify({ type: "step", step })}\n\n`);
            });

            // 推送最终完成信号与整体载荷
            res.write(`data: ${JSON.stringify({ type: "done", data: result })}\n\n`);
            res.end();
        } catch (error: any) {
            if (!res.headersSent) {
                res.status(500).json({ error: error.message || "Agent 执行异常" });
            } else {
                res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
                res.end();
            }
        }
    }
}

export const agentController = new AgentController();
