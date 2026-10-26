import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, detectEol } from "../../fs/atomic-io";
import { fileObservationManager } from "../../fs/observation-manager";

const applyPatchParams = Type.Object({
    filePath: Type.String({ description: "目标修改文件的相对路径，例如 'src/app.ts'" }),
    targetContent: Type.String({ description: "必须在原文件中精确匹配的旧代码块内容（包含换行与缩进）" }),
    replacementContent: Type.String({ description: "替换目标代码块的新代码内容" })
});

export interface ApplyPatchContext {
    sessionId?: number;
    projectRoot?: string;
}

/** 创建与特定会话绑定的局部代码精确比对替换修改工具 */
export function createApplyPatchTool(context: ApplyPatchContext = {}): AgentTool<typeof applyPatchParams> {
    const sessionId = context.sessionId ?? 0;
    const baseCwd = context.projectRoot ?? process.cwd();

    return {
        name: "apply_patch",
        label: "局部补丁更新",
        description: "通过指定一段旧代码精确替换为新代码。优先使用此工具修改已有代码，必须在调用前使用 read_file 查阅过真实代码。注意：必须在获得用户明确确认后调用！",
        parameters: applyPatchParams,
        /** 执行单块精确替换并重写目标文件，自动保留原文件换行风格 */
        execute: async (toolCallId, params) => {
            try {
                const resolvedPath = path.isAbsolute(params.filePath)
                    ? params.filePath
                    : path.resolve(baseCwd, params.filePath);

                // 校验文件修改前置权限（防未读盲改与防版本冲突）
                const verification = await fileObservationManager.verifyMutation(sessionId, resolvedPath);
                if (!verification.allowed) {
                    return {
                        content: [{
                            type: "text",
                            text: verification.reason ?? "补丁修改前置校验未通过"
                        }],
                        details: {
                            filePath: params.filePath,
                            success: false,
                            error: verification.reason
                        }
                    };
                }

                // 读取磁盘物理文件内容
                const fileContent = await fs.readFile(resolvedPath, "utf-8");

                // 探查目标文件原生的主导换行风格（CRLF vs LF）
                const originalEol = detectEol(fileContent);

                // 统一换行符为 \n 执行安全精准比对
                const normalizedFile = fileContent.replace(/\r\n/g, "\n");
                const normalizedTarget = params.targetContent.replace(/\r\n/g, "\n");
                const normalizedReplacement = params.replacementContent.replace(/\r\n/g, "\n");

                const firstIndex = normalizedFile.indexOf(normalizedTarget);
                if (firstIndex === -1) {
                    return {
                        content: [{
                            type: "text",
                            text: `补丁应用失败：在文件 [${params.filePath}] 中未找到与 targetContent 完全匹配的代码块。请使用 read_file 重新核对最新代码的换行与缩进。`
                        }],
                        details: {
                            filePath: params.filePath,
                            success: false,
                            error: "Target content not found"
                        }
                    };
                }

                const secondIndex = normalizedFile.indexOf(normalizedTarget, firstIndex + normalizedTarget.length);
                if (secondIndex !== -1) {
                    return {
                        content: [{
                            type: "text",
                            text: `补丁应用失败：目标代码块在 [${params.filePath}] 中匹配到了多次。请在 targetContent 中多包含几行上下文以确保唯一性。`
                        }],
                        details: {
                            filePath: params.filePath,
                            success: false,
                            error: "Multiple target occurrences found"
                        }
                    };
                }

                // 执行单次精准替换拼接
                const updatedContent =
                    normalizedFile.slice(0, firstIndex) +
                    normalizedReplacement +
                    normalizedFile.slice(firstIndex + normalizedTarget.length);

                // 执行原子替换写入并还原原文件的原生换行风格
                const writeResult = await atomicWriteFile(resolvedPath, updatedContent, {
                    targetEol: originalEol
                });

                // 刷新当前会话的观察快照
                fileObservationManager.recordObservation(sessionId, resolvedPath, updatedContent);

                return {
                    content: [{
                        type: "text",
                        text: `已成功对 [${params.filePath}] 应用局部补丁修改（换行格式: ${writeResult.eol}）。`
                    }],
                    details: {
                        filePath: params.filePath,
                        success: true,
                        eol: writeResult.eol,
                        bytesWritten: writeResult.bytesWritten
                    }
                };
            } catch (error: any) {
                return {
                    content: [{
                        type: "text",
                        text: `应用补丁失败: ${error.message}`
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

/** 默认局部代码精确比对替换修改工具 */
export const applyPatchTool: AgentTool<typeof applyPatchParams> = createApplyPatchTool();
