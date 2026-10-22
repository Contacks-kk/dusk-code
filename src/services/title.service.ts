import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { sessionService } from "./session.service";
import { modelConfigManager, type ModelConfig } from "../agent/runtime/model-config";
import { generateTitle, sanitizeTitle } from "../agent/runtime/title-generation";
import type { RequestDiagnostics } from "../agent/runtime/model-adapter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, "./title.worker.ts");

export class TitleService {
    /** 主线程使用与工作线程相同的适配和预算生成标题 */
    private async fallbackGenerate(userInput: string, config: ModelConfig, onDiagnostics?: (diagnostics: RequestDiagnostics) => void): Promise<string> {
        return generateTitle(userInput, config, onDiagnostics);
    }

    /** 异步派发 Worker 线程提取标题并持久化到指定会话 */
    public generateSessionTitleAsync(sessionId: number, userInput: string, snapshot?: ModelConfig,
        onDiagnostics?: (diagnostics: RequestDiagnostics) => void): void {
        const activeConfig = structuredClone(snapshot ?? modelConfigManager.getModelConfig());

        if (!activeConfig.baseUrl || !activeConfig.apiKey) {
            return;
        }

        try {
            // 启动独立工作线程执行异步提炼
            const worker = new Worker(workerPath, {
                workerData: {
                    userInput,
                    config: activeConfig
                },
                execArgv: process.execArgv
            });

            worker.on("message", async (msg: { success: boolean; title?: string; diagnostics?: RequestDiagnostics }) => {
                if (msg?.diagnostics) {
                    onDiagnostics?.(msg.diagnostics);
                }
                const finalTitle = msg?.title ? sanitizeTitle(msg.title) : undefined;
                if (finalTitle) {

                    // 标题保存失败不影响正在执行的主任务
                    try {
                        await sessionService.updateSession(sessionId, {
                            title: finalTitle
                        });
                    } catch {
                        // 下次会话更新时仍可重新设置标题
                    }
                }
            });

            worker.on("error", async () => {
                try {
                    // 工作线程崩溃时执行主线程异步兜底
                    const fallbackTitle = await this.fallbackGenerate(userInput, activeConfig, onDiagnostics);

                    // 持久化兜底标题
                    await sessionService.updateSession(sessionId, {
                        title: fallbackTitle
                    });
                } catch {
                    // 忽略兜底失败
                }
            });
        } catch {
            // Worker 创建失败时在微任务中执行降级请求
            Promise.resolve().then(async () => {
                try {
                    // 执行主线程降级提炼
                    const fallbackTitle = await this.fallbackGenerate(userInput, activeConfig, onDiagnostics);

                    // 持久化兜底标题
                    await sessionService.updateSession(sessionId, {
                        title: fallbackTitle
                    });
                } catch {
                    // 忽略降级失败
                }
            });
        }
    }
}

export const titleService = new TitleService();
