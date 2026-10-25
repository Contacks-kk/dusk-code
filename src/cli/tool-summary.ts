import { stripVTControlCharacters } from "node:util";
import { isToolRecord, readToolContent, readToolDetails, toolText } from "../agent/tools/result";

/** 去掉终端控制符和多余空白，保持预览只有一行 */
export function previewLine(text: string): string {
    return stripVTControlCharacters(text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 展开旧返回封装，限制深度以避免循环引用 */
function unwrapResult(result: unknown): unknown {
    for (let depth = 0; depth < 4 && isToolRecord(result) && "result" in result; depth++) {
        result = result.result;
    }
    return result;
}

/** 从结构化字段与内容块读取可显示的文本 */
export function resultText(result: unknown): string {
    const value = unwrapResult(result);
    if (typeof value === "string") {
        return value;
    }
    const details = readToolDetails(value) ?? (isToolRecord(value) ? value : {});
    const message = toolText(details.error) || toolText(details.reason) || toolText(details.message);
    if (message) {
        return message;
    }
    const content = readToolContent(value)?.filter(isToolRecord).map(block => toolText(block.text)).filter(Boolean).join("\n");
    return toolText(details.stderr) || content || toolText(details.stdout) || "";
}

/** 综合执行标记和实际返回判断失败，避免失败补丁显示为成功 */
export function resultFailed(result: unknown, isError = false): boolean {
    const value = unwrapResult(result);
    const details = readToolDetails(value) ?? (isToolRecord(value) ? value : {});
    return isError || (isToolRecord(value) && value.isError === true) || details.success === false || Boolean(details.error) || details.timedOut === true ||
        details.aborted === true || details.completed === false ||
        (typeof details.exitCode === "number" && details.exitCode !== 0);
}

/** 优先显示真正的错误原因，不把标准输出或完整JSON挤进预览 */
export function failureSummary(result: unknown): string {
    const value = unwrapResult(result);
    const details = readToolDetails(value) ?? (isToolRecord(value) ? value : {});
    if (details.timedOut) {
        return "执行超时";
    }
    if (details.aborted) {
        return "已中断";
    }
    const text = resultText(value);
    const stderr = text.split(/\[stderr\]:\s*/i).at(-1) ?? text;
    const lines = stderr.split(/\r?\n/).map(previewLine).filter(line => line && !/^\[(?:stdout|stderr)\]:?$|^\^+$|^at\s|^node:internal|^\[eval\]/i.test(line));
    const reason = lines.find(line => /\b\w*(?:Error|Exception)\b|\berror\b|\bfail(?:ed)?\b|not found|ENOENT|EACCES|未登记|找不到|无法|失败|超时|不存在|不允许|权限|拒绝|缺少|不能为空|未找到|无效/i.test(line)) ?? lines[0];
    if (reason && !/^[{\[]/.test(reason)) {
        return reason;
    }
    return typeof details.exitCode === "number" ? `退出码 ${details.exitCode}` : "执行未成功";
}

/** 提供简短成功结果，复杂数据保留在详情中 */
export function compactSummary(result: unknown): string {
    const value = unwrapResult(result);
    if (Array.isArray(value)) {
        return `${value.length} 项结果`;
    }
    const text = resultText(value);
    if (text && !/^[{\[]/.test(text.trim())) {
        return previewLine(text);
    }
    return "已完成";
}
