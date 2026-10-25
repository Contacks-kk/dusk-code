import type { SpillConfig, SpillRef } from "./types";
import { SpillStore } from "./spill-store";

export const DEFAULT_SPILL_CONFIG: SpillConfig = {
    maxInlineBytes: 24000,
    maxInlineLines: 400,
    headLines: 30,
    tailLines: 20
};

export class SpillPolicy {
    /** 初始化配置截断与存盘阈值 */
    constructor(private readonly config: SpillConfig = DEFAULT_SPILL_CONFIG) {}

    /** 判断单段文本是否需要触发 Spill 下溢截断 */
    shouldSpill(text: string): boolean {
        if (Buffer.byteLength(text, "utf-8") > this.config.maxInlineBytes) {
            return true;
        }

        const lines = text.split(/\r?\n/).length;
        if (lines > this.config.maxInlineLines) {
            return true;
        }
        return false;
    }

    /** 格式化面向模型的引导提示词说明 */
    formatNotice(ref: SpillRef): string {
        return `(已省略 ${ref.omittedBytes.toLocaleString()} 字节 / ${ref.omittedLines} 行。完整格式化输出已持久化于：${ref.locator}。${ref.retrievalHint})`;
    }

    /** 截断并拼接保留首尾关键帧的预览文本 */
    createPreview(lines: string[], ref: SpillRef): string {
        const head = lines.slice(0, this.config.headLines).join("\n");
        const tail = lines.slice(-this.config.tailLines).join("\n");
        const gap = `\n\n[... 此处省略了 ${ref.omittedLines} 行中间输出 ...]\n\n`;
        const notice = `\n\n${this.formatNotice(ref)}`;
        return `${head}${gap}${tail}${notice}`;
    }

    /** 处理工具原始返回对象并在超限时自动全量存盘与精简化 */
    async processResult(
        toolName: string,
        toolCallId: string,
        result: unknown,
        context: { sessionId: number; projectRoot: string }
    ): Promise<unknown> {
        if (!result || typeof result !== "object" || !("content" in result)) {
            return result;
        }

        const res = result as { content?: unknown[]; details?: Record<string, unknown> };
        if (!Array.isArray(res.content)) {
            return result;
        }

        let modified = false;
        const newContent: unknown[] = [];

        // 检查并处理内容文本块
        for (const block of res.content) {
            if (block && typeof block === "object" && "type" in block && (block as any).type === "text" && typeof (block as any).text === "string") {
                const text = (block as any).text as string;
                if (this.shouldSpill(text)) {
                    // 全量持久化至磁盘文件
                    const saved = await SpillStore.saveText({
                        sessionId: context.sessionId,
                        toolName,
                        toolCallId,
                        content: text,
                        projectRoot: context.projectRoot
                    });

                    const allLines = text.split(/\r?\n/);
                    const headPart = allLines.slice(0, this.config.headLines).join("\n");
                    const tailPart = allLines.slice(-this.config.tailLines).join("\n");
                    const omittedBytes = saved.totalBytes - Buffer.byteLength(headPart + tailPart, "utf-8");
                    const omittedLines = Math.max(0, saved.totalLines - this.config.headLines - this.config.tailLines);

                    const ref: SpillRef = {
                        ...saved,
                        omittedBytes,
                        omittedLines,
                        retrievalHint: "如需分段阅读或检索关键字，请使用 read_file 或 grep_search 查看该文件。"
                    };

                    const previewText = this.createPreview(allLines, ref);
                    newContent.push({
                        type: "text",
                        text: previewText
                    });

                    // 在 details 元数据中记录已溢出标记
                    res.details = {
                        ...res.details,
                        spilled: true,
                        spillRef: ref
                    };
                    modified = true;
                    continue;
                }
            }
            newContent.push(block);
        }

        if (!modified) {
            return result;
        }

        return {
            ...res,
            content: newContent
        };
    }
}
