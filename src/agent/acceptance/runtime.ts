import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { sourceMessage } from "../context/types";
import type { ModelConfig } from "../runtime/model-config";
import type { RequestDiagnostics } from "../runtime/model-adapter";
import type { RunStatus } from "../types";
import type { SkillRuntime } from "../skills/runtime";
import { supplementSkillCoverage } from "../skills/coverage";
import { artifactHash, EvidenceStore, projectSourceHash, projectInterfaceHash } from "./evidence";
import type { AcceptanceCheck, AcceptanceEvidence, DeliveryRecord, ReviewResult } from "./types";
import { AcceptanceProcesses } from "./processes";
import { AcceptanceMailbox } from "./mailbox";
import { AcceptanceBrowser } from "./browser";
import { reviewDelivery } from "./reviewer";
import { isAwaitingPlanConfirmation } from "../runtime/plan-intent";
import { executionPolicy, type TurnControl } from "../runtime/turn-control";

export interface AcceptanceRuntimeOptions {
    control?: TurnControl;
    onCheckpoint?: () => void;
    record: DeliveryRecord;
    config: ModelConfig;
    skills: SkillRuntime;
    authorized: boolean;
    turnId: number;
    turnNo: number;
    diagnostics: (value: RequestDiagnostics) => void;
    onStatus?: (text: string) => void;
    signal?: AbortSignal;
}

export class AcceptanceRuntime {
    readonly record: DeliveryRecord;
    readonly evidence: EvidenceStore;
    readonly processes: AcceptanceProcesses;
    readonly mailbox: AcceptanceMailbox;
    readonly browser: AcceptanceBrowser;
    readonly controller = new AbortController();
    private deadline?: ReturnType<typeof setTimeout>;
    private evidenceRequests = 0;
    private interfaceHash?: string;
    private environmentHash?: string;
    private initialSourceHash?: string;
    private budgetBegan?: number;
    private closed = false;
    private readonly startedProcesses = new Set<string>();

    /** 源码变化后回收旧隔离服务，避免旧缓存和旧服务混入新一轮结果 */
    async prepareEnvironment(): Promise<void> {
        const hash = await projectSourceHash(this.record.projectRoot);
        if (this.environmentHash && this.environmentHash !== hash) {
            await this.browser.close();
            await this.processes.close();
            this.mailbox.clear();
        }
        this.environmentHash = hash;
    }

    /** 记住开发前界面版本，已有界面不会让后端任务误触发视觉验收 */
    async initialize(): Promise<void> {
        this.signal.throwIfAborted();
        if (this.record.status === "not_required") {
            return;
        }
        this.interfaceHash = await projectInterfaceHash(this.record.projectRoot);
        this.initialSourceHash = await projectSourceHash(this.record.projectRoot);
        this.ensureVisualChecks();
    }

    /** 建立同一任务共享的验收状态和隔离资源 */
    constructor(private readonly options: AcceptanceRuntimeOptions) {
        this.record = options.record;
        this.evidence = new EvidenceStore(this.record);
        this.processes = new AcceptanceProcesses(path.join(this.evidence.directory, "processes"));
        this.mailbox = new AcceptanceMailbox(path.join(this.evidence.directory, "mail"));
        this.browser = new AcceptanceBrowser(this.evidence.directory, this.processes.origins, async origin => {
            const hash = await projectSourceHash(this.record.projectRoot);
            if (this.processes.originVersions.get(origin) !== hash) {
                throw new Error("服务源码版本已过期或未经登记，请停止旧进程并从当前源码重新启动隔离服务");
            }
        });
        if (!options.authorized && this.record.status !== "not_required") {
            this.record.status = "unverified";
            this.record.stoppedReason = "当前任务没有实施或运行验收授权";
        }
    }

    /** 返回与用户取消及验收时间上限绑定的信号 */
    get signal(): AbortSignal {
        return this.options.signal ? AbortSignal.any([this.options.signal, this.controller.signal]) : this.controller.signal;
    }

    /** 展示已经开始的验收预算，不把开发时间算入验收剩余时间 */
    get remainingBudgetMs(): number {
        return this.budgetBegan === undefined ? Infinity : Math.max(0,
            executionPolicy().verificationMs - (this.record.verificationElapsedMs ?? 0) - (Date.now() - this.budgetBegan));
    }

    /** 首次候选完成后才开始计算二十分钟验收预算 */
    private startBudget(): void {
        if (this.deadline) {
            return;
        }
        this.record.verificationStartedAt ??= Date.now();
        this.budgetBegan = Date.now();
        const remaining = Math.max(1, executionPolicy().verificationMs - (this.record.verificationElapsedMs ?? 0));
        this.deadline = setTimeout(() => {
            this.record.status = "unverified";
            this.record.stoppedReason = `自动验收及续修达到时间上限（${executionPolicy().verificationMs / 1000}秒）`;
            this.controller.abort();
        }, remaining);
        this.deadline.unref();
    }

    /** 提供独立于历史摘要的完整要求和当前缺口 */
    prompt(): string {
        if (this.record.status === "not_required") {
            return "";
        }
        if (this.options.control?.scope === "startup") {
            return "\n本轮只启动和检查服务就绪，使用 managed_process；不运行完整业务流程。汇报服务地址和实际就绪结果。隔离进程在本轮结束时回收，需明确说明。";
        }
        if (this.options.control && !this.options.control.allowVerification) {
            return "\n用户本轮没有要求验收。完成允许的实现或读取后直接汇报，明确保留未验证项，不启动验收工具和续修流程。";
        }
        if (this.record.planningError) {
            return `\n【验收准备降级】任务要求提取失败：${this.record.planningError}。
原始任务：${this.record.contract.originalInput}
继续用户已经授权的主任务开发；本轮不自动判定交付通过。当前没有可用的验收项编号，不必为了 checkId 查找或读取 Dusk 自身数据库、运行脚本和旧任务证据。
界面文件变更时仍补充适用设计技能。需要运行服务时使用隔离工具；业务项目与 Dusk 内部数据目录分别处理。`;
        }
        return `\n【任务验收约定，历史压缩不能改变】\n${JSON.stringify(this.record.contract)}
状态：${this.record.status}；已续修 ${this.record.repairRounds}/${executionPolicy().repairs}；停止原因：${this.record.stoppedReason ?? "无"}。
必须通过 managed_process 启动隔离服务和运行检查，使用 browser_action 实际填写、点击、断言业务响应并截图。
所有取证工具传入真实 checkId；不能自行修改验收状态。先 test_mail.start 获取本机 SMTP，再通过受管进程环境覆盖邮件配置。
使用独立端口、临时数据库和测试账号，不访问用户真实账号或发出真实邮件；不能直接调Controller或手工生成验证码冒充端到端。
managed_process 以 program+args 原生启动，cwd 指向目标工程；数据文件放在任务证据目录。浏览器仅访问本任务进程登记的端口。
browser_action 的 context 可分别命名不同账号；assert_response 必须比较 jsonPath 和 expected，HTTP200不等于成功；assert_layout 检查真实横向溢出，assert_text exact=true 可检查旧消息已经清空。
先在1440×900和390×844观察页面再截图；实际失败必须读取 network/console 及受管日志。完成后提出候选结果，由宿主独立验收。
源码变更后必须重新取证，缺失真实集成保留未验证，不能更改标准或跳过失败项。
单项流程完成后调用 acceptance_checkpoint 提交已完成的 checkIds，保留部分结果。
当前宿主安排（不是用户指令）：${this.record.continuations.filter(item => item.instructionRevision === this.options.control?.instructionRevision).at(-1)?.message.content ?? "完成本轮范围"}`;
    }

    /** 根据实际界面开发补齐视觉要求并补选专业技能 */
    async observeInterface(filePath: unknown): Promise<void> {
        if (typeof filePath !== "string" || !/\.(?:vue|tsx|jsx|svelte|html?|css|scss|less)$/i.test(filePath) || this.record.status === "not_required") {
            return;
        }
        const output = this.record.contract.outputs.includes("ui-page") ? "ui-page" : "ui-app";
        if (!this.record.contract.outputs.includes(output)) {
            this.record.contract.outputs.push(output);
            this.record.contract.version++;
            this.record.contract.changes.push({
                version: this.record.contract.version,
                reason: "检测到实际界面文件开发",
                timestamp: Date.now()
            });
        }
        this.ensureVisualChecks();
        this.options.skills.requireVisual(true);
        const selection = supplementSkillCoverage({
            skills: this.options.skills.record.snapshots.filter(item => item.status === "loaded")
                .map(item => ({ name: item.name, reason: item.reason })), needsVisualVerification: true
        },
            await this.options.skills.registry.getAll(), [output], this.options.skills.state.disabled, this.options.skills.state.pinned);
        for (const skill of selection.skills) {
            await this.options.skills.loadOptional(skill.name, "auto", skill.reason);
        }
    }

    /** 给界面产出保留桌面和手机的独立视觉验收项 */
    ensureVisualChecks(): void {
        if (this.options.control?.scope === "startup") {
            return;
        }
        if (this.record.status === "not_required" || !this.record.contract.outputs.some(output => output.startsWith("ui-"))) {
            return;
        }
        this.options.skills.requireVisual(true);
        for (const [id, width, height] of [["ui.desktop", 1440, 900], ["ui.mobile", 390, 844]] as const) {
            if (!this.record.contract.checks.some(check => check.id === id)) {
                this.record.contract.checks.push({
                    id,
                    title: `${width}px界面验收`,
                    preconditions: ["隔离服务已启动"],
                    steps: [`在${width}×${height}视口实际查看核心界面`],
                    expected: "布局可用、信息层级清楚、错误反馈可见且符合任务设计要求",
                    evidenceKinds: ["image"],
                    required: true,
                    realIntegration: false,
                    status: "pending",
                    evidenceIds: []
                });
            }
        }
    }

    /** 在验收阶段限制变更，防止通过改需求或越过隔离工具取得通过 */
    beforeTool(name: string): string | undefined {
        if (this.signal.aborted) {
            return "任务已取消或验收预算耗尽";
        }
        if (["managed_process", "browser_action", "test_mail"].includes(name) && (!this.options.authorized || this.record.status === "not_required")) {
            return "本轮没有开发验收授权或已明确关闭验收";
        }
        if ((this.record.status === "verifying" || this.record.verificationOnly) && ["write_file", "apply_patch", "execute_command"].includes(name)) {
            return "当前为隔离验收阶段，请使用受管工具取证；需要修改时提交失败证据后进入续修";
        }
        return undefined;
    }

    /** 检查文件和命令引起的界面变更，补齐技能与视觉要求 */
    async observeTool(name: string, args: Record<string, unknown>): Promise<void> {
        if (["write_file", "apply_patch"].includes(name) || (name === "read_file" && this.record.contract.outputs.some(output => output.startsWith("ui-")))) {
            await this.observeInterface(args.filePath);
        }
        if (["write_file", "apply_patch", "execute_command"].includes(name)) {
            const current = await projectInterfaceHash(this.record.projectRoot);
            if (this.interfaceHash && current !== this.interfaceHash) {
                await this.observeInterface("detected.vue");
            }
            this.interfaceHash = current;
        }
    }

    /** 核验每个证据的文件及源码版本，旧证据不能冒充本轮结果 */
    private async currentEvidence(): Promise<AcceptanceEvidence[]> {
        const hash = await projectSourceHash(this.record.projectRoot);
        this.record.sourceHash = hash;
        const evidence: AcceptanceEvidence[] = [];
        const snapshots = new Map<string, boolean>();
        for (const proof of this.record.evidence) {
            if (await this.evidence.valid(proof, hash, true, snapshots)) {
                evidence.push(proof);
            }
        }
        for (const check of this.record.contract.checks) {
            if (check.evidenceIds.length && !check.evidenceIds.every(id => evidence.some(proof => proof.id === id))) {
                check.status = "stale";
                check.feedback = "源码、约定或证据已变化，需要重新验证";
            }
        }
        return evidence;
    }

    /** 硬性检查证据种类和最新断言，模型评语不能覆盖失败 */
    private hardCheck(check: AcceptanceCheck, evidence: AcceptanceEvidence[]): string | undefined {
        const proofs = evidence.filter(proof => proof.checkId === check.id && proof.success);
        if (check.realIntegration && !proofs.some(proof => !proof.isolated)) {
            return "真实外部集成尚未验证，隔离替身不能证明该项通过";
        }
        const operations = new Map<string, AcceptanceEvidence>();
        for (const proof of evidence.filter(proof => proof.checkId === check.id && ["command", "browser_assert"].includes(proof.kind))) {
            operations.set(proof.operationKey ?? proof.kind, proof);
        }
        const failed = [...operations.values()].find(proof => !proof.success);
        if (failed) {
            return `程序断言仍未通过：${failed.summary}`;
        }
        if (check.evidenceKinds.some(kind => !proofs.some(proof => proof.kind === kind))) {
            return "缺少当前源码版本的必要证据";
        }
        if (check.id === "ui.desktop" || check.id === "ui.mobile") {
            const width = check.id === "ui.desktop" ? 1440 : 390;
            const latestImage = proofs.filter(proof => proof.kind === "image").at(-1);
            if (latestImage?.layoutPassed === false) {
                return "实际页面存在横向溢出，不能由模型评语覆盖该失败";
            }
            if (!proofs.some(proof => proof.kind === "image" && proof.summary.includes(`"width":${width}`))) {
                return `缺少${width}px视口的真实截图`;
            }
        }
        return undefined;
    }

    /** 合并独立评审与程序检查，不接受无证据的通过状态 */
    private applyReview(review: ReviewResult, evidence: AcceptanceEvidence[]): void {
        for (const check of this.record.contract.checks) {
            const judged = review.checks.find(item => item.id === check.id);
            if (!judged) {
                continue;
            }
            const hardFailure = this.hardCheck(check, evidence);
            if (!evidence.some(proof => proof.checkId === check.id)) {
                check.status = check.status === "stale" ? "stale" : check.realIntegration ? "blocked" : "pending";
                check.feedback = check.status === "stale" ? "源码、约定或证据已变化，需要重新验证" : hardFailure ?? "尚未执行";
                continue;
            }
            const citesFailure = judged?.evidenceIds.some(id => evidence.some(proof => proof.id === id && !proof.success));
            check.status = hardFailure ? check.realIntegration ? "blocked" : hardFailure.startsWith("缺少") ? "awaiting_review" : "failed" :
                judged.status === "passed" && judged.evidenceIds.length && !citesFailure ? "passed" : judged.status === "unknown" ? "awaiting_review" : "failed";
            check.feedback = hardFailure ?? judged?.reason ?? "独立评审未提供该项结论";
            check.evidenceIds = judged?.evidenceIds ?? [];
        }
    }

    /** 创建可独立回放的内部续修指令，不新增用户数据库消息 */
    private continuation(text: string, afterCall: { attemptNo: number; callNo: number }): AgentMessage {
        const id = randomUUID();
        const message = sourceMessage({
            role: "runtime_control" as const,
            content: text,
            instructionRevision: this.options.control?.instructionRevision ?? 1,
            timestamp: Date.now()
        },
            `t:${this.options.turnId}:delivery:${id}`, this.options.turnId, this.options.turnNo);
        message.contextSource.protected = true;
        this.record.continuations.push({
            id,
            message,
            instructionRevision: this.options.control?.instructionRevision ?? 1,
            afterCall
        });
        this.options.onStatus?.(text.split("\n")[0]);
        return message;
    }

    /** 评审当前候选结果，失败时只从现有状态继续，不重放整轮工具 */
    async candidate(afterCall: { attemptNo: number; callNo: number }, text = ""): Promise<AgentMessage | undefined> {
        if (this.options.control && (!this.options.control.allowVerification || this.options.control.scope !== "contract")) {
            return undefined;
        }
        if (!this.options.authorized || ["not_required", "passed", "blocked", "aborted"].includes(this.record.status)) {
            return undefined;
        }
        this.signal.throwIfAborted();
        if (!this.record.verificationOnly && !this.record.verificationStartedAt && isAwaitingPlanConfirmation(text) &&
            this.initialSourceHash === await projectSourceHash(this.record.projectRoot)) {
            this.record.awaitingPlan = true;
            this.record.stoppedReason = "方案待确认，尚未开始实施验收";
            return undefined;
        }
        if (this.record.planningError || this.record.status === "unverified") {
            return undefined;
        }
        this.startBudget();
        this.ensureVisualChecks();
        this.record.status = "verifying";
        this.options.onStatus?.("正在核对实际证据并进行独立验收，模型候选完成文案尚未交付。");
        const revision = this.options.control?.instructionRevision;
        const evidence = await this.currentEvidence();
        this.signal.throwIfAborted();
        if (revision !== this.options.control?.instructionRevision) {
            return undefined;
        }
        const missing = this.record.contract.checks.filter(check => check.required && !check.realIntegration && this.hardCheck(check, evidence));
        if (missing.length && this.evidenceRequests++ === 0) {
            return this.continuation(`开始实际验收，不能现在宣称交付。\n按约定使用隔离工具补齐：${JSON.stringify(missing)}\n只运行未执行及受影响流程，不重复已完成的副作用。`, afterCall);
        }
        try {
            const reviewed = await reviewDelivery(this.record, evidence, this.options.config, this.options.diagnostics, this.signal);
            this.signal.throwIfAborted();
            if (revision !== this.options.control?.instructionRevision) {
                return undefined;
            }
            const current = await this.currentEvidence();
            this.applyReview(reviewed.result, current);
            if (reviewed.imagesReceived && current.some(proof => proof.kind === "image" && proof.success)) {
                this.options.skills.record.visual = { status: "feedback_received", reason: "独立验收请求已实际接收截图并返回评审结论" };
            }
        } catch (error) {
            this.options.signal?.throwIfAborted();
            this.record.status = "unverified";
            if (!this.controller.signal.aborted) {
                this.record.stoppedReason = `独立验收未完成：${error instanceof Error ? error.message : String(error)}`;
            }
            return undefined;
        }
        return this.afterReview(afterCall);
    }

    /** 根据失败证据安排有界续修，关键集成缺口不能用额外重试掩盖 */
    private afterReview(afterCall: { attemptNo: number; callNo: number }): AgentMessage | undefined {
        const failures = this.record.contract.checks.filter(check => check.required && check.status !== "passed");
        if (!failures.length) {
            this.record.status = "passed";
            return undefined;
        }
        const fixable = failures.filter(check => check.status !== "blocked");
        const fingerprint = this.failureFingerprint(fixable);
        this.record.rounds.push({
            round: this.record.repairRounds,
            timestamp: Date.now(),
            failures: failures.map(check => check.id),
            fingerprint
        });
        const repeats = this.record.rounds.filter(round => round.round > 0).slice(-2).filter(round => round.fingerprint === fingerprint).length;
        if (!fixable.length || this.record.verificationOnly || this.record.repairRounds >= executionPolicy().repairs || repeats === 2) {
            this.record.status = "unverified";
            this.record.stoppedReason = !fixable.length ? "真实关键集成未验证" : this.record.verificationOnly ? "仅验收模式发现未通过项" : repeats === 2 ? "连续两轮相同问题未改善" : `已达到${executionPolicy().repairs}轮自动续修上限`;
            return undefined;
        }
        this.record.repairRounds++;
        this.record.status = "repairing";
        this.evidenceRequests = 0;
        const proofs = this.record.evidence.filter(proof => failures.some(check => check.id === proof.checkId)).slice(-20);
        return this.continuation(`验收未通过，开始第${this.record.repairRounds}/${executionPolicy().repairs}轮续修。\n${JSON.stringify(failures)}\n失败证据及源码快照：${JSON.stringify(proofs)}\n优先修复阻断项，读取相关证据、修改并重新运行失败及受影响流程。不得修改验收标准。`, afterCall);
    }

    /** 比较相同问题的最新实际结果，修复了部分断言也视为有进展 */
    private failureFingerprint(checks: AcceptanceCheck[]): string {
        const values = checks.map(check => {
            const latest = new Map<string, AcceptanceEvidence>();
            for (const proof of this.record.evidence.filter(proof => proof.checkId === check.id && proof.codeHash === this.record.sourceHash)) {
                latest.set(proof.operationKey ?? proof.kind, proof);
            }
            return {
                id: check.id,
                visual: check.evidenceKinds.includes("image") ? [...latest.values()].filter(proof => proof.kind === "image").map(proof => proof.imageHash) : undefined,
                failures: [...latest.entries()].filter(([, proof]) => !proof.success).map(([key, proof]) => ({ key, result: proof.resultDigest }))
                    .sort((left, right) => left.key.localeCompare(right.key))
            };
        });
        return artifactHash(JSON.stringify(values.sort((left, right) => left.id.localeCompare(right.id))));
    }

    /** 将执行结束与交付结论分别报告，未验收时不沿用模型的完成宣称 */
    finish(status: RunStatus, candidate: string): string {
        this.record.candidateReply = candidate;
        if (this.options.control?.scope === "startup") {
            return candidate;
        }
        if (this.options.control && !this.options.control.allowVerification && this.record.status !== "not_required") {
            this.record.status = "unverified";
            this.record.stoppedReason = "本轮未要求自动验收";
            return `${candidate}\n\n本轮未运行自动验收。`;
        }
        if (this.record.status === "not_required") {
            return candidate;
        }
        if (this.record.awaitingPlan && status === "completed") {
            this.record.status = "pending";
            this.record.finalReport = `尚未开始实施验收，方案待确认。\n\n${candidate}`;
            return this.record.finalReport;
        }
        if (this.options.signal?.aborted || (status === "aborted" && !this.controller.signal.aborted)) {
            this.record.status = "aborted";
            const reason = this.options.signal?.reason;
            this.record.stoppedReason = typeof reason === "string" ? reason : reason?.name === "TimeoutError" ?
                "单次运行达到时间上限" : "用户取消了本轮执行";
        } else if (this.record.status !== "passed") {
            this.record.status = this.record.status === "blocked" ? "blocked" : "unverified";
        }
        const passed = this.record.contract.checks.filter(check => check.status === "passed").length;
        const summary = `验收${this.record.status === "passed" ? "通过" : "未完成"}：${passed}/${this.record.contract.checks.length} 项通过，自动续修 ${this.record.repairRounds}/${executionPolicy().repairs} 轮。`;
        if (this.record.status === "passed") {
            this.record.finalReport = `${summary}\n\n${candidate}`;
            return this.record.finalReport;
        }
        const states = { pending: "尚未执行", running: "已开始，尚未完成", awaiting_review: "已执行并保留证据，等待评审", failed: "验证失败", blocked: "依赖阻塞", stale: "证据已过期", passed: "已通过" };
        const failures = this.record.contract.checks.filter(check => check.status !== "passed")
            .map(check => `- ${check.title}：${states[check.status]}${check.feedback ? `；${check.feedback}` : ""}`).join("\n");
        const completed = this.record.contract.checks.filter(check => check.status === "passed").map(check => check.title).join("、");
        this.record.finalReport = `${summary}\n${this.record.stoppedReason ?? "本轮未取得完整通过证据"}\n${completed ? `已通过：${completed}\n` : ""}\n${failures}\n\n证据目录：${this.evidence.directory}`;
        return this.record.finalReport;
    }

    /** 回收隔离资源，保留证据供后续继续验收 */
    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.deadline);
        if (this.budgetBegan) {
            this.record.verificationElapsedMs = (this.record.verificationElapsedMs ?? 0) + Date.now() - this.budgetBegan;
            this.budgetBegan = undefined;
        }
        const results = await Promise.allSettled([this.browser.close(), this.mailbox.close(), this.processes.close()]);
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (errors.length) {
            this.options.onStatus?.(`隔离资源回收未完成：${errors.map(result => String(result.reason)).join("；")}`);
        }
        for (const id of this.startedProcesses) {
            const latest = this.record.processFacts?.filter(fact => fact.id === id).at(-1);
            if (latest?.state !== "stopped") {
                this.record.processFacts?.push({ id, state: results[2].status === "fulfilled" ? "stopped" : "unknown",
                    observedAt: Date.now(), url: latest?.url });
            }
        }
        this.options.onCheckpoint?.();
    }

    /** 记录进程事实并在取证后立即标记待评审项 */
    recordResult(name: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
        if (name === "managed_process" && typeof result.id === "string" && ["start", "ready", "stop"].includes(String(args.action))) {
            const state = result.success === false ? "unknown" : args.action === "ready" ? "ready" : args.action === "stop" ? "stopped" : "started";
            const facts = this.record.processFacts ??= [];
            facts.push({ id: result.id, state, observedAt: Date.now(), url: typeof result.url === "string" ? result.url : undefined });
            if (args.action === "start") {
                this.startedProcesses.add(result.id);
            }
        }
        const check = this.record.contract.checks.find(item => item.id === args.checkId);
        if (check) {
            check.status = result.success === false ? "failed" : "awaiting_review";
            const latest = this.record.evidence.filter(item => item.checkId === check.id).at(-1);
            check.evidenceIds = this.record.evidence.filter(item => item.checkId === check.id && item.codeHash === latest?.codeHash &&
                item.contractVersion === this.record.contract.version).map(item => item.id);
        }
        this.options.onCheckpoint?.();
    }

    /** 首次实际取证时计时，并保存检查项已经开始执行的事实 */
    beginEvidence(checkId?: string): void {
        if (this.options.control?.scope !== "startup") {
            this.startBudget();
        }
        const check = this.record.contract.checks.find(item => item.id === checkId);
        if (check) {
            check.status = "running";
            this.options.onCheckpoint?.();
        }
    }

    /** 单项流程结束时批量评审，不重复执行业务操作 */
    async checkpoint(checkIds: string[]): Promise<Record<string, unknown>> {
        this.signal.throwIfAborted();
        if (!checkIds.length || checkIds.some(id => !this.record.contract.checks.some(check => check.id === id))) {
            throw new Error("提交了未登记的验收项");
        }
        this.startBudget();
        const revision = this.options.control?.instructionRevision;
        const evidence = (await this.currentEvidence()).filter(proof => checkIds.includes(proof.checkId));
        const scoped = structuredClone(this.record);
        scoped.contract.checks = scoped.contract.checks.filter(check => checkIds.includes(check.id));
        const reviewed = await reviewDelivery(scoped, evidence, this.options.config, this.options.diagnostics, this.signal);
        this.signal.throwIfAborted();
        if (revision !== this.options.control?.instructionRevision) {
            return { success: false, reason: "本轮要求已变化，旧评审不再推进执行" };
        }
        this.record.reviews = [...this.record.reviews ?? [], ...(scoped.reviews?.slice(this.record.reviews?.length ?? 0) ?? [])];
        this.applyReview(reviewed.result, await this.currentEvidence());
        if (reviewed.imagesReceived && evidence.some(proof => proof.kind === "image" && proof.success)) {
            this.options.skills.record.visual = { status: "feedback_received", reason: "单项评审已实际接收截图并返回结论" };
        }
        this.options.onCheckpoint?.();
        return { success: true, checks: this.record.contract.checks.filter(check => checkIds.includes(check.id)) };
    }
}
