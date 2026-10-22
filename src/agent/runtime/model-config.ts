import { getAppConfig, type AppConfig } from "../../config/env";
import { generationPolicy, type GenerationPolicy, type ReasoningEffort } from "./generation-policy";
import { resolveModelCapabilities, supportedEfforts, validateEffort, type ResolvedModelCapabilities } from "./model-profile";
import { prepareModelRequest } from "./model-adapter";

export type { ReasoningEffort } from "./generation-policy";

export interface ModelConfig extends GenerationPolicy {
    model: string;
    reasoningEffort: ReasoningEffort;
    baseUrl: string;
    apiKey: string;
    capabilities: ResolvedModelCapabilities;
}

export class ModelConfigManager {
    private currentModel: string;
    private currentReasoningEffort: ReasoningEffort;
    private readonly appConfig: AppConfig;
    private readonly policy: GenerationPolicy;

    /** 保存连接配置并验证初始模型和思考设置 */
    constructor() {
        this.appConfig = getAppConfig();
        this.currentModel = this.appConfig.llm.model;
        this.policy = generationPolicy(this.appConfig.llm);
        const profile = this.resolveModel(this.currentModel);
        const supported = supportedEfforts(profile);
        const defaultEffort = supported.includes("high") ? "high" : supported[0];
        const effort = process.env.LLM_REASONING_EFFORT ?? defaultEffort;
        validateEffort(profile, effort);
        this.currentReasoningEffort = effort;
    }

    /** 重新解析指定型号，避免继承上一型号的覆盖项 */
    public resolveModel(model: string): ResolvedModelCapabilities {
        return resolveModelCapabilities({
            model: model.trim(),
            baseUrl: this.appConfig.llm.baseUrl,
            provider: this.appConfig.llm.provider,
            overrides: this.appConfig.llm.modelOverrides,
            windowTokens: this.appConfig.context.windowTokens,
            windowExplicit: this.appConfig.context.windowExplicit
        });
    }

    /** 返回可序列化且不会随模型切换改变的配置快照 */
    public getModelConfig(): ModelConfig {
        return structuredClone({
            ...this.policy,
            model: this.currentModel,
            reasoningEffort: this.currentReasoningEffort,
            baseUrl: this.appConfig.llm.baseUrl,
            apiKey: this.appConfig.llm.apiKey,
            capabilities: this.resolveModel(this.currentModel)
        });
    }

    /** 完整验证后一次性切换模型与思考设置 */
    public configureModel(modelName: string, requestedEffort?: string): void {
        const model = modelName.trim();
        if (!model) {
            throw new Error("模型 ID 不得为空");
        }
        const profile = this.resolveModel(model);
        const supported = supportedEfforts(profile);
        const effort = requestedEffort ?? (supported.includes("high") ? "high" : supported[0]);
        validateEffort(profile, effort);
        this.currentModel = model;
        this.currentReasoningEffort = effort;
    }

    /** 切换型号并重新选择受支持的默认思考设置 */
    public setModel(modelName: string): void {
        this.configureModel(modelName);
    }

    /** 验证并切换当前模型的思考设置 */
    public setReasoningEffort(effort: ReasoningEffort): void {
        this.configureModel(this.currentModel, effort);
    }

    /** 展示请求设置及实际映射，未知适配明确标注 */
    public getDisplayLabel(): { model: string; effort: string } {
        const profile = this.resolveModel(this.currentModel);
        const requested = this.currentReasoningEffort;
        const diagnostics = prepareModelRequest({ messages: [] }, profile, "task", requested, this.policy.maxTokens).diagnostics;
        const effective = diagnostics.effectiveThinking === "enabled" ? "思考开启" : diagnostics.effectiveThinking === "disabled" ? "思考关闭" :
            diagnostics.effectiveThinking === "sdk-default" ? "SDK 默认（关闭未验证）" : diagnostics.effectiveThinking;
        return {
            model: this.currentModel,
            effort: `${requested === effective ? requested : `${requested} → ${effective}`}${profile.verified ? "" : "，适配未验证"}`
        };
    }
}

export const modelConfigManager = new ModelConfigManager();
