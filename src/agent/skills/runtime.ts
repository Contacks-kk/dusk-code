import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SkillActivator } from "./activator";
import type { SkillRegistry } from "./registry";
import { normalizeSkillState, skillWarnings } from "./state";
import { readToolDetails, toolText, isManagedToolFailure } from "../tools/result";
import type { SessionSkillState, SkillActivationSuccess, SkillEvent, SkillExecutionRecord, SkillSnapshot } from "./types";

export class SkillRuntime {
    readonly state: SessionSkillState;
    readonly record: SkillExecutionRecord;
    private readonly activator: SkillActivator;
    private revision = 0;
    private imageRevisions = new Map<string, number>();
    private requestRevisions = new Map<string, number>();

    /** 建立独立于其他会话的技能快照与使用记录 */
    constructor(readonly registry: SkillRegistry, state: unknown, private readonly onStatus?: (text: string) => void) {
        this.state = normalizeSkillState(state);
        this.activator = new SkillActivator(registry);
        this.record = {
            selection: { status: "skipped", skills: [] },
            disabled: this.state.disabled,
            snapshots: [],
            failures: [],
            events: [],
            needsVisualVerification: false,
            visual: { status: "not_required" }
        };
    }

    /** 加载技能一次并固定本轮正文和目录 */
    async load(name: string, origin: SkillSnapshot["origin"], reason: string): Promise<SkillSnapshot> {
        const key = name.trim().toLowerCase();
        if (this.state.disabled.includes(key)) {
            throw new Error(`技能 ${name} 已被当前会话关闭`);
        }
        const existing = this.record.snapshots.find(item => item.name.toLowerCase() === key);
        if (existing) {
            if (existing.status !== "loaded") {
                throw new Error(`技能 ${name} 本轮因上下文预算不足未加载`);
            }
            return existing;
        }
        const result = await this.activator.activate(name);
        if (result.success === false || !result.content.trim()) {
            const error = result.success === false ? result.error : "技能正文为空";
            this.record.failures.push({ name, error });
            this.onStatus?.(`技能 ${name} 加载失败：${error}；继续使用其他成功加载的技能。`);
            throw new Error(error);
        }
        const snapshot = this.buildSnapshot(result, origin, reason);
        snapshot.missingDependencies = await this.findMissingDependencies(result.content);
        this.record.snapshots.push(snapshot);
        this.event({
            kind: "loaded",
            success: true,
            name: snapshot.name,
            path: snapshot.skillMdPath,
            detail: origin
        });
        this.onStatus?.(`技能已加载：${snapshot.name} [${snapshot.source}] ${snapshot.skillDir}`);
        if (snapshot.missingDependencies.length) {
            this.onStatus?.(`技能 ${snapshot.name} 引用的技能未安装：${snapshot.missingDependencies.join("、")}；保留当前正文并继续可完成的步骤。`);
        }
        return snapshot;
    }

    /** 加载可降级的技能，保证失败有记录且不会重复记录 */
    async loadOptional(name: string, origin: SkillSnapshot["origin"], reason: string): Promise<boolean> {
        const failureCount = this.record.failures.length;
        try {
            await this.load(name, origin, reason);
            return true;
        } catch (error) {
            if (this.record.failures.length === failureCount) {
                const message = error instanceof Error ? error.message : String(error);
                this.record.failures.push({ name, error: message });
                this.onStatus?.(`技能 ${name} 加载失败：${message}；继续使用其他成功加载的技能。`);
            }
            return false;
        }
    }

    /** 构建本轮固定使用的正文与资源快照 */
    private buildSnapshot(result: SkillActivationSuccess, origin: SkillSnapshot["origin"], reason: string): SkillSnapshot {
        return {
            name: result.name,
            description: result.description,
            origin,
            reason,
            source: result.source,
            skillDir: result.skillDir,
            skillMdPath: result.skillMdPath,
            content: result.content,
            hash: createHash("sha256").update(result.content).digest("hex"),
            references: result.references.map(item => ({
                name: item.name,
                path: item.path,
                absolutePath: path.resolve(result.skillDir, item.path)
            })),
            scripts: result.scripts,
            status: "loaded"
        };
    }

    /** 识别明确引用但尚未安装的技能 */
    private async findMissingDependencies(content: string): Promise<string[]> {
        const calls = content.matchAll(/\b(?:use|invoke)\s+(?:the\s+)?(?:([a-z0-9_-]+:[a-z0-9_-]+)|([a-z0-9_-]+)\s+skill\b)|(?:调用|使用)技能\s*[`"' ]*([a-z0-9_:-]+)/gi);
        const missing = new Set<string>();
        for (const call of calls) {
            const dependency = call[1] || call[2] || call[3];
            if (!dependency) {
                continue;
            }
            const shortName = dependency.split(":").at(-1) ?? dependency;
            if (!await this.registry.get(dependency) && !await this.registry.get(shortName)) {
                missing.add(dependency);
            }
        }
        return [...missing];
    }

    /** 记录技能相关操作而不伪造工具调用 */
    private event(event: Omit<SkillEvent, "timestamp">): void {
        this.record.events.push({ ...event, timestamp: Date.now() });
    }

    /** 读取本轮已加载技能的参考资料并保留来源 */
    async readReference(name: string, referenceName: string, toolCallId: string): Promise<string> {
        const snapshot = this.record.snapshots.find(item => item.name.toLowerCase() === name.trim().toLowerCase() && item.status === "loaded");
        if (!snapshot) {
            throw new Error(`请先激活技能 ${name}`);
        }
        const reference = snapshot.references.find(item => item.name.toLowerCase() === referenceName.toLowerCase() || item.path === referenceName);
        if (!reference) {
            throw new Error(`技能 ${name} 未登记参考资料 ${referenceName}`);
        }
        try {
            const content = await fs.readFile(reference.absolutePath, "utf8");
            this.event({ kind: "reference", success: true, name: snapshot.name, path: reference.absolutePath, toolCallId });
            return content;
        } catch (error) {
            this.event({ kind: "reference", success: false, name: snapshot.name, path: reference.absolutePath, toolCallId, detail: String(error) });
            throw error;
        }
    }

    /** 设置当前任务的视觉验收要求 */
    requireVisual(required: boolean): void {
        if (required && !this.record.needsVisualVerification) {
            this.record.needsVisualVerification = true;
            this.record.visual = { status: "pending" };
        }
    }

    /** 生成每次请求都保留的完整技能指令 */
    prompt(): string {
        const loaded = this.record.snapshots.filter(item => item.status === "loaded");
        const failures = this.record.failures.map(item => `${item.name}: ${item.error}`);
        const excluded = this.record.snapshots.filter(item => item.status !== "loaded").map(item => item.name);
        return `\n【当前技能状态，以本段为准；历史激活回执不代表仍启用】
用户要求和权限规则优先于技能；技能互补，不能用通用流程替代专业产出的技能。禁用：${JSON.stringify(this.state.disabled)}。
已加载：${JSON.stringify(loaded.map(item => item.name))}；未加载：${JSON.stringify([...failures, ...excluded])}。
技能提及其他技能时，只能使用可用目录中的名称；缺失时报告缺口并继续可完成的步骤，不得声称已加载。
脚本使用下列绝对路径，cwd 使用目标项目目录；<skill> 表示对应技能根目录。参考资料按任务读取。
${this.record.needsVisualVerification ? "本任务需要视觉反馈：运行界面，生成截图并用 read_image 读取，依据图片检查并修正；未完成时必须明确说明视觉未验收。" : "本轮未要求视觉验收。"}
${this.record.visual.reason ? `视觉状态：${this.record.visual.reason}` : ""}
${loaded.map(item => this.renderSkill(item)).join("\n")}`;
    }

    /** 渲染单个技能的完整正文与绝对资源路径 */
    private renderSkill(item: SkillSnapshot): string {
        return `\n<active_skill name=${JSON.stringify(item.name)}>
来源：${item.source}；根目录：${item.skillDir}；正文：${item.skillMdPath}；SHA256：${item.hash}
参考资料：${JSON.stringify(item.references)}
脚本：${JSON.stringify(item.scripts)}
未安装的引用技能：${JSON.stringify(item.missingDependencies ?? [])}
${item.content}
</active_skill>`;
    }

    /** 按手动优先和选择顺序移除最低优先级的完整技能 */
    excludeForBudget(): boolean {
        const loaded = this.record.snapshots.filter(item => item.status === "loaded");
        const target = loaded.filter(item => item.origin !== "manual").at(-1) ?? loaded.at(-1);
        if (!target) {
            return false;
        }
        target.status = "budget_excluded";
        this.event({
            kind: "budget",
            success: false,
            name: target.name,
            detail: "上下文预算不足，整份正文未加载"
        });
        this.onStatus?.(`技能降级：${target.name} 因上下文预算不足未加载，继续使用其余技能。`);
        return true;
    }

    /** 保存真实命令、截图读取和项目变更的证据 */
    observeTool(name: string, args: Record<string, unknown>, result: unknown, toolCallId: string, isError: boolean): void {
        const details = readToolDetails(result);
        const success = !isError && !details?.error;
        if (["write_file", "apply_patch", "edit_code", "execute_command"].includes(name)) {
            this.observeChange(name, toolCallId, success);
        }
        if (name === "execute_command") {
            this.observeCommand(args, result, toolCallId, success);
        }
        if (name === "read_image") {
            this.observeImage(args, result, toolCallId, success);
        }
    }

    /** 项目操作后使已有视觉反馈失效 */
    private observeChange(name: string, toolCallId: string, success: boolean): void {
        this.revision++;
        if (this.record.needsVisualVerification) {
            this.record.visual = { status: "pending", reason: "项目操作后需要读取最新截图" };
        }
        this.event({
            kind: "change",
            success,
            toolCallId,
            detail: name
        });
    }

    /** 保存命令的真实退出状态与输出详情 */
    private observeCommand(args: Record<string, unknown>, result: unknown, toolCallId: string, success: boolean): void {
        const details = readToolDetails(result);
        this.event({
            kind: "command",
            success: success && details?.exitCode === 0 && !isManagedToolFailure("execute_command", result),
            toolCallId,
            path: toolText(args.cwd),
            detail: JSON.stringify({ command: args.command, ...details })
        });
    }

    /** 保存图片读取证据并等待模型反馈 */
    private observeImage(args: Record<string, unknown>, result: unknown, toolCallId: string, success: boolean): void {
        const details = readToolDetails(result);
        const error = toolText(details?.error);
        this.record.needsVisualVerification = true;
        this.record.visual = {
            status: success ? "pending" : "incomplete",
            reason: success ? "已读取截图，等待模型实际接收并反馈" : error || "图片读取失败"
        };
        this.event({
            kind: "image",
            success,
            toolCallId,
            path: toolText(details?.filePath ?? args.filePath),
            detail: error
        });
        if (success) {
            this.imageRevisions.set(toolCallId, this.revision);
        }
    }

    /** 记录实际送入请求的本轮截图而非仅凭文件存在判断 */
    observeRequest(messages: AgentMessage[], callKey: string): void {
        for (const message of messages) {
            if (message.role !== "toolResult" || message.toolName !== "read_image" ||
                !message.content.some(block => block.type === "image") || this.imageRevisions.get(message.toolCallId) !== this.revision) {
                continue;
            }
            this.requestRevisions.set(callKey, this.revision);
            this.event({ kind: "image_request", success: true, toolCallId: message.toolCallId, callKey });
        }
    }

    /** 记录模型确实接收截图并返回正文的反馈证据 */
    observeResponse(response: AssistantMessage, callKey: string): void {
        if (this.requestRevisions.get(callKey) === this.revision && ["stop", "toolUse"].includes(response.stopReason) &&
            response.content.some(block => block.type === "text" && block.text.trim())) {
            this.record.visual = { status: "feedback_received", reason: "模型已接收最新截图并返回正文，验收结论需结合该响应核对" };
        }
    }

    /** 记录供应商拒收图片并明确视觉尚未验收 */
    imageFailure(reason: string): void {
        this.requestRevisions.clear();
        this.record.visual = { status: "incomplete", reason };
        this.event({ kind: "image_failure", success: false, detail: reason });
        this.onStatus?.(`视觉反馈降级：${reason}；继续文字任务，视觉未验收。`);
    }

    /** 汇总本轮降级和视觉缺口供最终结果展示 */
    finish(): string {
        if (this.record.needsVisualVerification && this.record.visual.status !== "feedback_received") {
            this.record.visual.status = "incomplete";
            this.record.visual.reason ??= "未取得最新截图的模型反馈";
        }
        const warnings = skillWarnings(this.record);
        return warnings.length ? `\n\n运行说明：${warnings.join("；")}。` : "";
    }
}
