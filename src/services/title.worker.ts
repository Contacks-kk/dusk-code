import { parentPort, workerData } from "node:worker_threads";
import type { ModelConfig } from "../agent/runtime/model-config";
import { generateTitle, sanitizeTitle } from "../agent/runtime/title-generation";
import type { RequestDiagnostics } from "../agent/runtime/model-adapter";

interface TitleWorkerPayload {
    userInput: string;
    config: ModelConfig;
}

/** 从主线程配置快照生成标题，失败时返回本地短标题 */
async function generateTitleInWorker(): Promise<void> {
    const payload = workerData as TitleWorkerPayload | undefined;
    if (!payload?.userInput || !payload.config) {
        parentPort?.postMessage({ success: false, title: "新对话" });
        return;
    }
    let diagnostics: RequestDiagnostics | undefined;
    try {
        const title = await generateTitle(payload.userInput, payload.config, value => { diagnostics = value; });
        parentPort?.postMessage({ success: true, title, diagnostics });
    } catch {
        parentPort?.postMessage({ success: false, title: sanitizeTitle(payload.userInput.slice(0, 15)), diagnostics });
    }
}

void generateTitleInWorker();
