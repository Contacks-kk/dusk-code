import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/** 只读并发安全工具名单 */
const PARALLEL_TOOLS = new Set([
    "read_file",
    "read_image",
    "list_files",
    "grep_search",
    "git_status",
    "git_diff",
    "get_current_time",
    "calculator",
    "recall_context"
]);

export interface BatchCall {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    args?: Record<string, unknown>;
}

export interface ToolSettlement {
    id: string;
    result: AgentToolResult<unknown>;
    isError: boolean;
}

interface BatchSlot {
    call: BatchCall;
    parallel: boolean;
    state: "queued" | "running" | "finished" | "committed";
    start?: () => void;
    reject?: (error: Error) => void;
    settlement?: ToolSettlement;
}

/** 纯函数分类器：根据工具名称与参数判断是否并发安全 */
export function isConcurrencySafe(name: string, args: Record<string, unknown> = {}): boolean {
    if (name === "browser_action") {
        return ["snapshot", "network", "console", "screenshot", "assert_visible", "assert_text", "assert_count", "assert_enabled", "assert_layout", "assert_response"].includes(String(args.action));
    }
    if (name === "managed_process") {
        return ["logs", "ready", "port"].includes(String(args.action));
    }
    if (name === "test_mail") {
        return args.action === "read";
    }
    return PARALLEL_TOOLS.has(name);
}

/** 校验工具执行并发上限 */
export function parallelToolLimit(value: number = Number(process.env.DUSK_MAX_PARALLEL_TOOL_CALLS ?? 4)): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("DUSK_MAX_PARALLEL_TOOL_CALLS 必须为正整数");
    }
    return value;
}

export class ToolBatchScheduler {
    private readonly slots: BatchSlot[];
    private readonly byId: Map<string, BatchSlot>;
    private active = 0;
    private committed = 0;
    private groupEnd = 0;
    private pumping = false;
    private stopped?: Error;
    private failure?: Error;
    private readonly done: Promise<void>;
    private resolveDone!: () => void;

    /** 建立一次助手响应的工具顺序及独占分组 */
    constructor(calls: BatchCall[], private readonly limit: number,
        private readonly commit: (value: ToolSettlement) => Promise<void>,
        private readonly fatal: (error: Error) => void) {
        parallelToolLimit(limit);
        this.slots = calls.map(call => {
            const toolArgs = call.arguments ?? call.args ?? {};
            return {
                call,
                parallel: isConcurrencySafe(call.name, toolArgs),
                state: "queued"
            };
        });
        this.byId = new Map(this.slots.map(slot => [slot.call.id, slot]));
        if (this.byId.size !== calls.length) {
            throw new Error("同一批次出现重复工具调用标识");
        }
        this.done = new Promise(resolve => { this.resolveDone = resolve; });
        this.advanceGroup();
        this.checkDone();
    }

    /** 在调度许可后启动工具，工具结束由 Pi 的结算事件登记 */
    run<T>(id: string, body: () => Promise<T>): Promise<T> {
        const slot = this.byId.get(id);
        if (!slot || slot.start || slot.state !== "queued") {
            return Promise.reject(new Error(`无效或重复的工具调度：${id}`));
        }
        if (this.stopped) {
            return Promise.reject(this.stopped);
        }
        return new Promise<T>((resolve, reject) => {
            slot.reject = reject;
            slot.start = () => { void Promise.resolve().then(body).then(resolve, reject); };
            this.wake();
        });
    }

    /** 登记执行结果或预校验失败，不阻塞 Pi 处理其余调用 */
    complete(value: ToolSettlement): void {
        const slot = this.byId.get(value.id);
        if (!slot || slot.state === "finished" || slot.state === "committed") {
            throw new Error(`工具结算标识不存在或已经结束：${value.id}`);
        }
        if (slot.state === "running") {
            this.active--;
        }
        slot.settlement = value;
        slot.state = "finished";
        this.wake();
    }

    /** 拒绝未启动调用，已经执行的工具继续等待自己的结束事件 */
    stop(reason: Error): void {
        this.stopped ??= reason;
        for (const slot of this.slots) {
            if (slot.state === "queued") {
                slot.reject?.(this.stopped);
            }
        }
        this.wake();
    }

    /** 等待全部已开始调用及顺序提交结束 */
    async drain(): Promise<void> {
        await this.done;
        if (this.failure) {
            throw this.failure;
        }
    }

    /** 选择当前连续读组或单个独占调用 */
    private advanceGroup(): void {
        this.groupEnd = this.committed;
        const first = this.slots[this.committed];
        if (!first) {
            return;
        }
        this.groupEnd++;
        while (first.parallel && this.groupEnd < this.slots.length && this.slots[this.groupEnd].parallel) {
            this.groupEnd++;
        }
    }

    /** 启动一个提交与补位任务，避免并发修改批次游标 */
    private wake(): void {
        if (!this.pumping) {
            this.pumping = true;
            void this.pump();
        }
    }

    /** 提交连续完成结果，并仅在当前分组补充执行槽位 */
    private async pump(): Promise<void> {
        try {
            while (!this.failure) {
                const slot = this.slots[this.committed];
                if (!slot || slot.state !== "finished") {
                    break;
                }
                if (!slot.settlement) {
                    throw new Error("已经完成的工具缺少结算结果");
                }
                await this.commit(slot.settlement);
                slot.state = "committed";
                this.committed++;
                if (this.committed === this.groupEnd) {
                    this.advanceGroup();
                }
            }
            if (!this.stopped && !this.failure) {
                for (let index = this.committed; index < this.groupEnd && this.active < this.limit; index++) {
                    const slot = this.slots[index];
                    if (slot.state === "queued" && slot.start) {
                        slot.state = "running";
                        this.active++;
                        slot.start();
                    }
                }
            }
        } catch (error) {
            this.failure = error instanceof Error ? error : new Error(String(error));
            this.stop(this.failure);
            this.fatal(this.failure);
        } finally {
            this.pumping = false;
            this.checkDone();
        }
    }

    /** 全部调用已结算且没有提交任务时释放批次等待者 */
    private checkDone(): void {
        if (!this.pumping && this.slots.every(slot => slot.state === "finished" || slot.state === "committed") &&
            (this.failure || this.committed === this.slots.length)) {
            this.resolveDone();
        }
    }
}
