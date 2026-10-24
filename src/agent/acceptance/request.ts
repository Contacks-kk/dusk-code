import { streamSimple, type Context } from "@mariozechner/pi-ai";
import type { ModelConfig } from "../runtime/model-config";
import { prepareModelRequest, finishRequestDiagnostics, requestErrorMessage, type RequestDiagnostics } from "../runtime/model-adapter";
import { requestTokens } from "../context/token";

/** 执行带预算、取消及诊断记录的独立验收请求 */
export async function acceptanceRequest(config: ModelConfig, context: Context, purpose: "task_requirements" | "acceptance_review",
    diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    const timeoutMs = 120000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const request = prepareModelRequest(context, config.capabilities, purpose, config.reasoningEffort, 8192, {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeoutMs,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    try {
        signal?.throwIfAborted();
        const reserve = request.diagnostics.maxTokens + Math.max(4096, config.capabilities.contextWindow * .05);
        if (requestTokens(context.messages, context.systemPrompt ?? "", []) + reserve > config.capabilities.contextWindow) {
            throw new Error("独立验收请求超过上下文预算，不能省略验收要求冒充成功");
        }
        const response = await streamSimple(request.model, request.context, request.options).result();
        finishRequestDiagnostics(request.diagnostics, response, started);
        signal?.throwIfAborted();
        if (response.stopReason !== "stop") {
            throw new Error(response.errorMessage || `验收请求未完成：${response.stopReason}`);
        }
        return response.content.filter(block => block.type === "text").map(block => block.text).join("");
    } catch (error) {
        request.diagnostics.failure = signal?.aborted ? "aborted" : timeout.aborted ? "timeout" : "acceptance_failed";
        const reason = timeout.aborted ? `验收辅助请求 ${purpose} 超时（${timeoutMs / 1000}秒）` : requestErrorMessage(error, config.apiKey);
        throw new Error(reason, { cause: error });
    } finally {
        request.diagnostics.durationMs = Date.now() - started;
        diagnostics(request.diagnostics);
    }
}
