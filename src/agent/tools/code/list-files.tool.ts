import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const listFilesParams = Type.Object({
    directoryPath: Type.Optional(Type.String({ description: "目标目录路径，默认为当前工程根目录" })),
    recursive: Type.Optional(Type.Boolean({ description: "是否递归遍历子目录，默认为 false" })),
    maxDepth: Type.Optional(Type.Integer({ description: "最大遍历深度，默认为 2" }))
});

const DEFAULT_IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".idea",
    ".vscode"
]);

/** 遍历指定目录树并收集相对文件路径 */
async function scanDir(
    currentDir: string,
    baseDir: string,
    recursive: boolean,
    maxDepth: number,
    currentDepth: number = 1
): Promise<string[]> {
    if (currentDepth > maxDepth) {
        return [];
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const fileList: string[] = [];

    for (const entry of entries) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
            continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
            fileList.push(`${relativePath}/`);
            if (recursive) {
                const subFiles = await scanDir(fullPath, baseDir, recursive, maxDepth, currentDepth + 1);
                fileList.push(...subFiles);
            }
        } else {
            fileList.push(relativePath);
        }
    }

    return fileList;
}

/** 探测目录结构与文件列表工具 */
export const listFilesTool: AgentTool<typeof listFilesParams> = {
    name: "list_files",
    label: "文件目录探测",
    description: "发现并列出项目中的文件与目录结构。在探索新目录、定位未知模块文件时优先调用此工具。",
    parameters: listFilesParams,
    /** 执行目录扫描并返回文件清单 */
    execute: async (toolCallId, params) => {
        try {
            const baseDir = process.cwd();
            const targetDir = params.directoryPath
                ? (path.isAbsolute(params.directoryPath) ? params.directoryPath : path.resolve(baseDir, params.directoryPath))
                : baseDir;

            const recursive = params.recursive ?? false;
            const maxDepth = params.maxDepth ?? 2;

            const files = await scanDir(targetDir, targetDir, recursive, maxDepth);

            return {
                content: [{
                    type: "text",
                    text: `目录 [${path.relative(baseDir, targetDir) || "."}] 文件列表 (共 ${files.length} 项):\n${files.slice(0, 80).join("\n")}${files.length > 80 ? `\n...[已省略其余 ${files.length - 80} 项]` : ""}`
                }],
                details: {
                    directoryPath: params.directoryPath ?? ".",
                    totalCount: files.length,
                    files
                }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `列出目录失败: ${error.message}` }],
                details: { error: error.message }
            };
        }
    }
};
