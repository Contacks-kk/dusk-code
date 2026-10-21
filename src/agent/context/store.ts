import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ContextArtifact, ContextMessage, ContextPersistence } from "./types";
import type { StoredHistoryTurn } from "./history";
import { sourceMessage } from "./types";

export class SessionBusyError extends Error {
    statusCode = 409;
    /** 创建可由 HTTP 与 CLI 识别的会话占用错误 */
    constructor() { super("该会话正在执行其他任务，请等待当前任务结束"); }
}

export class ContextStore implements ContextPersistence {
    revision = 0;
    artifacts: ContextArtifact[] = [];
    private readonly owner = randomUUID();
    private heartbeat?: ReturnType<typeof setInterval>;
    private lost = false;

    /** 绑定当前会话数据库与历史投影方法 */
    constructor(private readonly database: Database.Database, public readonly sessionId: number,
        private readonly project: (history: StoredHistoryTurn[]) => Promise<ContextMessage[]>) {}

    /** 原子获取会话租约并加载跨重启有效的上下文视图 */
    acquire(): void {
        this.database.transaction(() => {
            const now = Date.now();
            this.database.prepare("INSERT OR IGNORE INTO session_context_state(session_id) VALUES (?)").run(this.sessionId);
            const acquired = this.database.prepare(`UPDATE session_context_state SET owner_id=?, lease_until=?, updated_at=?
                WHERE session_id=? AND (owner_id IS NULL OR lease_until<=?)`).run(this.owner, now + 30000, now, this.sessionId, now);
            if (!acquired.changes) throw new SessionBusyError();
            const state = this.database.prepare("SELECT revision, artifact_ids FROM session_context_state WHERE session_id=?").get(this.sessionId) as any;
            this.revision = state.revision;
            const ids = JSON.parse(state.artifact_ids) as string[];
            this.artifacts = ids.flatMap(id => {
                const row = this.database.prepare("SELECT payload_json FROM context_artifact WHERE id=? AND session_id=?").get(id, this.sessionId) as any;
                return row ? [JSON.parse(row.payload_json)] : [];
            });
        }).immediate();
        this.heartbeat = setInterval(() => {
            try {
                const renewed = this.database.prepare(`UPDATE session_context_state SET lease_until=?
                    WHERE session_id=? AND owner_id=? AND lease_until>?`).run(Date.now() + 30000, this.sessionId, this.owner, Date.now());
                if (!renewed.changes) this.lost = true;
            } catch { this.lost = true; }
        }, 10000);
        this.heartbeat.unref();
    }

    /** 校验当前运行仍持有写租约 */
    assertLease(): void {
        const row = this.database.prepare("SELECT owner_id, lease_until FROM session_context_state WHERE session_id=?").get(this.sessionId) as any;
        if (this.lost || row?.owner_id !== this.owner || row.lease_until <= Date.now()) throw new Error("会话执行租约已失效，禁止继续写入或执行工具");
    }

    /** 释放本次运行的租约和续租计时器 */
    release(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.database.prepare("UPDATE session_context_state SET owner_id=NULL, lease_until=0 WHERE session_id=? AND owner_id=?")
            .run(this.sessionId, this.owner);
    }

    /** 在同一短事务中提交不可变记录与活动视图版本 */
    commit(artifacts: ContextArtifact[], added: ContextArtifact, validate: () => boolean): number {
        const next = this.database.transaction(() => {
            this.assertLease();
            if (!validate()) throw new Error("上下文来源已变化，取消切换摘要视图");
            if (!artifacts.some(artifact => artifact.id === added.id)) throw new Error("活动视图没有包含本次上下文记录");
            for (const artifact of artifacts) {
                if (artifact.sessionId !== this.sessionId) throw new Error("上下文记录不属于当前会话");
                this.database.prepare("INSERT OR IGNORE INTO context_artifact(id,session_id,payload_json,created_at) VALUES (?,?,?,?)")
                    .run(artifact.id, this.sessionId, JSON.stringify(artifact), artifact.createdAt);
            }
            const updated = this.database.prepare(`UPDATE session_context_state SET artifact_ids=?, revision=revision+1, updated_at=?
                WHERE session_id=? AND revision=? AND owner_id=?`).run(JSON.stringify(artifacts.map(item => item.id)), Date.now(),
                    this.sessionId, this.revision, this.owner);
            if (!updated.changes) throw new Error("上下文版本冲突，取消切换摘要视图");
            return this.revision + 1;
        }).immediate();
        this.revision = next;
        this.artifacts = artifacts;
        return next;
    }

    /** 按会话内原始定位读取消息，拒绝跨会话来源 */
    async readSources(refs: string[]): Promise<ContextMessage[]> {
        const turnIds = new Set<number>();
        for (const ref of refs) {
            const message = /^m:(\d+)$/.exec(ref);
            const sourceTurn = /^t:(\d+):/.exec(ref);
            if (message) {
                const row = this.database.prepare(`SELECT m.turn_id FROM message m JOIN turn t ON t.id=m.turn_id
                    WHERE m.id=? AND t.session_id=?`).get(Number(message[1]), this.sessionId) as any;
                if (row) turnIds.add(row.turn_id);
            } else if (sourceTurn) turnIds.add(Number(sourceTurn[1]));
        }
        const messages: ContextMessage[] = [];
        for (const id of turnIds) {
            const item = this.loadTurn(id);
            if (item) {
                messages.push(...await this.project([item]));
                for (const [index, step] of (item.turn.executionJson?.recoverySteps ?? []).entries()) {
                    if (step.note) messages.push(sourceMessage({ role: "user", content: step.note, timestamp: 0 },
                        `t:${id}:recovery:${index + 2}`, id, item.turn.turnNo));
                }
            }
        }
        const byRef = new Map(messages.map(message => [message.contextSource?.ref, message]));
        return refs.flatMap(ref => byRef.has(ref) ? [byRef.get(ref)!] : []);
    }

    /** 读取一个会话内轮次及完整原始消息 */
    private loadTurn(id: number): StoredHistoryTurn | undefined {
        const row = this.database.prepare("SELECT * FROM turn WHERE id=? AND session_id=?").get(id, this.sessionId) as any;
        if (!row) return undefined;
        return { turn: { id: row.id, turnNo: row.turn_no, executionJson: row.execution_json ? JSON.parse(row.execution_json) : null },
            messages: (this.database.prepare("SELECT id,role,content,created_at AS createdAt FROM message WHERE turn_id=? ORDER BY id").all(id) as any[])
                .map(message => ({ ...message, createdAt: message.createdAt ? new Date(message.createdAt * 1000) : null })) };
    }

    /** 按轮次分页扫描归档，避免一次加载全部历史 */
    async search(query: string, turnId?: number, cursor = 0, sourceOffset = 0): Promise<{ messages: ContextMessage[]; nextCursor?: number; nextSourceOffset?: number }> {
        const rows = this.database.prepare(`SELECT id FROM turn WHERE session_id=? AND (id>? OR (id=? AND ?>0))
            AND (? IS NULL OR id=?) ORDER BY id LIMIT 10`).all(this.sessionId, cursor, cursor, sourceOffset,
                turnId ?? null, turnId ?? null) as Array<{ id: number }>;
        const found: ContextMessage[] = [];
        let scanned = cursor;
        for (const row of rows) {
            const item = this.loadTurn(row.id)!;
            const messages = await this.project([item]);
            for (let index = row.id === cursor ? sourceOffset : 0; index < messages.length; index++) {
                if (JSON.stringify(messages[index].content).toLocaleLowerCase().includes(query.toLocaleLowerCase())) found.push(messages[index]);
                if (found.length === 5) return { messages: found, nextCursor: row.id,
                    nextSourceOffset: index + 1 < messages.length ? index + 1 : 0 };
            }
            scanned = row.id;
            if (found.length >= 5) break;
        }
        return { messages: found, nextCursor: rows.length === 10 ? scanned : undefined };
    }
}
