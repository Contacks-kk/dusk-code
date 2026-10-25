import os from "node:os";
import type { DeliveryRecord } from "../acceptance/types";
import type {
    StatusBarMode,
    SystemEnvironmentInfo,
    TaskStatusBarSnapshot,
    ToolExecutionStat
} from "./types";

export class TaskStatusBarTracker {
    private readonly startedAt = Date.now();
    private readonly toolCalls: Record<string, ToolExecutionStat> = {};
    private readonly modifiedFiles = new Set<string>();
    private readonly systemInfo: SystemEnvironmentInfo;
    private lastError?: {
        toolName: string;
        message: string;
        timestamp: number;
        consecutiveFailures: number;
    };

    /** 初始化收集静态运行环境与任务初始参数 */
    constructor(
        private readonly workspaceRoot: string,
        private readonly goal: string,
        private readonly mode: StatusBarMode = "replace",
        private readonly totalBudgetMs: number = 180000
    ) {
        this.systemInfo = {
            platform: `${os.platform()} (${os.release()})`,
            shell: os.platform() === "win32" ? "PowerShell" : "bash/zsh",
            arch: os.arch(),
            workspaceRoot: this.workspaceRoot,
            nodeVersion: process.version
        };
    }

    /** 记录工具调用的执行指标、受影响文件与异常 */
    recordToolCall(toolName: string, args: Record<string, unknown>, isError: boolean, errorMsg?: string): void {
        this.toolCalls[toolName] ??= {
            count: 0,
            failures: 0
        };
        this.toolCalls[toolName].count++;

        // 处理调用异常与错误计数
        if (isError) {
            const consecutive = (this.lastError?.toolName === toolName ? this.lastError.consecutiveFailures : 0) + 1;
            this.toolCalls[toolName].failures++;
            this.lastError = {
                toolName,
                message: (errorMsg ?? "执行发生未知异常").slice(0, 300),
                timestamp: Date.now(),
                consecutiveFailures: consecutive
            };
        } else if (this.lastError?.toolName === toolName) {
            this.lastError = undefined;
        }

        // 收集受影响修改的文件路径
        if (["replace_file_content", "write_to_file", "multi_replace_file_content", "apply_patch"].includes(toolName)) {
            const target = (args.TargetFile ?? args.targetFile ?? args.filePath) as string | undefined;
            if (target) {
                this.modifiedFiles.add(target);
            }
        }
    }

    /** 生成当前最新快照数据 */
    snapshot(currentTurnNo: number, callNo: number, delivery?: DeliveryRecord): TaskStatusBarSnapshot {
        const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
        const remainingMs = Math.max(0, this.totalBudgetMs - (Date.now() - this.startedAt));

        // 映射当前验收规划项
        const items = delivery?.contract.checks.map(check => {
            return {
                id: check.id,
                title: check.title,
                status: check.status
            };
        }) ?? [];

        return {
            mode: this.mode,
            system: this.systemInfo,
            time: {
                startedAt: this.startedAt,
                elapsedSeconds,
                remainingMs,
                currentTurnNo,
                callNo
            },
            stats: {
                totalCalls: Object.values(this.toolCalls).reduce((acc, curr) => {
                    return acc + curr.count;
                }, 0),
                toolCalls: structuredClone(this.toolCalls),
                modifiedFiles: Array.from(this.modifiedFiles)
            },
            plan: {
                goal: this.goal,
                intent: delivery?.contract.intent ?? "执行任务",
                items
            },
            lastError: this.lastError ? structuredClone(this.lastError) : undefined
        };
    }

    /** 格式化生成注入模型的 Markdown 文本块 */
    render(currentTurnNo: number, callNo: number, delivery?: DeliveryRecord): string {
        const snap = this.snapshot(currentTurnNo, callNo, delivery);

        // 格式化工具调用明细
        const toolDetails = Object.entries(snap.stats.toolCalls).map(([name, s]) => {
            return `${name}: ${s.count}${s.failures ? `[失败:${s.failures}]` : ""}`;
        }).join(", ") || "暂无";

        // 格式化 TODO 项
        const todoLines = snap.plan.items.map(item => {
            const marker = item.status === "passed" ? "[x]" : item.status === "running" ? "[>]" : item.status === "failed" ? "[!]" : "[ ]";
            return `  ${marker} ${item.title} (${item.status})`;
        });

        const lines: string[] = [
            "【任务状态栏 / Task Status Bar】",
            `• 系统环境: OS=${snap.system.platform} | Shell=${snap.system.shell} | 工作区='${snap.system.workspaceRoot}'`,
            `• 时序跟踪: 任务已耗时 ${snap.time.elapsedSeconds}s | 当前轮次 #${snap.time.currentTurnNo}`,
            `• 工具统计: 累计调用 ${snap.stats.totalCalls} 次 (明细: ${toolDetails})`,
            `• 已修改文件: [${snap.stats.modifiedFiles.map(f => `'${f}'`).join(", ")}]`,
            `• 当前主目标: ${snap.plan.goal}`
        ];

        // 注入待办计划
        if (todoLines.length > 0) {
            lines.push("• 进度计划 (TODO List):", ...todoLines);
        }

        // 注入最近错误异常
        if (snap.lastError) {
            lines.push(
                "• 异常感知 (Last Execution Error):",
                `  - 失败工具: ${snap.lastError.toolName} (连续失败 ${snap.lastError.consecutiveFailures} 次)`,
                `  - 错误摘要: ${snap.lastError.message}`,
                "  - 执行约束: 严禁使用相同参数重复盲目试错，请先排查依赖、路径或参数根因。"
            );
        }

        // 模式提示说明
        if (this.mode === "append") {
            lines.push("• 注意: 此卡片为最新状态快照，请以此状态栏为基准，忽略上下文上方旧状态栏。");
        }

        lines.push("【/任务状态栏】");
        return lines.join("\n");
    }
}
