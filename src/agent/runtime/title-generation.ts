import { streamSimple } from "@mariozechner/pi-ai";
import type { ModelConfig } from "./model-config";
import { finishRequestDiagnostics, prepareModelRequest, type RequestDiagnostics } from "./model-adapter";

/** 清理生成的标题并限制展示长度 */
export function sanitizeTitle(raw: string): string {
    const cleaned = raw.replace(/^["'“‘《#\s]+|["'”’》\s]+$/g, "").replace(/[\r\n]+/g, " ").trim();
    return cleaned.slice(0, 20) || "新对话";
}

/** 使用同一份配置快照为工作线程和主线程生成标题 */
export async function generateTitle(userInput: string, config: ModelConfig, onDiagnostics?: (diagnostics: RequestDiagnostics) => void): Promise<string> {
    const started = Date.now();
    const request = prepareModelRequest({
        systemPrompt: "为用户输入生成简明会话标题，15 个字以内，只输出标题，不要解释、引号或标点。",
        messages: [{ role: "user", content: userInput.slice(0, 500), timestamp: 0 }]
    }, config.capabilities, "title", "off", 256, {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeoutMs: 20000,
        signal: AbortSignal.timeout(20000)
    });
    try {
        const response = await streamSimple(request.model, request.context, request.options).result();
        finishRequestDiagnostics(request.diagnostics, response, started);
        if (response.stopReason !== "stop") {
            request.diagnostics.failure = response.stopReason === "length" ? "output_truncated" : "api_error";
            throw new Error("标题生成未完成");
        }
        return sanitizeTitle(response.content.filter(block => block.type === "text").map(block => block.text).join(""));
    } catch (error) {
        request.diagnostics.failure ??= request.options.signal?.aborted ? "timeout" : "network_error";
        throw error;
    } finally {
        request.diagnostics.durationMs = Date.now() - started;
        onDiagnostics?.(request.diagnostics);
    }
}
