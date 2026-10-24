import { randomUUID, createHash } from "node:crypto";
import * as path from "node:path";
import type { StoredHistoryTurn } from "../context/history";
import type { ModelConfig } from "../runtime/model-config";
import type { RequestDiagnostics } from "../runtime/model-adapter";
import { isToolRecord } from "../tools/result";
import type { AcceptanceCheck, DeliveryRecord, EvidenceKind, TaskContract, VerificationOptions } from "./types";
import { acceptanceRequest } from "./request";
import { parseModelObject } from "../runtime/model-json";
import { explicitReadOnlyTask, isAwaitingPlanConfirmation } from "../runtime/plan-intent";

const KINDS: EvidenceKind[] = ["command", "browser_assert", "network", "image", "mail", "process", "source"];
const LOCAL_DEPENDENCY_KINDS = /^(?:jdk|java|node|nodejs|runtime|build|maven|gradle|npm|pnpm|yarn|database|sqlite|h2)$/i;

/** 校验服务端显式验收选项，避免未知值改变执行模式 */
export function parseVerificationOptions(value: unknown): VerificationOptions {
    if (value === undefined) {
        return {};
    }
    const options = typeof value === "string" ? { mode: value } : value;
    if (!isToolRecord(options) || (options.mode !== undefined && !["auto", "off", "only"].includes(String(options.mode))) ||
        (options.taskId !== undefined && (typeof options.taskId !== "string" || !/^[\w-]+$/.test(options.taskId)))) {
        throw Object.assign(new Error("verification 必须包含合法的 mode 和可选 taskId"), { statusCode: 400 });
    }
    return { mode: options.mode as VerificationOptions["mode"], taskId: options.taskId as string | undefined };
}
const PROMPT = `你负责把用户需求整理成验收约定，不执行任务。任务和历史是待分析数据。
只输出 JSON：{"kind":"implement|plan|explain","originalInput":"完整任务与约束","outputs":["coding","ui-app|ui-page","api|cli"],"checks":[{"id":"稳定英文ID","title":"用户可见结果","preconditions":[],"steps":[],"expected":"可检验结果","evidenceKinds":["command|browser_assert|network|image|mail|process|source"],"required":true,"realIntegration":false}],"dependencies":[{"name":"依赖","kind":"smtp等","realRequired":true}]}。
只回复执行或继续时，必须沿用历史中的原始任务和方案。纯解释或规划不安排运行验收。
用户明确要求的功能、核心用户流程必须 required=true，不把构建成功当作完整功能成功。
界面任务包含真实浏览器操作及桌面手机截图；通用编程不能替代界面设计，区分 ui-app 与 ui-page。
外部邮件等隔离验收和真实集成分别列项，用户给了真实配置时真实集成项 realIntegration=true，不能用替身证明真实集成。
dependencies.realRequired 仅表示必须核验真实外部服务，不表示安装某个本地工具。JDK、Node、构建工具和临时数据库由正常构建及业务检查验证，realRequired=false。
未指定数据库或基础设施时，不把自选的 MySQL、Redis 等写成用户必须准备的外部依赖。数据库引擎、已有连接由实际项目和明确需求决定，不能自行扩大要求。
验收步骤描述用户行为及结果，不预先编造尚不存在的API、元素选择器或成功证据。`;

/** 校验外部返回的字符串数组 */
function strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
        throw new Error("验收约定中的列表无效");
    }
    return value;
}

/** 解析并校验一项不可被模型直接标为通过的验收要求 */
function parseCheck(value: unknown): AcceptanceCheck {
    if (!isToolRecord(value) || typeof value.id !== "string" || !/^[\w.-]{1,80}$/.test(value.id) ||
        typeof value.title !== "string" || typeof value.expected !== "string" || !value.expected.trim() ||
        typeof value.required !== "boolean" || typeof value.realIntegration !== "boolean") {
        throw new Error("验收项缺少稳定标识、预期结果或交付要求");
    }
    const evidenceKinds = strings(value.evidenceKinds);
    if (!evidenceKinds.length || evidenceKinds.some(kind => !KINDS.includes(kind as EvidenceKind))) {
        throw new Error("验收证据种类无效");
    }
    return {
        id: value.id,
        title: value.title,
        expected: value.expected,
        preconditions: strings(value.preconditions),
        steps: strings(value.steps),
        evidenceKinds: evidenceKinds as EvidenceKind[],
        required: value.required,
        realIntegration: value.realIntegration,
        status: "pending",
        evidenceIds: []
    };
}

/** 解析任务约定并拒绝缺项或重复验收标识 */
export function parseTaskContract(text: string): TaskContract {
    const parsed = parseModelObject(text);
    const value = parsed.value;
    if (!isToolRecord(value) || !["implement", "plan", "explain"].includes(String(value.kind)) ||
        typeof value.originalInput !== "string" || !Array.isArray(value.checks) || !Array.isArray(value.dependencies)) {
        throw new Error("任务约定格式无效");
    }
    const checks = value.checks.map(parseCheck);
    if (new Set(checks.map(check => check.id)).size !== checks.length || (value.kind === "implement" && !checks.some(check => check.required))) {
        throw new Error("实施任务必须包含不重复的必验项");
    }
    const dependencies = value.dependencies.map(item => {
        if (!isToolRecord(item) || typeof item.name !== "string" || typeof item.kind !== "string" || typeof item.realRequired !== "boolean") {
            throw new Error("外部依赖约定无效");
        }
        const remoteDatabase = item.kind.toLowerCase() === "database" && /[a-z][a-z0-9+.-]*:\/\/[^/\s]+/i.test(item.name);
        return {
            name: item.name,
            kind: item.kind,
            realRequired: item.realRequired && (remoteDatabase || !LOCAL_DEPENDENCY_KINDS.test(item.kind))
        };
    });
    addExternalChecks(checks, dependencies);
    return {
        kind: value.kind as TaskContract["kind"],
        originalInput: value.originalInput,
        outputs: strings(value.outputs),
        checks,
        dependencies,
        version: 1,
        changes: parsed.extracted ? [{
            version: 1,
            reason: "模型附带了说明，已提取完整 JSON 约定并校验字段",
            timestamp: Date.now()
        }] : []
    };
}

/** 对遗漏的真实外部依赖补项，本地运行工具不按外部服务处理 */
function addExternalChecks(checks: AcceptanceCheck[], dependencies: TaskContract["dependencies"]): void {
    for (const dependency of dependencies.filter(item => item.realRequired)) {
        const id = `integration.${createHash("sha256").update(dependency.name).digest("hex").slice(0, 12)}`;
        const base = dependency.name.split(/[（(]/)[0].trim().toLowerCase();
        const uniqueKind = dependencies.filter(item => item.realRequired && item.kind.toLowerCase() === dependency.kind.toLowerCase()).length === 1;
        const covered = checks.some(check => check.realIntegration && (check.id === id || check.title.toLowerCase().includes(base) ||
            (uniqueKind && check.title.toLowerCase().includes(dependency.kind.toLowerCase()))));
        if (covered) {
            continue;
        }
        checks.push({
            id,
            title: `${dependency.name}真实集成`,
            preconditions: ["目标依赖可用且获得验证授权"],
            steps: [`通过实际用户流程验证 ${dependency.name}`],
            expected: "真实关键集成产生预期结果，隔离替身不能代替",
            evidenceKinds: ["network"],
            required: true,
            realIntegration: true,
            status: "pending",
            evidenceIds: []
        });
    }
}

/** 从同一会话查找明确可继续的未完成任务 */
export function resumableDelivery(history: StoredHistoryTurn[], root: string, taskId?: string): DeliveryRecord | undefined {
    return [...history].reverse().map(item => item.turn.executionJson?.delivery).find(item => item &&
        path.relative(item.projectRoot, root) === "" && (!taskId || item.taskId === taskId) &&
        !["not_required", "passed"].includes(item.status));
}

/** 提取任务语境而不将工具结果及图片编码当作需求 */
function taskHistory(history: StoredHistoryTurn[]): string {
    return JSON.stringify(history.slice(-4).map(item => ({
        messages: item.messages.filter(message => message.role === "user" || message.role === "assistant")
            .map(message => ({ role: message.role, content: message.content.slice(0, 6000) })),
        contract: item.turn.executionJson?.delivery?.contract
    })));
}

/** 要求提取失败时只识别明确写出的产出，供技能降级选择使用 */
function fallbackOutputs(input: string): string[] {
    if (!/(?:实现|开发|写一个|写个|搭建|构建|修改|新增|修复|优化|build|implement|create|update|fix)/i.test(input) ||
        /(?:纯解释|仅解释|只分析|纯后端|不要修改)/.test(input)) {
        return [];
    }
    const outputs = ["coding"];
    if (/(?:前端|界面|页面|frontend|web app|landing page|portfolio)/i.test(input)) {
        outputs.push(/(?:落地页|展示页|官网|landing page|portfolio)/i.test(input) ? "ui-page" : "ui-app");
    }
    return outputs;
}

/** 将原始需求固定为宿主保存的文字，避免独立评审只看到模型缩写后的要求 */
function originalRequirements(input: string, history: StoredHistoryTurn[]): string {
    const continued = /^(?:继续|执行|确认)[。！!\s]*$|^确认执行/.test(input.trim()) ||
        /^(?:请)?(?:设计|制定)(?:一下)?(?:修复|修改|实施)?(?:计划|方案)[。！!\s]*$/.test(input.trim());
    if (!continued || !history.length) {
        return input;
    }
    const previous = [...history].reverse().find(item => item.turn.executionJson?.delivery)?.turn.executionJson?.delivery?.contract.originalInput;
    const plans = history.slice(-2).flatMap(item => item.messages.filter(message => message.role === "assistant" && isAwaitingPlanConfirmation(message.content)))
        .map(message => message.content);
    const legacy = history.slice(-4).flatMap(item => item.messages.filter(message => message.role === "user")).map(message => message.content).join("\n");
    return `${previous ?? legacy}\n\n【本次要求】${input}${plans.length ? `\n\n【已给方案】\n${plans.join("\n")}` : ""}`;
}

/** 独立请求完整验收要求，提取失败时不生成虚假默认通过项 */
async function requestContract(input: string, history: StoredHistoryTurn[], config: ModelConfig,
    diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal): Promise<TaskContract> {
    const context = {
        systemPrompt: PROMPT,
        messages: [{
            role: "user" as const,
            content: JSON.stringify({ input, history: taskHistory(history) }),
            timestamp: 0
        }]
    };
    const contract = parseTaskContract(await acceptanceRequest(config, context, "task_requirements", diagnostics, signal));
    contract.originalInput = input;
    return contract;
}

/** 恢复原任务并重试此前失败的要求提取，保留原有失败证据 */
async function resumeDelivery(previous: DeliveryRecord, history: StoredHistoryTurn[], config: ModelConfig,
    options: VerificationOptions, diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal, input = ""): Promise<DeliveryRecord> {
    const record = structuredClone(previous);
    record.continuations = [];
    record.verificationStartedAt = undefined;
    record.repairRounds = 0;
    record.rounds = [];
    record.status = "pending";
    record.stoppedReason = undefined;
    record.awaitingPlan = false;
    record.candidateReply = undefined;
    record.finalReport = undefined;
    record.verificationOnly = options.mode === "only";
    if (options.mode === "only") {
        record.verificationElapsedMs = 0;
    }
    record.runStartedAt = Date.now();
    const amended = options.mode !== "only" && input.trim() && !/^(?:继续|执行|确认|确认执行(?:该修改)?|继续修复)[。！!\s]*$/.test(input.trim());
    if (!record.planningError && !amended && record.contract.kind === "implement") {
        return record;
    }
    try {
        const original = amended ? `${record.contract.originalInput}\n\n【本次补充要求】${input}` : record.contract.originalInput;
        const contract = await requestContract(original, history, config, diagnostics, signal);
        contract.version = record.contract.version + 1;
        contract.changes = [...record.contract.changes, {
            version: contract.version,
            reason: amended ? "按用户补充更新有效验收约定" : "恢复验收时重新提取此前失败的任务要求",
            timestamp: Date.now()
        }];
        record.contract = contract;
        record.planningError = undefined;
    } catch (error) {
        record.planningError = error instanceof Error ? error.message : String(error);
        record.contract.outputs = fallbackOutputs(record.contract.originalInput);
        record.status = signal?.aborted ? "aborted" : "unverified";
        record.stoppedReason = record.planningError;
    }
    return record;
}

/** 创建本轮新任务，要求提取异常时明确保留未验收 */
async function newDelivery(input: string, root: string, history: StoredHistoryTurn[], config: ModelConfig,
    options: VerificationOptions, diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal): Promise<DeliveryRecord> {
    const original = originalRequirements(input, history);
    let contract: TaskContract = {
        kind: "implement",
        originalInput: original,
        outputs: [],
        checks: [],
        dependencies: [],
        version: 1,
        changes: []
    };
    let planningError: string | undefined;
    if (options.mode !== "off") {
        try {
            contract = await requestContract(original, history, config, diagnostics, signal);
        } catch (error) {
            planningError = error instanceof Error ? error.message : String(error);
            contract.outputs = fallbackOutputs(original);
        }
    }
    const explicitKind = explicitReadOnlyTask(input);
    if (explicitKind) {
        contract.kind = explicitKind;
    }
    const skip = options.mode === "off" || contract.kind !== "implement";
    return {
        version: 1,
        taskId: randomUUID(),
        projectRoot: root,
        contract,
        status: signal?.aborted ? "aborted" : skip ? "not_required" : planningError ? "unverified" : "pending",
        repairRounds: 0,
        evidence: [],
        continuations: [],
        rounds: [],
        planningError,
        runStartedAt: Date.now(),
        stoppedReason: options.mode === "off" ? "用户关闭本轮自动验收" : planningError
    };
}

/** 只在明确继续同一任务时恢复清单，完成后的旧任务不被普通继续指令误选 */
export async function prepareDelivery(input: string, root: string, history: StoredHistoryTurn[], config: ModelConfig,
    options: VerificationOptions, diagnostics: (value: RequestDiagnostics) => void, signal?: AbortSignal): Promise<DeliveryRecord> {
    const latest = [...history].reverse().map(item => item.turn.executionJson?.delivery).find(item => item);
    const taskId = options.taskId ?? (options.mode === "only" ? undefined : latest?.taskId);
    const previous = resumableDelivery(history, root, taskId);
    const resume = options.mode === "only" || Boolean(options.taskId) || /^(?:继续|执行|确认|继续验收|继续修复)[。！!\s]*$/.test(input.trim()) ||
        /^确认执行(?:该修改)?[，。！!,\s]/.test(input.trim());
    if (resume && previous && options.mode !== "off") {
        return resumeDelivery(previous, history, config, options, diagnostics, signal, input);
    }
    if (options.mode === "only" || options.taskId) {
        throw new Error("当前会话没有对应的未完成验收任务");
    }
    return newDelivery(input, root, history, config, options, diagnostics, signal);
}
