import { Router } from "express";
import { sessionController } from "../controllers/session.controller";

export const sessionRouter = Router();

sessionRouter.get("/", (req, res) => sessionController.list(req, res));
sessionRouter.post("/", (req, res) => sessionController.create(req, res));
sessionRouter.get("/:id/history", (req, res) => sessionController.getHistory(req, res));
