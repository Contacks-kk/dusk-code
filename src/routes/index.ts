import { Router } from "express";
import { sessionRouter } from "./session.route";
import { agentRouter } from "./agent.route";
import { agentController } from "../controllers/agent.controller";

export const apiRouter = Router();

apiRouter.use("/sessions", sessionRouter);
apiRouter.use("/agent", agentRouter);

// 兼容直接请求 /api/chat 的场景
apiRouter.post("/chat", (req, res) => agentController.chat(req, res));
