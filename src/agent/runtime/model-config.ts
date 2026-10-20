import { getAppConfig } from "../../config/env";
import { generationPolicy, reasoningLabel, type GenerationPolicy, type ReasoningEffort } from "./generation-policy";

export type { ReasoningEffort } from "./generation-policy";

export interface ModelConfig extends GenerationPolicy {
    model: string;
    reasoningEffort: ReasoningEffort;
    baseUrl: string;
    apiKey: string;
}

export class ModelConfigManager {
    private currentModel: string;
    private currentReasoningEffort: ReasoningEffort;
    private baseUrl: string;
    private apiKey: string;
    private policy: GenerationPolicy;

    /** 加载模型连接信息与生成策略 */
    constructor() {
        const appConfig = getAppConfig();
        this.currentModel = appConfig.llm.model || "deepseek-chat";
        this.currentReasoningEffort = (process.env.LLM_REASONING_EFFORT as ReasoningEffort) || "high";
        this.baseUrl = appConfig.llm.baseUrl;
        this.apiKey = appConfig.llm.apiKey;
        this.policy = generationPolicy(appConfig.llm, this.currentModel);
    }

    /** 获取当前生效的模型与推理等级配置 */
    public getModelConfig(): ModelConfig {
        return {
            ...this.policy,
            model: this.currentModel,
            reasoningEffort: this.currentReasoningEffort,
            baseUrl: this.baseUrl,
            apiKey: this.apiKey
        };
    }

    /** 切换当前模型名称 */
    public setModel(modelName: string): void {
        const model = modelName.trim();
        generationPolicy(this.policy, model);
        this.currentModel = model;
    }

    /** 切换当前推理思考等级 */
    public setReasoningEffort(effort: ReasoningEffort): void {
        this.currentReasoningEffort = effort;
    }

    /** 获取格式化后的模型与思考等级展示标签 */
    public getDisplayLabel(): { model: string; effort: string } {
        return {
            model: this.currentModel,
            effort: reasoningLabel(this.currentModel, this.currentReasoningEffort)
        };
    }
}

export const modelConfigManager = new ModelConfigManager();
