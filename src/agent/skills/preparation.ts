import type { StoredHistoryTurn } from "../context/history";
import type { ModelConfig } from "../runtime/model-config";
import { requestErrorMessage, type RequestDiagnostics } from "../runtime/model-adapter";
import { SkillRegistry } from "./registry";
import { SkillRuntime } from "./runtime";
import { selectSkills } from "./selector";

interface SkillPreparation {
    projectRoot: string;
    skillState: unknown;
    userInput: string;
    history: StoredHistoryTurn[];
    modelConfig: ModelConfig;
    onStatus?: (text: string) => void;
    onDiagnostics: (diagnostics: RequestDiagnostics) => void;
    signal?: AbortSignal;
    outputs?: string[];
    visualRequired?: boolean;
}

/** 提取最近任务和方案，供简短确认消息沿用原有任务语境 */
function recentSkillContext(history: StoredHistoryTurn[]): string {
    return JSON.stringify(history.slice(-4).map(item => ({
        messages: item.messages.filter(saved => saved.role === "user" || saved.role === "assistant")
            .map(saved => ({ role: saved.role, content: saved.content.slice(0, 6000) })),
        previousSelection: item.turn.executionJson?.skills?.selection
    })));
}

/** 为自动选择失败保留明确的降级记录 */
function selectionFailed(runtime: SkillRuntime, error: unknown, options: SkillPreparation): void {
    const reason = requestErrorMessage(error, options.modelConfig.apiKey);
    runtime.record.selection = {
        status: "failed",
        skills: [],
        error: reason
    };
    options.onStatus?.(`技能自动选择失败：${reason}；使用成功加载的技能继续。`);
}

/** 选择当前任务所需技能，单个技能失败不阻断其他加载 */
async function loadAutomaticSkills(runtime: SkillRuntime, options: SkillPreparation): Promise<void> {
    const catalog = await runtime.registry.getAll();
    if (!catalog.length || options.signal?.aborted) {
        return;
    }
    options.onStatus?.("正在根据当前任务选择技能。");
    try {
        const selection = await selectSkills(options.userInput, recentSkillContext(options.history), catalog,
            runtime.state, options.modelConfig, options.onDiagnostics, options.signal, options.outputs);
        runtime.record.selection = { status: "completed", skills: selection.skills, coverage: selection.coverage };
        runtime.requireVisual(options.visualRequired ?? selection.needsVisualVerification);
        for (const selected of selection.skills) {
            await runtime.loadOptional(selected.name, "auto", selected.reason);
        }
    } catch (error) {
        selectionFailed(runtime, error, options);
    }
}

/** 准备本轮技能快照，手动技能先加载且最近选择者优先 */
export async function prepareTurnSkills(options: SkillPreparation): Promise<SkillRuntime> {
    const registry = new SkillRegistry();
    await registry.init(options.projectRoot);
    const runtime = new SkillRuntime(registry, options.skillState, options.onStatus);

    // 固定技能的加载顺序决定预算不足时的保留优先级
    for (const name of [...runtime.state.pinned].reverse()) {
        await runtime.loadOptional(name, "manual", "当前会话手动固定");
    }

    // 根据本轮任务补充自动选择的技能
    await loadAutomaticSkills(runtime, options);
    return runtime;
}
