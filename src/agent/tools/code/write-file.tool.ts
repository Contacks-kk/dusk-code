import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const writeFileParams = Type.Object({
    filePath: Type.String({ description: "目标文件路径，例如 'src/types/index.ts'" }),
    content: Type.String({ description: "写入目标文件的完整代码文本" })
});

/** 代码文件新建与完整覆写工具 */
export const writeFileTool: AgentTool<typeof writeFileParams> = {
    name: "write_file",
    label: "写入代码文件",
    description: "新建或完整覆写项目中的代码文件。若仅需修改已有文件的一部分，请优先使用 apply_patch。注意：必须在获得用户明确确认后调用！",
    parameters: writeFileParams,
    /** 执行文件写入逻辑并返回写入结果摘要 */
    execute: async (toolCallId, params) => {
        try {
            const resolvedPath = path.isAbsolute(params.filePath)
                ? params.filePath
                : path.resolve(process.cwd(), params.filePath);

            // 递归创建上级目录
            await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

            await fs.writeFile(resolvedPath, params.content, "utf-8");

            const lineCount = params.content.split(/\r?\n/).length;
            const bytesWritten = Buffer.byteLength(params.content, "utf-8");

            return {
                content: [{
                    type: "text",
                    text: `文件 [${params.filePath}] 已成功写入（共 ${lineCount} 行，${bytesWritten} 字节）。`
                }],
                details: {
                    filePath: params.filePath,
                    success: true,
                    lineCount,
                    bytesWritten
                }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `写入文件 [${params.filePath}] 失败: ${error.message}` }],
                details: { filePath: params.filePath, success: false, error: error.message }
            };
        }
    }
};
