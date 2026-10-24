import { getModels, type Model, type OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { ReasoningEffort } from "./generation-policy";

export type LlmProvider = "auto" | "deepseek" | "mimo" | "bailian" | "openai-compatible";
export type RequestPurpose = "task" | "summary" | "title" | "recovery" | "skill_selection" | "task_requirements" | "acceptance_review" | "turn_intent" | "answer";
export type ThinkingLevelMap = Partial<Record<ReasoningEffort | "minimal", string | null>>;

export interface ModelOverride {
    reasoning?: boolean;
    canDisableThinking?: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    contextWindow?: number;
    maxOutputTokens?: number;
    compat?: OpenAICompletionsCompat;
}

export interface ResolvedModelCapabilities {
    modelId: string;
    baseUrl: string;
    provider: Exclude<LlmProvider, "auto">;
    reasoning: boolean;
    canDisableThinking?: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    thinkingControl: "deepseek" | "mimo" | "bailian" | "sdk";
    contextWindow: number;
    knownContextWindow?: number;
    maxOutputTokens?: number;
    compat: OpenAICompletionsCompat;
    verified: boolean;
    warnings: string[];
}

const EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
const COMPAT_BOOLEANS = ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
    "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages",
    "zaiToolStream", "supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention"];

/** 判断配置值是否为普通对象 */
function objectValue(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 拒绝配置中未声明的字段 */
function checkKeys(value: Record<string, unknown>, keys: string[], location: string): void {
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) {
            throw new Error(`${location}.${key} 是未知配置项`);
        }
    }
}

/** 校验路由对象中的字段及其值类型 */
function checkRouting(value: unknown, gateway: boolean, location: string): void {
    if (!objectValue(value)) {
        throw new Error(`${location} 必须为对象`);
    }
    const arrays = gateway ? ["only", "order"] : ["only", "order", "ignore", "quantizations"];
    const booleans = ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"];
    checkKeys(value, gateway ? arrays : [...arrays, ...booleans, "data_collection", "sort", "max_price", "preferred_min_throughput", "preferred_max_latency"], location);
    for (const [key, item] of Object.entries(value)) {
        let valid = false;
        if (arrays.includes(key)) {
            valid = Array.isArray(item) && item.every(entry => typeof entry === "string");
        } else if (booleans.includes(key)) {
            valid = typeof item === "boolean";
        } else if (key === "data_collection") {
            valid = item === "allow" || item === "deny";
        } else if (key === "sort") {
            valid = typeof item === "string";
            if (objectValue(item)) {
                checkKeys(item, ["by", "partition"], `${location}.${key}`);
                valid = Object.entries(item).every(([name, entry]) => typeof entry === "string" || (name === "partition" && entry === null));
            }
        } else if (key === "max_price" && objectValue(item)) {
            checkKeys(item, ["prompt", "completion", "image", "audio", "request"], `${location}.${key}`);
            valid = Object.values(item).every(entry => typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry) && entry >= 0));
        } else if (key.startsWith("preferred_")) {
            valid = typeof item === "number" && Number.isFinite(item) && item >= 0;
            if (objectValue(item)) {
                checkKeys(item, ["p50", "p75", "p90", "p99"], `${location}.${key}`);
                valid = Object.values(item).every(entry => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
            }
        }
        if (!valid) {
            throw new Error(`${location}.${key} 类型或取值无效`);
        }
    }
}

/** 校验 Pi 的 OpenAI 兼容选项，防止拼错字段后静默失效 */
function checkCompat(value: unknown, location: string): void {
    if (!objectValue(value)) {
        throw new Error(`${location} 必须为对象`);
    }
    const enums: Record<string, string[]> = {
        maxTokensField: ["max_tokens", "max_completion_tokens"],
        thinkingFormat: ["openai", "openrouter", "deepseek", "zai", "qwen", "qwen-chat-template"],
        cacheControlFormat: ["anthropic"]
    };
    checkKeys(value, [...COMPAT_BOOLEANS, ...Object.keys(enums), "openRouterRouting", "vercelGatewayRouting"], location);
    for (const [key, item] of Object.entries(value)) {
        if (key === "openRouterRouting" || key === "vercelGatewayRouting") {
            checkRouting(item, key === "vercelGatewayRouting", `${location}.${key}`);
        } else if (COMPAT_BOOLEANS.includes(key) ? typeof item !== "boolean" : typeof item !== "string" || !enums[key]?.includes(item)) {
            throw new Error(`${location}.${key} 类型或取值无效`);
        }
    }
}

/** 加载并严格校验按模型编号生效的覆盖配置 */
export function parseModelOverrides(raw = "{}"): Record<string, ModelOverride> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("LLM_MODEL_OVERRIDES 必须为有效 JSON 对象");
    }
    if (!objectValue(parsed)) {
        throw new Error("LLM_MODEL_OVERRIDES 必须为以模型 ID 为键的对象");
    }
    for (const [model, value] of Object.entries(parsed)) {
        const location = `LLM_MODEL_OVERRIDES[${model}]`;
        if (!model.trim() || !objectValue(value)) {
            throw new Error(`${location} 必须为模型配置对象`);
        }
        checkKeys(value, ["reasoning", "canDisableThinking", "thinkingLevelMap", "contextWindow", "maxOutputTokens", "compat"], location);
        for (const key of ["reasoning", "canDisableThinking"]) {
            if (key in value && typeof value[key] !== "boolean") {
                throw new Error(`${location}.${key} 必须为布尔值`);
            }
        }
        for (const key of ["contextWindow", "maxOutputTokens"]) {
            if (key in value && (!Number.isSafeInteger(value[key]) || Number(value[key]) <= (key === "contextWindow" ? 4096 : 0))) {
                throw new Error(`${location}.${key} 必须为有效的正整数`);
            }
        }
        if ("thinkingLevelMap" in value) {
            if (!objectValue(value.thinkingLevelMap)) {
                throw new Error(`${location}.thinkingLevelMap 必须为对象`);
            }
            checkKeys(value.thinkingLevelMap, [...EFFORTS, "minimal"], `${location}.thinkingLevelMap`);
            if (Object.values(value.thinkingLevelMap).some(item => item !== null && (typeof item !== "string" || !item.trim()))) {
                throw new Error(`${location}.thinkingLevelMap 的值必须为非空字符串或 null`);
            }
        }
        if ("compat" in value) {
            checkCompat(value.compat, `${location}.compat`);
        }
    }
    return parsed as Record<string, ModelOverride>;
}

/** 根据端点域名选择服务适配，显式配置可用于自定义网关 */
export function resolveProvider(baseUrl: string, configured: LlmProvider = "auto"): Exclude<LlmProvider, "auto"> {
    if (!["auto", "deepseek", "mimo", "bailian", "openai-compatible"].includes(configured)) {
        throw new Error("LLM_PROVIDER 仅支持 auto、deepseek、mimo、bailian、openai-compatible");
    }
    if (configured !== "auto") {
        return configured;
    }
    let host = "";
    try {
        host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return "openai-compatible";
    }
    if (host === "api.deepseek.com") {
        return "deepseek";
    }
    if (host === "api.xiaomimimo.com") {
        return "mimo";
    }
    if (/^dashscope(?:-intl|-us)?\.aliyuncs\.com$/.test(host) || /^[\w-]+\.(?:cn-beijing|us-east-1|ap-southeast-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(host)) {
        return "bailian";
    }
    return "openai-compatible";
}

/** 合并当前协议可复用的元数据、已验证端点规则和当前型号覆盖 */
export function resolveModelCapabilities(input: {
    model: string;
    baseUrl: string;
    provider?: LlmProvider;
    overrides?: Record<string, ModelOverride>;
    windowTokens?: number;
    windowExplicit?: boolean;
}): ResolvedModelCapabilities {
    const provider = resolveProvider(input.baseUrl, input.provider);
    const metadataProvider = provider === "deepseek" ? "deepseek" : provider === "openai-compatible" ? "openai" : undefined;
    const catalog = metadataProvider ? getModels(metadataProvider) as Model<"openai-completions">[] : [];
    const metadata = catalog.find(model => model.api === "openai-completions" && model.id === input.model);
    let builtin: ModelOverride = {};
    let thinkingControl: ResolvedModelCapabilities["thinkingControl"] = "sdk";
    const deepseek = ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(input.model);
    const bailianDeepseek = ["deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4-pro-0813", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"].includes(input.model);
    if ((provider === "deepseek" && deepseek) || (provider === "bailian" && bailianDeepseek)) {
        const supportsLow = provider === "deepseek" || input.model !== "deepseek-v4-pro";
        builtin = {
            reasoning: true,
            canDisableThinking: true,
            contextWindow: 1048576,
            maxOutputTokens: 393216,
            thinkingLevelMap: {
                minimal: null,
                low: supportsLow ? "low" : null,
                medium: provider === "deepseek" ? "high" : null,
                high: "high",
                xhigh: "max"
            },
            compat: {
                maxTokensField: "max_tokens",
                thinkingFormat: provider === "bailian" ? "qwen" : "deepseek",
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: provider === "deepseek"
            }
        };
        thinkingControl = provider === "deepseek" ? "deepseek" : "bailian";
    } else if (provider === "mimo" && ["mimo-v2-flash", "mimo-v2-pro", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6", "mimo-v2.6-flash"].includes(input.model)) {
        builtin = {
            reasoning: true,
            canDisableThinking: true,
            contextWindow: /v2[.-][56]/i.test(input.model) ? 1048576 : 262144,
            maxOutputTokens: 131072,
            compat: {
                maxTokensField: "max_completion_tokens",
                thinkingFormat: "deepseek",
                supportsDeveloperRole: false,
                supportsReasoningEffort: false
            }
        };
        thinkingControl = "mimo";
    }
    const override = input.overrides && Object.hasOwn(input.overrides, input.model) ? input.overrides[input.model] : {};
    if (override.compat?.thinkingFormat && override.compat.thinkingFormat !== builtin.compat?.thinkingFormat) {
        thinkingControl = "sdk";
    }
    const merged = { ...metadata, ...builtin, ...override };
    const knownContextWindow = merged.contextWindow;
    let contextWindow = input.windowTokens ?? 256000;
    const warnings: string[] = [];
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 4096) {
        throw new Error("上下文窗口必须为大于 4096 的整数");
    }
    if (knownContextWindow && contextWindow > knownContextWindow) {
        if (input.windowExplicit) {
            throw new Error(`LLM_CONTEXT_WINDOW_TOKENS=${contextWindow} 超过 ${input.model} 已知上限 ${knownContextWindow}`);
        }
        warnings.push(`上下文默认窗口 ${contextWindow} 已下调为 ${input.model} 的已知上限 ${knownContextWindow}`);
        contextWindow = knownContextWindow;
    }
    const verified = thinkingControl !== "sdk";
    if (!verified) {
        warnings.push(`${input.model}（${provider}）：适配未验证；采用 SDK 默认处理，思考关闭效果未验证`);
    }
    return {
        modelId: input.model,
        baseUrl: input.baseUrl.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/i, ""),
        provider,
        reasoning: merged.reasoning ?? true,
        canDisableThinking: merged.reasoning === false ? true : merged.canDisableThinking,
        thinkingLevelMap: { ...metadata?.thinkingLevelMap, ...builtin.thinkingLevelMap, ...override.thinkingLevelMap },
        thinkingControl,
        contextWindow,
        knownContextWindow,
        maxOutputTokens: merged.maxOutputTokens ?? metadata?.maxTokens,
        compat: { ...metadata?.compat, ...builtin.compat, ...override.compat } as OpenAICompletionsCompat,
        verified,
        warnings
    };
}

/** 获取当前模型允许用户选择的思考设置 */
export function supportedEfforts(profile: ResolvedModelCapabilities): ReasoningEffort[] {
    if (!profile.reasoning) {
        return ["off"];
    }
    return EFFORTS.filter(effort => {
        if (effort === "off") {
            return profile.canDisableThinking !== false && profile.thinkingLevelMap?.off !== null;
        }
        if (effort === "xhigh" && profile.thinkingControl !== "mimo" && profile.thinkingLevelMap?.xhigh === undefined) {
            return false;
        }
        return profile.thinkingLevelMap?.[effort] !== null;
    });
}

/** 在联网前拒绝当前模型不支持的显式思考设置 */
export function validateEffort(profile: ResolvedModelCapabilities, effort: string): asserts effort is ReasoningEffort {
    const supported = supportedEfforts(profile);
    if (!supported.includes(effort as ReasoningEffort)) {
        throw new Error(`${profile.modelId} 不支持思考设置 ${effort}，可用值：${supported.join("、")}`);
    }
}

/** 创建用于所有调用用途的 SDK 模型，保持历史协议身份不变 */
export function sdkModel(profile: ResolvedModelCapabilities): Model<"openai-completions"> {
    return {
        id: profile.modelId,
        name: profile.modelId,
        api: "openai-completions",
        provider: "openai",
        baseUrl: profile.baseUrl,
        reasoning: profile.reasoning,
        thinkingLevelMap: profile.thinkingLevelMap,
        input: ["text", "image"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0
        },
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxOutputTokens ?? 32768,
        compat: profile.compat
    };
}
