import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CommandOutputContext } from "../spill/types";
import { executeCommandTool, createExecuteCommandTool } from "./code/execute-command.tool";
import { gitStatusTool, createGitStatusTool } from "./code/git-status.tool";
import { gitDiffTool, createGitDiffTool } from "./code/git-diff.tool";
import { readFileTool, createReadFileTool } from "./code/read-file.tool";
import { writeFileTool, createWriteFileTool } from "./code/write-file.tool";
import { applyPatchTool, createApplyPatchTool } from "./code/apply-patch.tool";

/** 为内置命令与文件读写工具绑定会话上下文与观察账本归属 */
export function bindCommandTools(tools: AgentTool[], context: Pick<CommandOutputContext, "projectRoot" | "sessionId">): AgentTool[] {
    return tools.map(tool => {
        // 命令与执行类工具绑定会话日志与根路径
        if (tool.name === "execute_command" || tool === executeCommandTool) {
            return createExecuteCommandTool(context);
        }
        if (tool.name === "git_status" || tool === gitStatusTool) {
            return createGitStatusTool(context);
        }
        if (tool.name === "git_diff" || tool === gitDiffTool) {
            return createGitDiffTool(context);
        }

        // 文件读写类工具绑定会话级观察账本与根路径
        if (tool.name === "read_file" || tool === readFileTool) {
            return createReadFileTool(context);
        }
        if (tool.name === "write_file" || tool === writeFileTool) {
            return createWriteFileTool(context);
        }
        if (tool.name === "apply_patch" || tool === applyPatchTool) {
            return createApplyPatchTool(context);
        }

        return tool;
    });
}
