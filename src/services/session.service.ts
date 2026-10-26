import { eq, desc, asc } from "drizzle-orm";
import { db } from "../db";
import { session, turn, message, type Session, type Turn, type Message } from "../db/schema";
import { normalizeSkillState } from "../agent/skills/state";
import type { SessionSkillState } from "../agent/skills/types";

export class SessionService {
    /** 保存当前会话的固定技能与禁用名单 */
    public async saveSkillState(sessionId: number, state: SessionSkillState): Promise<void> {
        const updated = db.update(session).set({
            skillStateJson: normalizeSkillState(state),
            updatedAt: new Date()
        }).where(eq(session.id, sessionId)).returning({ id: session.id }).get();
        if (!updated) {
            throw new Error("会话不存在，无法保存技能状态");
        }
    }

    /** 获取会话持久化的计划模式状态 */
    public async getPlanMode(sessionId: number): Promise<boolean> {
        // 读取指定会话记录
        const found = db.select({ planMode: session.planMode })
            .from(session)
            .where(eq(session.id, sessionId))
            .get();

        return (found?.planMode ?? 0) === 1;
    }

    /** 设置会话持久化的计划模式状态 */
    public async setPlanMode(sessionId: number, active: boolean): Promise<void> {
        // 更新会话计划模式标记与时间戳
        const updated = db.update(session).set({
            planMode: active ? 1 : 0,
            updatedAt: new Date()
        }).where(eq(session.id, sessionId)).returning({ id: session.id }).get();

        if (!updated) {
            throw new Error("会话不存在，无法更新计划模式状态");
        }
    }

    /** 创建新的对话会话并绑定所属工程 */
    public async createSession(title?: string, projectId?: number): Promise<Session> {
        const defaultTitle = title || "新对话";
        const created = db.insert(session).values({
            title: defaultTitle,
            projectId: projectId ?? null
        }).returning().get();

        return created;
    }

    /** 根据 ID 获取会话信息 */
    public async getSessionById(sessionId: number): Promise<Session | undefined> {
        const found = db.select().from(session).where(eq(session.id, sessionId)).get();
        return found;
    }

    /** 获取会话列表（支持按工程过滤，按更新时间降序） */
    public async listSessions(projectId?: number): Promise<Session[]> {
        if (projectId !== undefined) {
            return db.select()
                .from(session)
                .where(eq(session.projectId, projectId))
                .orderBy(desc(session.updatedAt));
        }
        return db.select().from(session).orderBy(desc(session.updatedAt));
    }

    /** 更新会话的更新时间与标题 */
    public async updateSession(sessionId: number, data: { title?: string; updatedAt?: Date }): Promise<void> {
        db.update(session)
            .set({
                ...(data.title ? { title: data.title } : {}),
                updatedAt: data.updatedAt ?? new Date()
            })
            .where(eq(session.id, sessionId))
            .run();
    }

    /** 查询指定会话的全部轮次及关联消息 */
    public async getSessionHistory(sessionId: number): Promise<Array<{ turn: Turn; messages: Message[] }>> {
        const turns = db.select().from(turn).where(eq(turn.sessionId, sessionId)).orderBy(asc(turn.turnNo), asc(turn.id)).all();
        const result: Array<{ turn: Turn; messages: Message[] }> = [];

        for (const t of turns) {
            const msgs = db.select().from(message).where(eq(message.turnId, t.id)).orderBy(asc(message.id)).all();
            result.push({ turn: t, messages: msgs });
        }

        return result;
    }
}

export const sessionService = new SessionService();
