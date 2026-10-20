import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const applyPatchParams = Type.Object({
    filePath: Type.String({ description: "目标修改文件的相对路径，例如 'src/app.ts'" }),
    targetContent: Type.String({ description: "必须在原文件中精确匹配的旧代码块内容（包含换行与缩进）" }),
    replacementContent: Type.String({ description: "替换目标代码块的新代码内容" })
});

/** 局部代码精确比对替换修改工具 */
export const applyPatchTool: AgentTool<typeof applyPatchParams> = {
    name: "apply_patch",
    label: "局部补丁更新",
    description: "通过指定一段旧代码精确替换为新代码。优先使用此工具修改已有代码，避免全量重写。注意：必须在获得用户明确确认后调用！",
    parameters: applyPatchParams,
    /** 执行单块精确替换并重写目标文件 */
    execute: async (toolCallId, params) => {
        try {
            const resolvedPath = path.isAbsolute(params.filePath)
                ? params.filePath
                : path.resolve(process.cwd(), params.filePath);

            const fileContent = await fs.readFile(resolvedPath, "utf-8");

            // 统一换行符做安全比对
            const normalizedFile = fileContent.replace(/\r\n/g, "\n");
            const normalizedTarget = params.targetContent.replace(/\r\n/g, "\n");
            const normalizedReplacement = params.replacementContent.replace(/\r\n/g, "\n");

            const firstIndex = normalizedFile.indexOf(normalizedTarget);
            if (firstIndex === -1) {
                return {
                    content: [{
                        type: "text",
                        text: `补丁应用失败：在文件 [${params.filePath}] 中未找到与 targetContent 完全匹配的代码块。请使用 read_file 重新核对换行与缩进。`
                    }],
                    details: { success: false, error: "Target content not found" }
                };
            }

            const secondIndex = normalizedFile.indexOf(normalizedTarget, firstIndex + normalizedTarget.length);
            if (secondIndex !== -1) {
                return {
                    content: [{
                        type: "text",
                        text: `补丁应用失败：目标代码块在 [${params.filePath}] 中匹配到了多次。请在 targetContent 中多包含几行上下文以确保唯一性。`
                    }],
                    details: { success: false, error: "Multiple target occurrences found" }
                };
            }

            // 执行单次精准替换
            const updatedContent =
                normalizedFile.slice(0, firstIndex) +
                normalizedReplacement +
                normalizedFile.slice(firstIndex + normalizedTarget.length);

            await fs.writeFile(resolvedPath, updatedContent, "utf-8");

            return {
                content: [{
                    type: "text",
                    text: `已成功对 [${params.filePath}] 应用局部补丁修改。`
                }],
                details: {
                    filePath: params.filePath,
                    success: true
                }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `应用补丁失败: ${error.message}` }],
                details: { success: false, error: error.message }
            };
        }
    }
};
