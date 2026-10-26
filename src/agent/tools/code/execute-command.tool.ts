import type { CommandOutputContext } from "../../spill/types";
import { commandOutputDetails } from "../../runtime/shell-adapter";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { shellAdapter } from "../../runtime/shell-adapter";

const executeCommandParams = Type.Object({
    command: Type.String({ description: "要在终端中执行的 CLI 命令行指令" }),
    cwd: Type.Optional(Type.String({ description: "执行命令的目标工作目录，默认为当前工程根目录" }))
});

/** 终端命令跨平台安全执行工具 */
export function createExecuteCommandTool(context?: Pick<CommandOutputContext, "projectRoot" | "sessionId">): AgentTool<typeof executeCommandParams> {
    return {
        name: "execute_command",
        label: "执行终端命令",
        description: "在当前操作系统的受控终端环境中执行 CLI 命令（如 npm test、git log 等）。注意：严禁执行破坏性系统指令！",
        parameters: executeCommandParams,
        /** 执行命令行指令并返回控制台标准输出及退出状态 */
        execute: async (toolCallId, params, signal) => {
            try {
                const result = await shellAdapter.execute(params.command, params.cwd, undefined, signal, context ? { ...context, toolName: "execute_command", toolCallId } : undefined);

                const outputParts: string[] = [];
                if (result.stdout) {
                    outputParts.push(`[stdout]:\n${result.stdout}`);
                }
                if (result.stderr) {
                    outputParts.push(`[stderr]:\n${result.stderr}`);
                }
                if (outputParts.length === 0) {
                    outputParts.push("命令未产生控制台输出。");
                }

                if (result.aborted) {
                    outputParts.push("命令已取消，已结束等待。");
                } else if (result.timedOut) {
                    outputParts.push("命令执行超时，已结束等待。");
                }
                if (result.outputIncomplete) {
                    outputParts.push("输出流未全部回收，已停止等待后续输出。");
                }
                outputParts.push(`(进程退出码: ${result.exitCode})`);

                return {
                    content: [{
                        type: "text",
                        text: outputParts.join("\n\n")
                    }],
                    details: {
                        ...commandOutputDetails(result),
                        command: params.command,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        aborted: result.aborted,
                        outputIncomplete: result.outputIncomplete
                    }
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `命令执行异常: ${error.message}` }],
                    details: { command: params.command, error: error.message }
                };
            }
        }
    };
}

export const executeCommandTool = createExecuteCommandTool();
