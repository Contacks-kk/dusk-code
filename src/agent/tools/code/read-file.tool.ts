import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const readFileParams = Type.Object({
    filePath: Type.String({ description: "目标文件路径，支持相对路径，例如 'src/app.ts'" }),
    startLine: Type.Optional(Type.Integer({ description: "起始行号（从 1 开始，可选）" })),
    endLine: Type.Optional(Type.Integer({ description: "结束行号（从 1 开始，可选）" }))
});

/** 代码与文本文件精准读取工具 */
export const readFileTool: AgentTool<typeof readFileParams> = {
    name: "read_file",
    label: "读取代码文件",
    description: "精准读取项目中的指定源码文件内容并附带行号。在提出任何修改方案前，必须优先阅读真实代码。",
    parameters: readFileParams,
    /** 执行文件读取逻辑并返回带行号的内容切片 */
    execute: async (toolCallId, params) => {
        try {
            const resolvedPath = path.isAbsolute(params.filePath)
                ? params.filePath
                : path.resolve(process.cwd(), params.filePath);

            const fileContent = await fs.readFile(resolvedPath, "utf-8");
            const allLines = fileContent.split(/\r?\n/);
            const totalLines = allLines.length;

            const start = params.startLine ? Math.max(1, params.startLine) : 1;
            const end = params.endLine ? Math.min(totalLines, params.endLine) : totalLines;

            if (start > totalLines) {
                return {
                    content: [{ type: "text", text: `文件共 ${totalLines} 行，指定起始行 ${start} 超出范围` }],
                    details: { filePath: params.filePath, totalLines, error: "Out of range" }
                };
            }

            const slicedLines = allLines.slice(start - 1, end);
            const formatted = slicedLines
                .map((line, index) => `${start + index}: ${line}`)
                .join("\n");

            const summary = `成功读取文件 [${params.filePath}] (第 ${start} 至 ${end} 行，共 ${totalLines} 行):\n${formatted}`;

            return {
                content: [{ type: "text", text: summary }],
                details: {
                    filePath: params.filePath,
                    startLine: start,
                    endLine: end,
                    totalLines,
                    lineCount: slicedLines.length
                }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `读取文件 [${params.filePath}] 失败: ${error.message}` }],
                details: { filePath: params.filePath, error: error.message }
            };
        }
    }
};
