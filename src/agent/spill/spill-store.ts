import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpillRef, SpillSaveRequest } from "./types";

export class SpillStore {
    /** 为同一次调用创建不会覆盖其他产物的目录 */
    static async createCallDirectory(req: Pick<SpillSaveRequest, "projectRoot" | "sessionId" | "toolName" | "toolCallId">): Promise<string> {
        const root = await this.ensureSpillDir(req.projectRoot, req.sessionId);
        const prefix = `${req.toolName}_${req.toolCallId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
        return fs.mkdtemp(path.join(root, `${prefix}_`));
    }
    /** 确保会话专属的 spill 存储目录存在 */
    static async ensureSpillDir(projectRoot: string, sessionId: number): Promise<string> {
        const dir = path.resolve(
            projectRoot,
            ".dusk",
            "spills",
            String(sessionId)
        );

        // 创建多层级存储目录
        await fs.mkdir(dir, {
            recursive: true
        });
        return dir;
    }

    /** 将超长文本原样完整持久化到文件 */
    static async saveText(req: SpillSaveRequest): Promise<Pick<SpillRef, "locator" | "relativePath" | "absolutePath" | "totalBytes" | "totalLines">> {
        // 获取落盘物理路径
        const dir = await this.createCallDirectory(req);
        const fileName = req.source === "details" ? "details.json" : "result.json";
        const absolutePath = path.resolve(dir, fileName);
        const relativePath = path.relative(req.projectRoot, absolutePath).replace(/\\/g, "/");

        // 全量写入原始文本
        const handle = await fs.open(absolutePath, "wx", 0o600);
        try {
            await handle.writeFile(req.content, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }

        const totalBytes = Buffer.byteLength(req.content, "utf-8");
        const totalLines = req.content.split(/\r?\n/).length;

        return {
            locator: relativePath,
            relativePath,
            absolutePath,
            totalBytes,
            totalLines
        };
    }
}
