import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { isToolRecord } from "../tools/result";
import type { SpillConfig, SpillRef } from "./types";
import { SpillStore } from "./spill-store";
import { jsonBytes, utf8Head, utf8Tail } from "./text";

export const DEFAULT_SPILL_CONFIG: SpillConfig = {
    maxInlineBytes: 24000,
    maxInlineLines: 400,
    headLines: 30,
    tailLines: 20,
    maxDetailsBytes: 4096
};

const CONTROL_FIELDS = new Set([
    "success", "error", "reason", "timedOut", "aborted", "completed", "exitCode", "outputIncomplete",
    "outputTruncated", "outputStorageError", "operationStarted", "filePath", "mimeType", "evidenceId", "artifactPath",
    "stdoutPath", "stderrPath", "stdoutBytes", "stderrBytes", "id", "pid", "port", "skillName", "referenceName",
    "totalCount", "count", "totalLines", "lineCount", "startLine", "endLine", "nextOffsetBytes", "totalBytes"
]);

export class SpillPolicy {
    /** 校验整份结果及预览配置 */
    constructor(private readonly config: SpillConfig = DEFAULT_SPILL_CONFIG) {
        for (const value of [config.maxInlineBytes, config.maxInlineLines, config.headLines, config.tailLines, config.maxDetailsBytes ?? 4096]) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error("Spill 字节数与行数配置必须为正整数");
            }
        }
        if (config.maxInlineBytes < 2048) {
            throw new Error("Spill 内联预算至少为 2048 字节，以保留产物引用");
        }
    }

    /** 判断完整文本是否超过内联限制 */
    shouldSpill(text: string): boolean {
        return Buffer.byteLength(text, "utf8") > this.config.maxInlineBytes || text.split(/\r?\n/).length > this.config.maxInlineLines;
    }

    /** 生成可直接使用字节分页读取的产物引用 */
    formatNotice(ref: SpillRef): string {
        return `完整${ref.source === "details" ? "元数据" : "结果"}：${ref.locator}（${ref.totalBytes} 字节）。使用 read_file 的 offsetBytes/maxBytes 分页读取，或 grep_search 检索。`;
    }

    /** 生成不重复首尾且不拆开 UTF-8 字符的预览 */
    createPreview(lines: string[], ref: SpillRef, budget = this.config.maxInlineBytes - 1024): string {
        const text = lines.join("\n");
        const head = utf8Head(lines.slice(0, this.config.headLines).join("\n"), Math.floor(budget * 0.6));
        const remaining = text.slice(head.length);
        const tail = utf8Tail(remaining.split("\n").slice(-this.config.tailLines).join("\n"), Math.floor(budget * 0.4));
        ref.omittedBytes = Math.max(0, Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail));
        ref.omittedLines = Math.max(0, lines.length - head.split("\n").length - tail.split("\n").length);
        return `${head}\n[…中间内容已存盘…]\n${tail}\n${this.formatNotice(ref)}`;
    }

    /** 计算文本、元数据和包装总量，图片编码由图片预算负责 */
    inlineBytes(result: AgentToolResult<unknown>): number {
        return jsonBytes({ ...result, content: result.content.map(block => block.type === "image" ? { ...block, data: "" } : block) });
    }

    /** 保留运行控制字段，其他过大的元数据使用原文引用 */
    private retainedDetails(details: unknown): Record<string, unknown> {
        if (!isToolRecord(details)) {
            return {};
        }
        const retained: Record<string, unknown> = {};
        const cap = Math.min(this.config.maxDetailsBytes ?? 4096, Math.floor(this.config.maxInlineBytes / 3));
        const entries = Object.entries(details).sort(([, left], [, right]) =>
            Number(typeof left === "string") - Number(typeof right === "string"));
        for (const [key, value] of entries) {
            if (!CONTROL_FIELDS.has(key)) {
                continue;
            }
            const item = typeof value === "string" ? utf8Head(value, 512) : value;
            if (jsonBytes({ ...retained, [key]: item }) <= cap / 2) {
                retained[key] = item;
            }
        }
        return retained;
    }

    /** 先保存完整原文，再对全部文本块和元数据共同限额 */
    async processResult(toolName: string, toolCallId: string, result: AgentToolResult<unknown>,
        context: { sessionId: number; projectRoot: string }): Promise<AgentToolResult<unknown>> {
        if (isToolRecord(result.details) && typeof result.details.stdoutPath === "string") {
            const notice = `\n命令日志：${result.details.stdoutPath}\n错误日志：${result.details.stderrPath}\n${result.details.outputIncomplete ? "输出未收全，日志仅包含已收到的字节。" : "已收到的输出已完整存盘。"}`;
            result = { ...result, content: [...result.content, { type: "text", text: notice }] };
        }
        const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const detailsCap = Math.min(this.config.maxDetailsBytes ?? 4096, Math.floor(this.config.maxInlineBytes / 3));
        if (this.inlineBytes(result) <= this.config.maxInlineBytes && !this.shouldSpill(text) && jsonBytes(result.details) <= detailsCap) {
            return result;
        }

        // 原始内容块与元数据分别归档，图片继续使用原生内容块
        const refs: SpillRef[] = [];
        for (const source of ["result", "details"] as const) {
            const content = JSON.stringify(source === "result" ? result.content : result.details) ?? "null";
            const saved = await SpillStore.saveText({ ...context, toolName, toolCallId, source, content });
            refs.push({ ...saved, source, complete: true, omittedBytes: 0, omittedLines: 0, retrievalHint: "使用字节分页读取原文" });
        }
        const details = {
            ...this.retainedDetails(result.details),
            spilled: true,
            spillRef: refs[0],
            spillRefs: refs
        };
        if (jsonBytes(details) > detailsCap) {
            throw new Error("Spill 引用超过元数据预算，原始结果已归档：" + refs[0].absolutePath);
        }
        const images = result.content.filter(block => block.type === "image");
        const notices = refs.slice(1).map(ref => this.formatNotice(ref)).join("\n");
        let allowance = Math.max(0, this.config.maxInlineBytes - jsonBytes(details) - jsonBytes(notices) - 1024);
        while (true) {
            const preview = this.createPreview(text.split(/\r?\n/), refs[0], allowance) + "\n" + notices;
            const bounded: AgentToolResult<unknown> = { ...result, content: [{ type: "text", text: preview }, ...images], details };
            if (this.inlineBytes(bounded) <= this.config.maxInlineBytes && jsonBytes(details) <= detailsCap &&
                preview.split("\n").length <= this.config.maxInlineLines) {
                return bounded;
            }
            if (allowance === 0) {
                throw new Error("Spill 引用超过内联预算，原文已保存：" + refs[0].absolutePath);
            }
            allowance = Math.max(0, Math.floor(allowance / 2));
        }
    }
}
