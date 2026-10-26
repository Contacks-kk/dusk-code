import type { CheckStatus } from "../acceptance/types";

export type StatusBarMode = "replace" | "append";

export interface ToolExecutionStat {
    count: number;
    failures: number;
}

export interface SystemEnvironmentInfo {
    platform: string;
    shell: string;
    arch: string;
    workspaceRoot: string;
    nodeVersion: string;
}

export interface TaskTimeTracking {
    startedAt: number;
    elapsedSeconds: number;
    remainingMs: number;
    currentTurnNo: number;
    callNo: number;
}

export interface TaskTodoItem {
    id?: string;
    title: string;
    status: CheckStatus;
}

export interface LastExecutionError {
    toolName: string;
    message: string;
    timestamp: number;
    consecutiveFailures: number;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
    content: string;
    status: TodoStatus;
}

export interface TaskStatusBarSnapshot {
    mode: StatusBarMode;
    system: SystemEnvironmentInfo;
    time: TaskTimeTracking;
    stats: {
        totalCalls: number;
        toolCalls: Record<string, ToolExecutionStat>;
        modifiedFiles: string[];
    };
    plan: {
        goal: string;
        intent: string;
        items: TaskTodoItem[];
        todos?: TodoItem[];
    };
    lastError?: LastExecutionError;
}
