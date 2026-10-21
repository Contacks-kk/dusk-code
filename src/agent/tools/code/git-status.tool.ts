import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { shellAdapter } from "../../runtime/shell-adapter";

const gitStatusParams = Type.Object({
    repoPath: Type.Optional(Type.String({ description: "仓库目录路径，默认为当前工程根目录" }))
});

/** Git 代码仓库工作区状态获取工具 */
export const gitStatusTool: AgentTool<typeof gitStatusParams> = {
    name: "git_status",
    label: "获取 Git 状态",
    description: "检查当前工程的 Git 分支、文件修改、暂存区及未跟踪文件状态。",
    parameters: gitStatusParams,
    /** 执行 git status 查询并返回结构化变更列表 */
    execute: async (toolCallId, params, signal) => {
        try {
            const result = await shellAdapter.execute("git status --short -b", params.repoPath, undefined, signal);

            if (result.aborted || result.timedOut || result.exitCode !== 0) {
                if (!result.aborted && !result.timedOut && result.stderr.includes("not a git repository")) {
                    return {
                        content: [{ type: "text", text: "当前工作目录尚未初始化为 Git 仓库（如需启用版本控制，可执行 git init 初始化）。" }],
                        details: { isGitRepo: false }
                    };
                }
                const reason = result.aborted ? "操作已取消。" : result.timedOut ? "命令执行超时，已结束等待。" : "命令执行失败。";
                return {
                    content: [{ type: "text", text: `Git 状态查询失败: ${reason}\n${result.stderr}`.trim() }],
                    details: {
                        exitCode: result.exitCode,
                        error: result.stderr,
                        timedOut: result.timedOut,
                        aborted: result.aborted,
                        outputIncomplete: result.outputIncomplete
                    }
                };
            }

            const rawText = result.stdout.trim();

            // 输出未回收完整时保留原文，避免误报工作区干净
            if (result.outputIncomplete) {
                return {
                    content: [{ type: "text", text: `Git 状态输出未完整回收，无法确认完整工作区状态:\n${rawText}` }],
                    details: {
                        rawStatus: rawText,
                        outputIncomplete: true
                    }
                };
            }
            if (!rawText) {
                return {
                    content: [{ type: "text", text: "工作区非常干净，没有未提交或未跟踪的代码变更。" }],
                    details: { clean: true }
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Git 工作区状态:\n${rawText}`
                }],
                details: {
                    clean: false,
                    rawStatus: rawText
                }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `查询 Git 状态失败: ${error.message}` }],
                details: { error: error.message }
            };
        }
    }
};
