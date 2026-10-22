export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";

export interface GenerationPolicy {
    maxTokens: number;
    retryMaxTokens: number;
    generationTimeoutMs?: number;
}

/** 判断模型是否使用 MiMo 请求策略 */
export function isMiMoModel(model: string): boolean { return /^mimo-/i.test(model); }

/** 返回当前模型实际支持的思考设置名称 */
export function reasoningLabel(model: string, effort: string): string {
    return isMiMoModel(model) ? (effort === "off" ? "思考关闭" : "思考开启") : effort;
}

/** 合并并校验生成预算与可选超时配置 */
export function generationPolicy(input: Partial<GenerationPolicy> = {}, model = ""): GenerationPolicy {
    const policy: GenerationPolicy = {
        maxTokens: input.maxTokens === undefined ? 32768 : input.maxTokens,
        retryMaxTokens: input.retryMaxTokens === undefined ? 65536 : input.retryMaxTokens,
        generationTimeoutMs: input.generationTimeoutMs
    };
    if (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens <= 0) throw new Error("maxTokens 必须为正整数");
    if (!Number.isSafeInteger(policy.retryMaxTokens) || policy.retryMaxTokens <= 0) throw new Error("retryMaxTokens 必须为正整数");
    if (policy.generationTimeoutMs !== undefined && (!Number.isSafeInteger(policy.generationTimeoutMs) || policy.generationTimeoutMs <= 0)) {
        throw new Error("generationTimeoutMs 必须为正整数");
    }
    if (policy.retryMaxTokens < policy.maxTokens) throw new Error("retryMaxTokens 不得小于 maxTokens");
    return policy;
}

/** 计算下一档递增的输出预算，并判断是否仍可继续提档 */
export function escalateBudget(currentTokens: number, maxCeiling = 131072): { canEscalate: boolean; nextTokens: number } {
    if (currentTokens >= maxCeiling) {
        return { canEscalate: false, nextTokens: currentTokens };
    }
    const next = Math.min(maxCeiling, Math.max(currentTokens + 16384, Math.round(currentTokens * 1.5)));
    return { canEscalate: true, nextTokens: next };
}
