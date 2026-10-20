import type { Request, Response } from "express";
import { sessionService } from "../services/session.service";

export class SessionController {
    /** 查询所有会话列表接口 */
    public async list(req: Request, res: Response): Promise<void> {
        try {
            const list = await sessionService.listSessions();
            res.json({ data: list });
        } catch (error: any) {
            res.status(500).json({ error: error.message || "获取会话列表失败" });
        }
    }

    /** 手动创建新会话接口 */
    public async create(req: Request, res: Response): Promise<void> {
        try {
            const title = req.body.title;
            const created = await sessionService.createSession(title);
            res.json({ data: created });
        } catch (error: any) {
            res.status(500).json({ error: error.message || "创建会话失败" });
        }
    }

    /** 查询指定会话的完整轮次及历史记录接口 */
    public async getHistory(req: Request, res: Response): Promise<void> {
        try {
            const sessionId = Number(req.params.id);
            if (!sessionId || Number.isNaN(sessionId)) {
                res.status(400).json({ error: "sessionId 必须为有效数字" });
                return;
            }
            const history = await sessionService.getSessionHistory(sessionId);
            res.json({ data: history });
        } catch (error: any) {
            res.status(500).json({ error: error.message || "获取历史记录失败" });
        }
    }
}

export const sessionController = new SessionController();
