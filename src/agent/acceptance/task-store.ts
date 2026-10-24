import type Database from "better-sqlite3";
import * as path from "node:path";
import type { DeliveryRecord } from "./types";
import type { StoredHistoryTurn } from "../context/history";
import type { TaskStatus } from "../types";

export class TaskStore {
    private readonly versions = new Map<string, number>();

    /** 绑定当前会话的数据库与租约检查 */
    constructor(private readonly database: Database.Database, private readonly sessionId: number,
        private readonly assertLease: () => void) { }

    /** 按当前平台统一任务目录，兼容旧记录中的Windows大小写差异 */
    private rootKey(root: string): string {
        const resolved = path.resolve(root);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }

    /** 查找任务快照，旧任务仅在实际引用时导入 */
    load(root: string, history: StoredHistoryTurn[], taskId?: string): DeliveryRecord | undefined {
        const row = this.database.prepare(`SELECT task_id, state_json, revision FROM task_state
            WHERE session_id=? AND project_root=? AND (? IS NULL OR task_id=?) ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
            .get(this.sessionId, this.rootKey(root), taskId ?? null, taskId ?? null) as { task_id: string; state_json: string; revision: number } | undefined;
        if (row) {
            this.versions.set(row.task_id, row.revision);
            return JSON.parse(row.state_json) as DeliveryRecord;
        }
        const old = [...history].reverse().map(item => item.turn.executionJson?.delivery).find(item => item &&
            item.status !== "not_required" && this.rootKey(item.projectRoot) === this.rootKey(root) && (!taskId || item.taskId === taskId));
        if (!old) {
            return undefined;
        }
        const imported = structuredClone(old);
        this.database.transaction(() => this.save(imported))();
        this.committed(imported);
        return imported;
    }

    /** 在调用方事务内按版本保存任务，防止迟到的快照覆盖新进度 */
    save(record: DeliveryRecord): void {
        this.assertLease();
        const revision = this.versions.get(record.taskId);
        if (revision === undefined) {
            this.database.prepare(`INSERT INTO task_state(task_id, session_id, project_root, state_json, revision, updated_at)
                VALUES (?, ?, ?, ?, 0, ?)`).run(record.taskId, this.sessionId, this.rootKey(record.projectRoot), JSON.stringify(record), Date.now());
        } else {
            const result = this.database.prepare(`UPDATE task_state SET state_json=?, revision=revision+1, updated_at=?
                WHERE task_id=? AND session_id=? AND revision=?`).run(JSON.stringify(record), Date.now(), record.taskId, this.sessionId, revision);
            if (!result.changes) {
                throw new Error("任务状态版本已变化，已停止旧执行写入");
            }
        }
    }

    /** 事务提交后更新内存版本，回滚不能推进版本 */
    committed(record: DeliveryRecord): void {
        this.versions.set(record.taskId, (this.versions.get(record.taskId) ?? -1) + 1);
    }
}

/** 从已保存的事实汇报状态，不把历史启动成功当作当前仍然运行 */
export function taskFacts(record?: DeliveryRecord): string {
    if (!record) {
        return "目前没有已保存的启动或验收结果，无法确认能否启动；本轮没有重新执行检查。";
    }
    const facts = record.processFacts ?? [];
    const ready = facts.filter(fact => fact.state === "ready");
    const current = new Map(facts.map(fact => [fact.id, fact]));
    const stopped = [...current.values()].filter(fact => fact.state === "stopped");
    const passed = record.contract.checks.filter(check => check.status === "passed").length;
    const awaiting = record.contract.checks.filter(check => check.status === "awaiting_review").length;
    const latest = facts.at(-1);
    const observed = latest ? `（最后记录：${new Date(latest.observedAt).toISOString()}）` : "";
    const startup = stopped.length === current.size && stopped.length ? `${ready.length ? "此前服务已通过启动就绪检查；" : "存在进程启动记录；"}受管服务已停止。` : ready.length ? "此前服务已通过启动就绪检查；当前是否仍在运行未重新检查。" :
        facts.length ? "已有进程启动记录，但尚不能确认服务就绪。" : "没有已保存的启动就绪结果，无法确认能否启动。";
    return `${startup}${observed}\n功能验收：${passed}/${record.contract.checks.length} 项通过${awaiting ? `，${awaiting} 项已执行待评审` : ""}。${record.stoppedReason ? `\n停止原因：${record.stoppedReason}` : ""}`;
}

/** 用用户可读的任务信息显示状态，不暴露内部运行快照 */
export function formatTaskStatus(status: TaskStatus | { summary: string }): string {
    if ("summary" in status) {
        return status.summary;
    }
    return `当前目标：${status.goal}\n本轮要求：${status.request}\n阶段：${status.phase}\n已通过 ${status.counts.passed ?? 0} 项，待评审 ${status.counts.awaiting_review ?? 0} 项，失败 ${status.counts.failed ?? 0} 项。\n剩余预算：${Math.ceil(status.remainingMs / 1000)} 秒。${status.stoppedReason ? `\n停止原因：${status.stoppedReason}` : ""}`;
}
