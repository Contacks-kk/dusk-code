import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TaskStatusBarTracker } from "./tracker";
import type { TodoItem, TodoStatus } from "./types";

export const todoItemSchema = Type.Object({
    content: Type.String({
        description: "简短明确的任务动作描述，例如：修改 runner.ts 增加 todo 工具"
    }),
    status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed")
    ], {
        description: "任务状态：pending (待处理) | in_progress (正在进行) | completed (已完成)"
    })
});

export const todoWriteParams = Type.Object({
    todos: Type.Array(todoItemSchema, {
        description: "完整的任务清单快照，全量替换旧任务列表"
    })
});

/** 校验并规范化待办任务清单输入 */
function validateTodoList(raw: unknown): TodoItem[] {
    if (!Array.isArray(raw)) {
        throw new Error("参数错误：todos 必须为数组");
    }

    const todos: TodoItem[] = [];
    const seen = new Set<string>();

    // 逐项校验任务内容与状态合法性
    for (const item of raw) {
        if (!item || typeof item !== "object") {
            throw new Error("参数错误：待办项必须为有效对象");
        }

        const content = typeof (item as any).content === "string" ? (item as any).content.trim() : "";
        if (!content) {
            throw new Error("参数错误：待办项 content 必须为非空字符串");
        }

        if (seen.has(content)) {
            throw new Error(`参数错误：待办项 content 重复 "${content}"`);
        }
        seen.add(content);

        const status = (item as any).status as TodoStatus;
        if (!["pending", "in_progress", "completed"].includes(status)) {
            throw new Error(`参数错误：待办项状态非法 "${status}"，仅支持 pending | in_progress | completed`);
        }

        todos.push({
            content,
            status
        });
    }

    return todos;
}

/** 创建与任务状态栏联动的待办清单写入工具 */
export function createTodoWriteTool(tracker: TaskStatusBarTracker): AgentTool<typeof todoWriteParams> {
    return {
        name: "todo_write",
        label: "更新待办任务清单",
        description: "记录并更新当前任务的完整待办清单 (TODO List)。对于多步骤复杂任务，在开始工作前先调用此工具添加具体步骤清单；在执行步骤时将当前进行中的任务标记为 in_progress，完成后立即将其标记为 completed。每次调用必须传入当前完整的任务清单（全量覆盖旧列表）。",
        parameters: todoWriteParams,
        /** 执行待办清单整表全量快照替换操作 */
        execute: async (toolCallId, params) => {
            // 校验并清洗输入的待办任务
            const todos = validateTodoList(params.todos);

            // 全量更新状态栏中的任务清单
            tracker.updateTodos(todos);

            const pending = todos.filter(t => t.status === "pending").length;
            const inProgress = todos.filter(t => t.status === "in_progress").length;
            const completed = todos.filter(t => t.status === "completed").length;

            const text = `已更新待办任务清单：共 ${todos.length} 项（${completed} 已完成，${inProgress} 进行中，${pending} 待处理）。任务状态栏已同步更新。`;

            return {
                content: [{
                    type: "text",
                    text
                }],
                details: {
                    todos,
                    counts: {
                        pending,
                        inProgress,
                        completed
                    }
                }
            };
        }
    };
}
