import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generationPolicy, type GenerationPolicy } from "../agent/runtime/generation-policy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
    port: number;
    context: { windowTokens: number; compactionEnabled: boolean };
    llm: GenerationPolicy & {
        baseUrl: string;
        model: string;
        apiKey: string;
    };
}

/** 加载并获取全局环境变量配置 */
export function getAppConfig(): AppConfig {
    // 1. 优先从用户家目录全局配置 ~/.dusk/.env 加载
    const globalEnv = path.join(os.homedir(), ".dusk", ".env");
    if (fs.existsSync(globalEnv)) {
        try {
            process.loadEnvFile(globalEnv);
        } catch {}
    }

    // 2. 尝试从安装包自身源码根目录自带的 .env 兜底加载
    const packageEnv = path.resolve(__dirname, "../../.env");
    if (fs.existsSync(packageEnv)) {
        try {
            process.loadEnvFile(packageEnv);
        } catch {}
    }

    // 3. 允许当前被测试工程目录中的 .env 自定义覆盖
    try {
        process.loadEnvFile();
    } catch {}

    const port = Number(process.env.PORT) || 4000;
    const baseUrl = process.env.LLM_BASE_URL || "";
    const model = process.env.LLM_MODEL || "deepseek-chat";
    const windowTokens = Number(process.env.LLM_CONTEXT_WINDOW_TOKENS ?? 128000);
    if (!Number.isSafeInteger(windowTokens) || windowTokens <= 4096) throw new Error("LLM_CONTEXT_WINDOW_TOKENS 必须为大于 4096 的整数");
    const enabled = process.env.CONTEXT_COMPACTION_ENABLED ?? "true";
    if (!["true", "false"].includes(enabled)) throw new Error("CONTEXT_COMPACTION_ENABLED 必须为 true 或 false");
    const apiKey = process.env.LLM_API_KEY || "";
    /** 读取并校验可配置的生成预算与可选超时配置 */
    const policy = generationPolicy({
        maxTokens: process.env.LLM_MAX_OUTPUT_TOKENS === undefined ? 32768 : Number(process.env.LLM_MAX_OUTPUT_TOKENS),
        retryMaxTokens: process.env.LLM_RETRY_MAX_OUTPUT_TOKENS === undefined ? 65536 : Number(process.env.LLM_RETRY_MAX_OUTPUT_TOKENS),
        generationTimeoutMs: process.env.LLM_GENERATION_TIMEOUT_MS ? Number(process.env.LLM_GENERATION_TIMEOUT_MS) : undefined
    }, model);

    if (!baseUrl || !apiKey) {
        console.warn("[WARN] 尚未配置完整的 LLM_BASE_URL 或 LLM_API_KEY，LLM 调用可能会失败");
    }

    return {
        port,
        context: { windowTokens, compactionEnabled: enabled === "true" },
        llm: {
            ...policy,
            baseUrl,
            model,
            apiKey
        }
    };
}
