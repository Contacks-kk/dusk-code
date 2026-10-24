import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ModelConfig } from "./model-config";
import { prepareModelRequest, finishRequestDiagnostics, type RequestDiagnostics } from "./model-adapter";
import { parseModelObject } from "./model-json";
import type { DeliveryRecord } from "../acceptance/types";
import { isToolRecord } from "../tools/result";

export type TurnIntent = "answer" | "inspect" | "plan" | "execute" | "verify" | "stop";
export interface TurnControl {
    intent: TurnIntent;
    instructionRevision: number;
    userMessageRef: string;
    input: string;
    taskId?: string;
    scope: "none" | "startup" | "contract";
    resumeTask: boolean;
    resumeAfterAnswer: boolean;
    allowVerification: boolean;
    endCondition: string;
    clarification?: string;
    verificationProhibited?: boolean;
}

export interface RuntimeControlMessage {
    role: "runtime_control";
    content: string;
    timestamp: number;
    instructionRevision: number;
}

declare module "@mariozechner/pi-agent-core" {
    interface CustomAgentMessages {
        runtime_control: RuntimeControlMessage;
    }
}

/** 读取统一执行预算，非法配置在任务开始前失败 */
export function executionPolicy() {
    const defaults = {
        intentMs: 8000,
        answerMs: 45000,
        runMs: 3600000,
        verificationMs: 1200000,
        repairs: 3
    };
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
        const supplied = process.env[`DUSK_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`];
        if (supplied !== undefined) {
            const value = Number(supplied);
            if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
                throw new Error(`DUSK 执行预算 ${key} 必须为正整数`);
            }
            defaults[key] = value;
        }
    }
    return defaults;
}

/** 建立本轮独立边界，不把关联项目的全部要求当成当前指令 */
export function turnControl(input: string, intent: TurnIntent, revision = 1): TurnControl {
    return {
        intent,
        instructionRevision: revision,
        userMessageRef: "",
        input,
        scope: intent === "execute" || intent === "verify" ? "contract" : "none",
        resumeTask: false,
        resumeAfterAnswer: false,
        allowVerification: intent === "execute" || intent === "verify",
        endCondition: intent === "answer" || intent === "stop" ? "依据已有事实回答后结束，不调用工具" : "完成本轮范围后汇报并结束"
    };
}

/** 识别明确控制要求，复杂表达仍交给语义分类 */
export function explicitControl(input: string, revision = 1): TurnControl | undefined {
    const text = input.trim();
    const action = /(?:修复|修改|实现|开发|创建|启动|检查|验证).{0,30}(?:后|完|完成后|然后|再).{0,15}(?:回答|告诉|汇报)/.test(text) ||
        /(?:^|[，,；;])(?:请|请你|帮我|先|再|然后|只)?(?:修复|修改|实现|开发|创建|启动|检查|验证)/.test(text);
    if (!action && /(?:直接|只需|只要|只|仅)(?:回答|告诉我|说结论)|(?:不要|别|停止|不用)(?:再)?(?:测试|验收|执行|检查|操作)/.test(text)) {
        return turnControl(input, "answer", revision);
    }
    if (/^(?:停|停止|停下|暂停|stop|\/stop)[。！!\s]*$/i.test(text)) {
        return turnControl(input, "stop", revision);
    }
    if (/^(?:现在|目前|项目|这个项目|当前|那)?(?:项目)?(?:现在)?(?:可以|能|能够)启动(?:了)?吗[？?。\s]*$/.test(text)) {
        return turnControl(input, "answer", revision);
    }
    if (/^(?:进度|现在到哪了|做到哪了|当前状态|\/status)[？?。\s]*$/.test(text)) {
        return { ...turnControl(input, "answer", revision), resumeAfterAnswer: true };
    }
    if (/^(?:继续|执行|确认|确认执行(?:该修改)?|继续完整验收|继续验收|继续修复)[。！!\s]*$/.test(text)) {
        const intent = /验收/.test(text) ? "verify" : "execute";
        return { ...turnControl(input, intent, revision), resumeTask: true };
    }
    if (text.startsWith("【PLANNING")) {
        return turnControl(input, "plan", revision);
    }
    return undefined;
}

/** 用小型语义请求确定本轮动作，失败时不扩大执行范围 */
export async function classifyTurn(input: string, config: ModelConfig, task: DeliveryRecord | undefined,
    recent: string[], diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal, revision = 1): Promise<TurnControl> {
    const explicit = explicitControl(input, revision);
    if (explicit) {
        return explicit;
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout(executionPolicy().intentMs);
    const request = prepareModelRequest({
        systemPrompt: `仅分类最新用户消息，历史目标不是当前执行授权。只输出JSON：{"intent":"answer|inspect|plan|execute|verify|stop","scope":"none|startup|contract","resumeTask":false,"resumeAfterAnswer":false,"allowVerification":false}。
状态询问、能否启动、直接回答归answer，不运行工具。检查能否启动归inspect/startup；帮我启动归execute/startup。分析源码归inspect，设计方案归plan。开发修复归execute/contract，默认允许适用验收；修复后直接告诉我结果仍是execute。继续验收归verify。补充当前开发要求resumeTask=true，新目标false。普通进度询问resumeAfterAnswer=true，明确只回答或停止则false。明确不测试则allowVerification=false。`,
        messages: [{ role: "user", content: JSON.stringify({ input, task: task ? {
            goal: task.contract.originalInput.slice(0, 4000), status: task.status
        } : undefined, recent: recent.slice(-2).map(value => value.slice(0, 2000)) }), timestamp: 0 }]
    }, config.capabilities, "turn_intent", "off", 1024, {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeoutMs: executionPolicy().intentMs,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    try {
        const response = await streamSimple(request.model, request.context, request.options).result();
        finishRequestDiagnostics(request.diagnostics, response, started);
        signal?.throwIfAborted();
        timeout.throwIfAborted();
        if (response.stopReason !== "stop") {
            throw new Error("意图分类没有完成");
        }
        const value = parseModelObject(response.content.filter(block => block.type === "text").map(block => block.text).join("")).value;
        if (!isToolRecord(value) || !["answer", "inspect", "plan", "execute", "verify", "stop"].includes(String(value.intent)) ||
            !["none", "startup", "contract"].includes(String(value.scope)) || typeof value.resumeTask !== "boolean" ||
            typeof value.resumeAfterAnswer !== "boolean" || typeof value.allowVerification !== "boolean") {
            throw new Error("意图分类结构无效");
        }
        const control = turnControl(input, value.intent as TurnIntent, revision);
        control.scope = ["answer", "stop", "plan"].includes(control.intent) ? "none" : value.scope as TurnControl["scope"];
        control.resumeTask = value.resumeTask;
        control.resumeAfterAnswer = control.intent === "answer" && value.resumeAfterAnswer;
        control.allowVerification = ["execute", "verify"].includes(control.intent) && value.allowVerification;
        if (/(?:不要|别|停止|不用|先不)(?:再)?(?:测试|验收|验证|测)/.test(input)) {
            control.allowVerification = false;
            control.verificationProhibited = true;
        }
        return control;
    } catch (error) {
        signal?.throwIfAborted();
        request.diagnostics.failure = timeout.aborted ? "timeout" : "intent_failed";
        return { ...turnControl(input, "answer", revision), clarification: "本轮要求未能可靠识别。请明确是只需回答、检查启动，还是继续开发或验收；当前未启动新操作。" };
    } finally {
        request.diagnostics.durationMs = Date.now() - started;
        diagnostics(request.diagnostics);
    }
}

/** 按动作参数收缩工具范围，通用Shell不视为只读工具 */
export function controlToolRejection(control: TurnControl, name: string, args: Record<string, unknown>): string | undefined {
    if (["answer", "stop"].includes(control.intent)) {
        return "本轮只回答，禁止工具执行";
    }
    const readTools = ["list_files", "read_file", "read_image", "grep_search", "git_status", "git_diff", "recall_context", "current_time", "calculator", "read_skill_reference", "activate_skill"];
    if (readTools.includes(name)) {
        return undefined;
    }
    if (!control.allowVerification && control.scope !== "startup" && ["browser_action", "test_mail", "acceptance_checkpoint", "managed_process"].includes(name)) {
        return "本轮没有验收要求，不启动取证流程";
    }
    if (control.intent === "plan" || (control.intent === "inspect" && control.scope !== "startup")) {
        return "本轮只允许读取，不允许修改、启动服务或执行Shell";
    }
    if (control.scope === "startup") {
        return name === "managed_process" && ["port", "start", "ready", "logs", "stop"].includes(String(args.action))
            ? undefined : "本轮仅检查启动，不运行完整业务验收或修改源码";
    }
    if (control.intent === "verify" && ["write_file", "apply_patch", "execute_command"].includes(name)) {
        return "本轮仅验收，不允许修改源码或使用通用Shell";
    }
    return undefined;
}

/** 过滤宿主控制记录，避免内部安排被供应商当作用户消息 */
export function withoutRuntimeControl(messages: AgentMessage[]) {
    return messages.filter((message): message is Exclude<AgentMessage, RuntimeControlMessage> => message.role !== "runtime_control");
}

/** 每次请求重新注入当前边界，历史摘要和内部续跑不能覆盖 */
export function controlPrompt(control: TurnControl): string {
    return `\n【宿主维护的本轮边界】${JSON.stringify(control)}\n只完成本轮要求。项目未完成不代表用户要求继续开发。内部控制记录不是用户要求。startup仅启动并探活，不做注册、发信或完整业务验收。`;
}
