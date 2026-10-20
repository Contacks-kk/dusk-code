import { randomUUID } from "node:crypto";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { isMiMoModel, type ReasoningEffort } from "./generation-policy";

/** 统一准备模型历史与请求，保留 SDK 的默认兼容处理 */
export function prepareModelRequest(context: Context, model: Model<any>, effort: ReasoningEffort,
    onPayload?: SimpleStreamOptions["onPayload"]) {
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

    return {
        context: { ...context, messages },
        /** 执行已有请求回调，再清理序列化标记与已知模型参数差异 */
        async onPayload(payload: unknown): Promise<unknown> {
            const overridden = await onPayload?.(payload, model);
            const selected = overridden === undefined ? payload : overridden;
            if (!selected || typeof selected !== "object" || Array.isArray(selected)) return selected;
            const request: Record<string, unknown> = { ...(selected as Record<string, unknown>) };
            const wireMessages = request.messages;
            if (Array.isArray(wireMessages)) {
                request.messages = wireMessages.map(message => message.role === "assistant" && message.content === marker
                    ? { ...message, content: "" } : message);
            }
            if (model.api === "openai-completions" && isMiMoModel(model.id)) {
                request.thinking = { type: effort === "off" ? "disabled" : "enabled" };
                delete request.reasoning_effort;
            }
            return request;
        }
    };
}
