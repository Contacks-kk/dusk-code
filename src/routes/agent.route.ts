import { Router } from "express";
import { agentController } from "../controllers/agent.controller";

export const agentRouter = Router();

agentRouter.post("/chat", (req, res) => agentController.chat(req, res));
agentRouter.post("/chat/stream", (req, res) => agentController.chatStream(req, res));
agentRouter.get("/chat/stream", (req, res) => agentController.chatStream(req, res));
