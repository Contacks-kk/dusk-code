import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { atomicWriteFile } from "../../fs/atomic-io";
import { fileObservationManager } from "../../fs/observation-manager";

const writeFileParams = Type.Object({
    filePath: Type.String({ description: "目标文件路径，例如 'src/types/index.ts'" }),
    content: Type.String({ description: "写入目标文件的完整代码文本" })
});

export interface WriteFileContext {
    sessionId?: number;
    projectRoot?: string;
}

/** 创建与特定会话绑定的代码文件新建与写入工具 */
export function createWriteFileTool(context: WriteFileContext = {}): AgentTool<typeof writeFileParams> {
    const sessionId = context.sessionId ?? 0;
    const baseCwd = context.projectRoot ?? process.cwd();

    return {
        name: "write_file",
        label: "写入代码文件",
        description: "新建或完整覆写项目中的代码文件。若目标文件已存在，必须先使用 read_file 查阅过真实代码方可修改。若仅需修改已有文件的一部分，请优先使用 apply_patch。注意：必须在获得用户明确确认后调用！",
        parameters: writeFileParams,
        /** 执行文件修改前置版本校验并执行原子写入 */
        execute: async (toolCallId, params) => {
            try {
                const resolvedPath = path.isAbsolute(params.filePath)
                    ? params.filePath
                    : path.resolve(baseCwd, params.filePath);

                // 校验文件修改权限（防未读盲改与防版本冲突）
                const verification = await fileObservationManager.verifyMutation(sessionId, resolvedPath);
                if (!verification.allowed) {
                    return {
                        content: [{
                            type: "text",
                            text: verification.reason ?? "文件修改前置校验未通过"
                        }],
                        details: {
                            filePath: params.filePath,
                            success: false,
                            error: verification.reason
                        }
                    };
                }

                // 执行具备路径互斥锁、换行风格保留与原子替换写入
                const writeResult = await atomicWriteFile(resolvedPath, params.content, {
                    preserveExistingEol: true
                });

                // 写入成功后刷新当前会话的观察快照
                fileObservationManager.recordObservation(sessionId, resolvedPath, params.content);

                return {
                    content: [{
                        type: "text",
                        text: `文件 [${params.filePath}] 已安全原子写入（共 ${writeResult.lineCount} 行，${writeResult.bytesWritten} 字节，换行格式: ${writeResult.eol}）。`
                    }],
                    details: {
                        filePath: params.filePath,
                        success: true,
                        lineCount: writeResult.lineCount,
                        bytesWritten: writeResult.bytesWritten,
                        eol: writeResult.eol
                    }
                };
            } catch (error: any) {
                return {
                    content: [{
                        type: "text",
                        text: `写入文件 [${params.filePath}] 失败: ${error.message}`
                    }],
                    details: {
                        filePath: params.filePath,
                        success: false,
                        error: error.message
                    }
                };
            }
        }
    };
}

/** 默认代码文件新建与完整覆写工具 */
export const writeFileTool: AgentTool<typeof writeFileParams> = createWriteFileTool();
