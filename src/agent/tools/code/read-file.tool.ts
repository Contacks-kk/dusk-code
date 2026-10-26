import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { fileObservationManager } from "../../fs/observation-manager";

const readFileParams = Type.Object({
    filePath: Type.String({ description: "目标文件路径，支持相对路径，例如 'src/app.ts'" }),
    offsetBytes: Type.Optional(Type.Integer({ minimum: 0, description: "按 UTF-8 字节偏移分页，与行号参数互斥" })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 16000, description: "字节分页大小，默认 8192，最多 16000" })),
    startLine: Type.Optional(Type.Integer({ description: "起始行号（从 1 开始，可选）" })),
    endLine: Type.Optional(Type.Integer({ description: "结束行号（从 1 开始，可选）" }))
});

export interface ReadFileContext {
    sessionId?: number;
    projectRoot?: string;
}

/** 分页读取原始字节，在完整 UTF-8 字符边界返回下一页偏移 */
async function readBytePage(filePath: string, offsetBytes = 0, maxBytes = 8192): Promise<AgentToolResult<Record<string, unknown>>> {
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 16000) {
        throw new Error("字节偏移必须非负，分页大小须在 4 至 16000 字节之间");
    }
    const handle = await fs.open(filePath, "r");
    try {
        const { size } = await handle.stat();
        if (offsetBytes > size) {
            throw new Error("字节偏移超过文件大小");
        }
        const buffer = Buffer.alloc(maxBytes + 4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offsetBytes);
        let start = 0;
        while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) {
            start++;
        }
        let end = Math.min(bytesRead, maxBytes);
        while (end > start && end < bytesRead && (buffer[end] & 0xc0) === 0x80) {
            end--;
        }
        const nextOffsetBytes = offsetBytes + end;
        return {
            content: [{
                type: "text",
                text: buffer.subarray(start, end).toString("utf8")
            }],
            details: {
                filePath,
                offsetBytes: offsetBytes + start,
                totalBytes: size,
                nextOffsetBytes,
                truncated: nextOffsetBytes < size
            }
        };
    } finally {
        await handle.close();
    }
}

/** 创建与特定会话绑定的代码文件读取工具 */
export function createReadFileTool(context: ReadFileContext = {}): AgentTool<typeof readFileParams> {
    const sessionId = context.sessionId ?? 0;
    const baseCwd = context.projectRoot ?? process.cwd();

    return {
        name: "read_file",
        label: "读取代码文件",
        description: "精准读取项目中的指定源码文件内容并附带行号。在提出任何修改方案前，必须优先阅读真实代码。",
        parameters: readFileParams,
        /** 执行文件读取逻辑并返回带行号的内容切片，同时在观察账本中登记快照 */
        execute: async (toolCallId, params) => {
            try {
                const resolvedPath = path.isAbsolute(params.filePath)
                    ? params.filePath
                    : path.resolve(baseCwd, params.filePath);

                // 读取磁盘物理文件的完整内容
                const fileContent = await fs.readFile(resolvedPath, "utf-8");

                // 在文件观察账本中登记快照，获取版本保护凭据
                fileObservationManager.recordObservation(sessionId, resolvedPath, fileContent);

                if (params.offsetBytes !== undefined || params.maxBytes !== undefined) {
                    if (params.startLine !== undefined || params.endLine !== undefined) {
                        throw new Error("字节分页与行号切片不能同时指定");
                    }
                    return await readBytePage(resolvedPath, params.offsetBytes, params.maxBytes);
                }

                const allLines = fileContent.split(/\r?\n/);
                const totalLines = allLines.length;

                const start = params.startLine ? Math.max(1, params.startLine) : 1;
                const end = params.endLine ? Math.min(totalLines, params.endLine) : totalLines;

                if (start > totalLines) {
                    return {
                        content: [{
                            type: "text",
                            text: `文件共 ${totalLines} 行，指定起始行 ${start} 超出范围`
                        }],
                        details: {
                            filePath: params.filePath,
                            totalLines,
                            error: "Out of range"
                        }
                    };
                }

                const slicedLines = allLines.slice(start - 1, end);
                const formatted = slicedLines
                    .map((line, index) => `${start + index}: ${line}`)
                    .join("\n");

                const summary = `成功读取文件 [${params.filePath}] (第 ${start} 至 ${end} 行，共 ${totalLines} 行):\n${formatted}`;

                return {
                    content: [{
                        type: "text",
                        text: summary
                    }],
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
                    content: [{
                        type: "text",
                        text: `读取文件 [${params.filePath}] 失败: ${error.message}`
                    }],
                    details: {
                        filePath: params.filePath,
                        error: error.message
                    }
                };
            }
        }
    };
}

/** 默认代码与文本文件精准读取工具 */
export const readFileTool: AgentTool<typeof readFileParams> = createReadFileTool();
