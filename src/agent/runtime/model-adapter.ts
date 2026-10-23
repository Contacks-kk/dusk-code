import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, SimpleStreamOptions, Usage } from "@mariozechner/pi-ai";
import type { ReasoningEffort } from "./generation-policy";
import { sdkModel, supportedEfforts, validateEffort, type RequestPurpose, type ResolvedModelCapabilities } from "./model-profile";
import { estimateTokenCount } from "../context/token";

/** 提取请求失败原因并移除当前接口密钥 */
export function requestErrorMessage(error: unknown, apiKey: string): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(apiKey || "\0").join("[REDACTED]");
}

export interface RequestDiagnostics {
    purpose: RequestPurpose;
    provider: string;
    verified: boolean;
    requestedMaxTokens: number;
    maxTokens: number;
    budgetField?: "max_tokens" | "max_completion_tokens";
    requestedThinking: string;
    effectiveThinking: string;
    thinkingMapping?: string;
    downgrade?: string;
    stopReason?: string;
    textChars?: number;
    estimatedTextTokens?: number;
    thinkingChars?: number;
    supplierUsage?: Usage;
    durationMs?: number;
    failure?: string;
}

/** 补齐正文和思考统计，不将供应商输出用量当成正文长度 */
export function finishRequestDiagnostics(diagnostics: RequestDiagnostics, response: AssistantMessage, started: number): void {
    const text = response.content.filter(block => block.type === "text").map(block => block.text).join("");
    diagnostics.stopReason = response.stopReason;
    diagnostics.textChars = text.length;
    diagnostics.estimatedTextTokens = estimateTokenCount(text);
    diagnostics.thinkingChars = response.content.reduce((sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0), 0);
    diagnostics.supplierUsage = response.usage;
    diagnostics.durationMs = Date.now() - started;
}

/** 统一准备模型历史与请求，保留 SDK 的默认兼容处理 */
export function prepareModelRequest(context: Context, profile: ResolvedModelCapabilities, purpose: RequestPurpose,
    requestedEffort: ReasoningEffort = "high", requestedMaxTokens = 32768, options: SimpleStreamOptions = {}) {
    const model = sdkModel(profile);
    const requestedThinking = purpose === "task" ? requestedEffort : "off";
    let effort: ReasoningEffort | undefined = requestedThinking;
    let downgrade: string | undefined;
    if (purpose === "task") {
        validateEffort(profile, requestedThinking);
    } else if (!profile.reasoning) {
        effort = "off";
    } else if (profile.canDisableThinking === false || profile.thinkingLevelMap?.off === null) {
        effort = supportedEfforts(profile).find(level => level !== "off");
        if (!effort) {
            throw new Error(`${profile.modelId} 没有可用于辅助请求的思考设置`);
        }
        downgrade = `模型不允许关闭思考，辅助请求降为 ${effort}`;
    } else if (profile.canDisableThinking !== true) {
        effort = undefined;
        downgrade = "思考关闭效果未验证，辅助请求采用 SDK 默认行为";
    }
    const toggleOnly = profile.thinkingControl === "mimo" || profile.compat.supportsReasoningEffort === false;
    const mapped = effort === undefined ? "sdk-default" : effort === "off" ? "disabled" :
        toggleOnly ? "enabled" : profile.thinkingLevelMap?.[effort] ?? effort;
    if (downgrade && effort && effort !== "off" && toggleOnly) {
        downgrade = "模型不允许关闭思考，辅助请求保持思考开启";
    }
    const budget = purpose === "summary" ? 4096 : purpose === "title" ? 256 : requestedMaxTokens;
    const maxTokens = Math.min(budget, profile.maxOutputTokens ?? budget);
    const diagnostics: RequestDiagnostics = {
        purpose,
        provider: profile.provider,
        verified: profile.verified,
        requestedMaxTokens: budget,
        maxTokens,
        requestedThinking,
        effectiveThinking: !profile.reasoning ? "disabled" : effort === "off" && !profile.verified && profile.canDisableThinking !== true ? "sdk-default" : mapped,
        thinkingMapping: effort,
        downgrade
    };
    const marker = `__dusk_thinking_${randomUUID()}__`;
    const thinkingAsText = model.compat && "requiresThinkingAsText" in model.compat && model.compat.requiresThinkingAsText;
    const messages = context.messages.map(message => {
        if (model.api !== "openai-completions" || thinkingAsText ||
            message.role !== "assistant" || message.api !== model.api || message.provider !== model.provider ||
            message.model !== model.id || message.stopReason === "error" || message.stopReason === "aborted") {
            return message;
        }
        const hasThinking = message.content.some(block => block.type === "thinking" && !block.redacted &&
            block.thinking.trim() && block.thinkingSignature);
        const hasOutput = message.content.some(block => block.type === "toolCall" || (block.type === "text" && block.text.trim()));
        if (!hasThinking || hasOutput) {
            return message;
        }
        return { ...message, content: [...message.content, { type: "text" as const, text: marker }] };
    });

    const requestOptions: SimpleStreamOptions = {
        ...options,
        maxTokens,
        reasoning: effort && effort !== "off" ? effort : undefined,
        onPayload: adaptPayload
    };
    return {
        model,
        context: { ...context, messages },
        options: requestOptions,
        diagnostics
    };

    /** 执行已有请求回调，再清理序列化标记与已知端点参数差异 */
    async function adaptPayload(payload: unknown): Promise<unknown> {
        const overridden = await options.onPayload?.(payload, model);
        const selected = overridden === undefined ? payload : overridden;
        if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
            return selected;
        }
        const request: Record<string, unknown> = { ...(selected as Record<string, unknown>) };
        const wireMessages = request.messages;
        if (Array.isArray(wireMessages)) {
            request.messages = wireMessages.map(message => message.role === "assistant" && message.content === marker
                ? { ...message, content: "" } : message);
        }
        const field = profile.compat.maxTokensField ?? ("max_tokens" in request ? "max_tokens" : "max_completion_tokens");
        diagnostics.budgetField = field;
        request[field] = maxTokens;
        delete request[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"];
        if (profile.reasoning && profile.thinkingControl !== "sdk") {
            const enabled = effort !== "off";
            if (profile.thinkingControl === "bailian") {
                request.enable_thinking = enabled;
                delete request.thinking;
            } else {
                request.thinking = { type: enabled ? "enabled" : "disabled" };
                delete request.enable_thinking;
            }
            if (enabled && !toggleOnly) {
                request.reasoning_effort = mapped;
            } else {
                delete request.reasoning_effort;
            }
        }
        if (profile.compat.supportsReasoningEffort === false) {
            delete request.reasoning_effort;
        }
        return request;
    }
}
