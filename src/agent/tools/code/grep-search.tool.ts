import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const grepSearchParams = Type.Object({
    query: Type.String({ description: "检索的关键词或正则表达式" }),
    searchPath: Type.Optional(Type.String({ description: "搜索起始路径，默认为当前工程根目录" })),
    isRegex: Type.Optional(Type.Boolean({ description: "是否按正则表达式匹配，默认为 false" })),
    includes: Type.Optional(Type.Array(Type.String(), { description: "文件扩展名或模式过滤，例如 ['.ts', '.js']" }))
});

const IGNORED_FOLDERS = new Set(["node_modules", ".git", "dist", "build"]);

interface MatchItem {
    filePath: string;
    lineNumber: number;
    lineContent: string;
}

/** 递归扫描文件并在行级别执行文本匹配 */
async function searchInFiles(
    dir: string,
    baseDir: string,
    matcher: RegExp,
    includes?: string[],
    maxResults: number = 40
): Promise<MatchItem[]> {
    const results: MatchItem[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (results.length >= maxResults) {
            break;
        }

        if (IGNORED_FOLDERS.has(entry.name)) {
            continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            const subResults = await searchInFiles(fullPath, baseDir, matcher, includes, maxResults - results.length);
            results.push(...subResults);
        } else if (entry.isFile()) {
            if (includes && includes.length > 0) {
                const matchesExt = includes.some((ext) => entry.name.endsWith(ext.replace(/^\*/, "")));
                if (!matchesExt) continue;
            }

            try {
                const content = await fs.readFile(fullPath, "utf-8");
                const lines = content.split(/\r?\n/);
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

                for (let i = 0; i < lines.length; i++) {
                    if (matcher.test(lines[i])) {
                        results.push({
                            filePath: relPath,
                            lineNumber: i + 1,
                            lineContent: lines[i].trim()
                        });
                        if (results.length >= maxResults) {
                            break;
                        }
                    }
                }
            } catch {
                // 忽略非文本或无法读取的文件
            }
        }
    }

    return results;
}

/** 跨文件代码关键词与正则检索工具 */
export const grepSearchTool: AgentTool<typeof grepSearchParams> = {
    name: "grep_search",
    label: "代码检索工具",
    description: "在项目中跨文件搜索关键词或正则表达式。用于快速定位符号引用、函数定义或特定代码模式。",
    parameters: grepSearchParams,
    /** 执行全文搜索并返回命中行号与文本 */
    execute: async (toolCallId, params) => {
        try {
            const baseDir = process.cwd();
            const startDir = params.searchPath
                ? (path.isAbsolute(params.searchPath) ? params.searchPath : path.resolve(baseDir, params.searchPath))
                : baseDir;

            const matcher = params.isRegex
                ? new RegExp(params.query, "i")
                : new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

            const matches = await searchInFiles(startDir, baseDir, matcher, params.includes, 40);

            if (matches.length === 0) {
                return {
                    content: [{ type: "text", text: `未找到与 [${params.query}] 匹配的代码内容。` }],
                    details: { query: params.query, count: 0 }
                };
            }

            const formatted = matches
                .map((m) => `${m.filePath}:${m.lineNumber}: ${m.lineContent}`)
                .join("\n");

            return {
                content: [{
                    type: "text",
                    text: `搜索 [${params.query}] 共命中 ${matches.length} 处结果:\n${formatted}`
                }],
                details: { query: params.query, count: matches.length, matches }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `检索出错: ${error.message}` }],
                details: { error: error.message }
            };
        }
    }
};
