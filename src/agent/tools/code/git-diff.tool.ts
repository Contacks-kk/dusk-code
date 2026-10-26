import type { CommandOutputContext } from "../../spill/types";
import { commandOutputDetails } from "../../runtime/shell-adapter";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { shellAdapter } from "../../runtime/shell-adapter";

const gitDiffParams = Type.Object({
    repoPath: Type.Optional(Type.String({ description: "仓库目录路径，默认为当前工程根目录" })),
    filePath: Type.Optional(Type.String({ description: "指定查看差异的文件路径，缺省时查看全局差异" })),
    staged: Type.Optional(Type.Boolean({ description: "是否查看已暂存区 (--staged) 的差异，默认为 false" }))
});

/** Git 代码变更差异比对审查工具 */
export function createGitDiffTool(context?: Pick<CommandOutputContext, "projectRoot" | "sessionId">): AgentTool<typeof gitDiffParams> {
    return {
        name: "git_diff",
        label: "获取 Git Diff",
        description: "查看代码修改前后的详细差异比对。在审查改动、确认代码变更正确性时使用。",
        parameters: gitDiffParams,
        /** 执行 git diff 命令并输出补丁格式的差异详情 */
        execute: async (toolCallId, params, signal) => {
            try {
                const args = ["git diff"];
                if (params.staged) {
                    args.push("--staged");
                }
                if (params.filePath) {
                    args.push(`-- "${params.filePath}"`);
                }

                const command = args.join(" ");
                const result = await shellAdapter.execute(command, params.repoPath, undefined, signal, context ? { ...context, toolName: "git_diff", toolCallId } : undefined);

                if (result.aborted || result.timedOut || result.exitCode !== 0) {
                    if (!result.aborted && !result.timedOut && result.stderr.includes("not a git repository")) {
                        return {
                            content: [{ type: "text", text: "当前工作目录尚未初始化为 Git 仓库，无法比对 Git Diff。" }],
                            details: {
                        ...commandOutputDetails(result), isGitRepo: false }
                        };
                    }
                    const reason = result.aborted ? "操作已取消。" : result.timedOut ? "命令执行超时，已结束等待。" : "命令执行失败。";
                    return {
                        content: [{ type: "text", text: `获取 Git Diff 失败: ${reason}\n${result.stderr}`.trim() }],
                        details: {
                        ...commandOutputDetails(result),
                            exitCode: result.exitCode,
                            error: result.stderr,
                            timedOut: result.timedOut,
                            aborted: result.aborted,
                            outputIncomplete: result.outputIncomplete
                        }
                    };
                }

                const diffText = result.stdout.trim();

                // 输出未回收完整时保留原文，避免误报没有差异
                if (result.outputIncomplete) {
                    return {
                        content: [{ type: "text", text: `Git Diff 输出未完整回收，无法确认完整差异:\n${diffText}` }],
                        details: {
                        ...commandOutputDetails(result),
                            rawDiff: diffText,
                            outputIncomplete: true
                        }
                    };
                }
                if (!diffText) {
                    return {
                        content: [{ type: "text", text: "当前没有检测到任何代码变更差异 (Diff 为空)。" }],
                        details: {
                        ...commandOutputDetails(result), hasDiff: false }
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: `Git 代码差异比对:\n${diffText}`
                    }],
                    details: {
                        ...commandOutputDetails(result),
                        hasDiff: true,
                        filePath: params.filePath ?? "all",
                        staged: params.staged ?? false
                    }
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `获取 Git Diff 失败: ${error.message}` }],
                    details: { error: error.message }
                };
            }
        }
    };
}

export const gitDiffTool = createGitDiffTool();
