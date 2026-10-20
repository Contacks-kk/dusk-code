import { eq, desc } from "drizzle-orm";
import * as path from "node:path";
import { db } from "../db";
import { project, session, type Project, type Session } from "../db/schema";

export class ProjectService {
    /** 规范化工作区路径，消除大小写与末尾斜杠不一致 */
    private normalizePath(rawPath: string): string {
        const resolved = path.resolve(rawPath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }

    /** 根据当前工作目录获取或自动登记新项目实体 */
    public async getOrCreateProject(cwd: string = process.cwd()): Promise<Project> {
        const normalized = this.normalizePath(cwd);
        const projectName = path.basename(path.resolve(cwd)) || "root";

        const existing = db.select().from(project).where(eq(project.rootPath, normalized)).get();
        if (existing) {
            return existing;
        }

        const created = db.insert(project).values({
            name: projectName,
            rootPath: normalized
        }).returning().get();

        return created;
    }

    /** 查询指定工程归属下的全部会话记录 */
    public async listProjectSessions(projectId: number): Promise<Session[]> {
        return db.select()
            .from(session)
            .where(eq(session.projectId, projectId))
            .orderBy(desc(session.updatedAt));
    }

    /** 根据主键 ID 获取工程详情 */
    public async getProjectById(projectId: number): Promise<Project | undefined> {
        return db.select().from(project).where(eq(project.id, projectId)).get();
    }
}

export const projectService = new ProjectService();
