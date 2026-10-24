import { randomUUID } from "node:crypto";
import type { TurnControl } from "./turn-control";
import type { TaskStatus } from "../types";

export interface PendingInput {
    inputId: string;
    message: string;
    turnId: number;
    turnNo: number;
    userMessageId: number;
    control: TurnControl;
}

export class ActiveRun {
    readonly runId = randomUUID();
    readonly startedAt = Date.now();
    readonly inputs = new Map<string, Promise<{ inputId: string; instructionRevision: number; status: string }>>();
    readonly pending: PendingInput[] = [];
    inputTail: Promise<void> = Promise.resolve();
    revision = 1;
    announced = false;
    parentSignal?: AbortSignal;
    controller = new AbortController();
    control?: TurnControl;
    status?: TaskStatus;
    assertLease?: () => void;
    private holds = 0;
    private waiters: Array<() => void> = [];

    /** 一个活动会话只由一个运行持有者调度 */
    constructor(readonly sessionId: number) { }

    /** 收到新消息时先关闭新动作入口 */
    hold(): void {
        this.holds++;
    }

    /** 分类和持久化完成后允许当前有效运行继续 */
    release(): void {
        this.holds--;
        if (this.holds === 0) {
            for (const resolve of this.waiters.splice(0)) {
                resolve();
            }
        }
    }

    /** 在模型请求和工具边界等待新指令处理完成 */
    async ready(signal?: AbortSignal): Promise<void> {
        while (this.holds > 0) {
            signal?.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                /** 唤醒等待者并移除取消监听 */
                const done = () => {
                    signal?.removeEventListener("abort", abort);
                    resolve();
                };
                /** 取消当前边界等待，避免停止要求被分类阻塞 */
                const abort = () => {
                    this.waiters = this.waiters.filter(waiter => waiter !== done);
                    reject(signal?.reason ?? new Error("运行已取消"));
                };
                this.waiters.push(done);
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) {
                    abort();
                }
            });
        }
        signal?.throwIfAborted();
    }
}
