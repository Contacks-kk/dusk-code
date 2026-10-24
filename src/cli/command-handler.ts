import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionService } from "../services/session.service";
import { projectService } from "../services/project.service";
import { permissionManager, type PermissionMode } from "../agent/runtime/permission-manager";
import { agentService } from "../services/agent.service";
import {
    colors,
    printFullAccessWarning,
    printHelpTable,
    formatPermissionBadge,
    formatToolHeader,
    formatToolBranchResult,
    renderAssistantReply,
    renderCrunchedSummary,
    printImageAttachmentBadge
} from "./theme";
import { interactiveSelect, type SelectItem } from "./interactive-prompt";
import { modelConfigManager, type ReasoningEffort } from "../agent/runtime/model-config";
import { saveClipboardImage } from "../utils/clipboard";
import { extractImagePaths } from "../utils/image";
import { supportedEfforts } from "../agent/runtime/model-profile";
import { turnInspector } from "./turn-inspector";
import { turnHistoryManager } from "./turn-history";
import { skillRegistry } from "../agent/skills/registry";
import { skillActivator } from "../agent/skills/activator";
import { changeSkillState, normalizeSkillState, hasSkillNotice } from "../agent/skills/state";
import type { SessionSkillState, SkillItem } from "../agent/skills/types";

type SkillAction = "pin" | "off" | "view";
type SkillChoice = { name: string; action: SkillAction };
type SkillCommand = { action: "clear" | "browse" } | { action: "pin" | "off"; name: string };

export class CommandHandler {
    /** 展示恢复会话上一轮的执行结果 */
    private async showExecutionStatus(sessionId: number): Promise<void> {
        const history = await sessionService.getSessionHistory(sessionId);
        const execution = history.at(-1)?.turn.executionJson;
        if (execution) {
            console.log(`${colors.gray}上一轮状态: ${execution.status}，共 ${execution.attempts.length} 次尝试${colors.reset}\n`);
            console.log(`验收状态：${execution.delivery?.status ?? "无验收记录"}${execution.delivery?.stoppedReason ? `；${execution.delivery.stoppedReason}` : ""}\n`);
        }
    }

    /** 将已恢复会话的全部历史轮次和工具执行记录渲染到当前终端中 */
    public async renderSessionHistory(sessionId: number): Promise<void> {
        // 清理当前内存中的轮次历史状态
        turnHistoryManager.reset();

        // 查询指定会话的完整轮次记录
        const history = await sessionService.getSessionHistory(sessionId);
        if (history.length === 0) {
            console.log(`\n${colors.gray}(当前会话暂无历史问答记录)${colors.reset}\n`);
            return;
        }

        console.log(`\n${colors.cyan}╭──────────────────────── 历史会话记录 (#${sessionId}) ────────────────────────╮${colors.reset}`);

        for (const item of history) {
            const turnNo = item.turn.turnNo;
            turnHistoryManager.recordTurnStart(turnNo);
            turnHistoryManager.recordExecution(turnNo, item.turn.executionJson);

            // 1. 提取并渲染用户提问内容与附加图片
            const userMsg = item.messages.find((m) => m.role === "user");
            if (userMsg) {
                let userText = userMsg.content;
                let attachedImages: string[] = [];

                if (userText.startsWith("{") && userText.endsWith("}")) {
                    try {
                        const parsed = JSON.parse(userText);
                        if (parsed && typeof parsed.text === "string") {
                            userText = parsed.text;
                            if (Array.isArray(parsed.imagePaths)) {
                                attachedImages = parsed.imagePaths;
                            }
                        }
                    } catch {
                        // 忽略解析错误
                    }
                }

                console.log(`\n${colors.cyan}● User [第 ${turnNo} 轮]${colors.reset}\n${userText}`);
                if (attachedImages.length > 0) {
                    printImageAttachmentBadge(attachedImages);
                }
            }

            // 2. 提取并渲染工具调用过程，并同步装配至 turnHistoryManager
            const toolCallMsgs = item.messages.filter((m) => m.role === "tool_call");
            const toolResultMsgs = item.messages.filter((m) => m.role === "tool_result");

            for (const tcMsg of toolCallMsgs) {
                try {
                    const parsedTc = JSON.parse(tcMsg.content);
                    const matchedRes = toolResultMsgs.find((trMsg) => {
                        try {
                            const parsedTr = JSON.parse(trMsg.content);
                            return parsedTr.id === parsedTc.id;
                        } catch {
                            return false;
                        }
                    });

                    let resVal: any = undefined;
                    let isError = false;
                    let durationMs: number | undefined;

                    if (matchedRes) {
                        try {
                            const parsedTr = JSON.parse(matchedRes.content);
                            resVal = parsedTr.result;
                            isError = !!parsedTr.isError;
                            durationMs = parsedTr.durationMs;
                        } catch {
                            // 忽略结果解析异常
                        }
                    }

                    // 记录工具调用到历史管理器
                    turnHistoryManager.recordToolCall(turnNo, {
                        id: parsedTc.id || "",
                        name: parsedTc.tool || "tool",
                        args: parsedTc.args || {}
                    });

                    if (matchedRes) {
                        turnHistoryManager.recordToolResult(
                            turnNo,
                            parsedTc.id || "",
                            resVal,
                            durationMs,
                            isError
                        );
                    }

                    console.log(`\n${formatToolHeader(parsedTc.tool || "tool", parsedTc.args)}`);
                    const branchLine = formatToolBranchResult(parsedTc.tool || "tool", resVal, durationMs, isError);
                    console.log(branchLine);
                } catch {
                    // 忽略无效工具 JSON
                }
            }

            // 3. 提取并渲染助手回复内容
            const assistantMsg = item.messages.find((m) => m.role === "assistant");
            if (assistantMsg) {
                renderAssistantReply(assistantMsg.content, item.turn.executionJson?.status);
            }
            const skillRecord = item.turn.executionJson?.skills;
            if (skillRecord && hasSkillNotice(skillRecord)) {
                console.log(`技能运行存在降级或未验收项：${skillRecord.selection.error ?? ""} ${skillRecord.visual.reason ?? ""}；/turn ${turnNo} 可查看完整记录。`);
            }

            // 4. 渲染耗时总结与标记轮次结束
            turnHistoryManager.finishTurn(turnNo);
            if (item.turn.executionJson?.totalDurationMs) {
                renderCrunchedSummary(item.turn.executionJson.totalDurationMs);
            }
        }

        console.log(`${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}\n`);
    }
    /** 显式压缩当前会话的模型视图，原始记录始终保留 */
    public async handleCompact(sessionId: number | undefined): Promise<void> {
        if (!sessionId) {
            console.log(`\n${colors.yellow}当前尚未创建会话，暂无可压缩的历史上下文。${colors.reset}\n`);
            return;
        }
        const result = await agentService.compact(sessionId, text => console.log(`${colors.gray}${text}${colors.reset}`));
        const saved = Math.max(0, result.beforeTokens - result.afterTokens);
        const summaries = result.context.events.filter(event => event.kind === "summary").length;
        const trims = result.context.events.filter(event => event.kind === "omission" || event.kind === "excerpt").length;
        console.log(`\n${colors.green}上下文处理完成${colors.reset}
  处理前估算: ${result.beforeTokens} token
  处理后估算: ${result.afterTokens} token
  释放空间  : ${saved} token
  摘要记录  : ${summaries}，裁剪记录: ${trims}
  原始历史保持完整，可通过 recall_context 定向回查。\n`);
    }

    /** 查看当前权限或使用交互式上下键菜单切换权限模式 */
    public async handlePermissions(arg?: string): Promise<void> {
        const trimmed = (arg || "").trim().toLowerCase();

        let targetMode: PermissionMode | undefined;

        if (!trimmed) {
            // 无参数时弹出上下键交互式选择菜单
            const options: SelectItem<PermissionMode>[] = [
                {
                    label: "Workspace",
                    value: "workspace",
                    hint: "默认受限模式，保护敏感凭证，越界脱离工作区需确认"
                },
                {
                    label: "Read Only",
                    value: "read-only",
                    hint: "只读模式，拦截全部文件修改与终端命令执行"
                },
                {
                    label: "Full Access",
                    value: "full-access",
                    hint: "全量授权模式，放行所有操作，有安全风险 ⚠️"
                }
            ];

            const selected = await interactiveSelect(options, "请选择权限模式");
            if (!selected) {
                return;
            }
            targetMode = selected;
        } else {
            if (trimmed === "read-only" || trimmed === "readonly" || trimmed === "ro") {
                targetMode = "read-only";
            } else if (trimmed === "workspace" || trimmed === "ws") {
                targetMode = "workspace";
            } else if (trimmed === "full-access" || trimmed === "fullaccess" || trimmed === "full") {
                targetMode = "full-access";
            }
        }

        if (!targetMode) {
            console.log(`\n${colors.red}未知权限模式 "${arg}"。可选模式: read-only | workspace | full-access${colors.reset}\n`);
            return;
        }

        const { warnRisk } = permissionManager.setMode(targetMode);
        console.log(`\n${colors.green}✔ 权限模式已更新为:${colors.reset} ${formatPermissionBadge(targetMode)}`);

        if (warnRisk) {
            printFullAccessWarning();
        } else {
            console.log("");
        }
    }

    /** 列出当前工程历史会话并通过交互式上下键直接恢复 */
    public async handleResume(arg: string | undefined, projectId: number): Promise<number | null> {
        const trimmed = (arg || "").trim();

        if (!trimmed) {
            const sessions = await projectService.listProjectSessions(projectId);
            if (sessions.length === 0) {
                console.log(`\n${colors.yellow}当前工程暂无历史会话记录。直接发送消息即可创建。${colors.reset}\n`);
                return null;
            }

            // 构造带上下键选择的历史会话菜单
            const options: SelectItem<number>[] = sessions.map((s) => ({
                label: `#${s.id} │ ${s.title || "未命名会话"}`,
                value: s.id,
                hint: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined
            }));

            const selectedSessionId = await interactiveSelect(options, "请选择要恢复的工程历史会话");
            if (selectedSessionId === null) {
                return null;
            }

            const found = sessions.find((s) => s.id === selectedSessionId);

            // 渲染恢复会话的历史记录至控制台
            await this.renderSessionHistory(selectedSessionId);

            console.log(`\n${colors.green}✔ 已恢复当前会话为 #${selectedSessionId} [${found?.title || "未命名会话"}]${colors.reset}\n`);
            await this.showExecutionStatus(selectedSessionId);
            return selectedSessionId;
        }

        const targetId = parseInt(trimmed, 10);
        if (isNaN(targetId)) {
            console.log(`\n${colors.red}无效的会话 ID "${trimmed}"，请输入有效数字编号。${colors.reset}\n`);
            return null;
        }

        const foundSession = await sessionService.getSessionById(targetId);
        if (!foundSession || (foundSession.projectId !== null && foundSession.projectId !== projectId)) {
            console.log(`\n${colors.red}未找到 ID 为 #${targetId} 的会话，或该会话归属于其他项目工程。${colors.reset}\n`);
            return null;
        }

        // 渲染恢复会话的历史记录至控制台
        await this.renderSessionHistory(foundSession.id);

        console.log(`\n${colors.green}✔ 已恢复当前会话为 #${foundSession.id} [${foundSession.title || "未命名会话"}]${colors.reset}\n`);
        await this.showExecutionStatus(foundSession.id);
        return foundSession.id;
    }

    /** 选择或切换模型与推理思考等级 */
    public async handleModel(arg?: string): Promise<void> {
        const trimmed = (arg || "").trim();

        if (trimmed) {
            const parts = trimmed.split(/\s+/);
            const targetModel = parts[0];
            const targetEffort = parts[1]?.toLowerCase();

            modelConfigManager.configureModel(targetModel, targetEffort);
            for (const warning of modelConfigManager.getModelConfig().capabilities.warnings) {
                console.log(`${colors.yellow}${warning}${colors.reset}`);
            }

            console.log(
                `\n${colors.green}✔ 模型配置已更新:${colors.reset} ${colors.bold}${targetModel}${colors.reset} (${colors.yellow}${modelConfigManager.getDisplayLabel().effort}${colors.reset})\n`
            );
            return;
        }

        // 阶段 1：选择模型
        const currentConfig = modelConfigManager.getModelConfig();
        const modelOptions: SelectItem<string>[] = [
            { label: "deepseek-chat", value: "deepseek-chat", hint: "DeepSeek V3 高性能对话模型" },
            { label: "deepseek-reasoner", value: "deepseek-reasoner", hint: "DeepSeek R1 深度思考推理模型" },
            { label: "gpt-4o", value: "gpt-4o", hint: "OpenAI 全能主力多模态模型" },
            { label: "gpt-4o-mini", value: "gpt-4o-mini", hint: "OpenAI 高速轻量模型" },
            { label: "gpt-5.1-sol", value: "gpt-5.1-sol", hint: "Codex 高级编程智能体模型" },
            { label: "claude-3-7-sonnet", value: "claude-3-7-sonnet", hint: "Anthropic 混合推理模型" },
            { label: "qwen-max", value: "qwen-max", hint: "通义千问旗舰级模型" }
        ];
        if (!modelOptions.some(option => option.value === currentConfig.model)) {
            modelOptions.unshift({ label: currentConfig.model, value: currentConfig.model, hint: "当前配置的模型" });
        }

        const selectedModel = await interactiveSelect(modelOptions, `请选择语言模型 (当前: ${currentConfig.model})`);
        if (!selectedModel) {
            return;
        }

        // 阶段 2：选择推理思考等级
        const profile = modelConfigManager.resolveModel(selectedModel);
        const efforts = profile.thinkingControl === "mimo" ? supportedEfforts(profile).filter(effort => effort === "off" || effort === "high") : supportedEfforts(profile);
        const effortOptions: SelectItem<ReasoningEffort>[] = efforts.map(effort => ({
            label: profile.thinkingControl === "mimo" ? (effort === "off" ? "关闭思考" : "开启思考") : effort,
            value: effort,
            hint: `${profile.thinkingLevelMap?.[effort] ? `实际映射为 ${profile.thinkingLevelMap[effort]}` : "当前模型支持的设置"}${profile.verified ? "" : "；适配未验证"}`
        }));
        const selectedEffort = await interactiveSelect(effortOptions, `请选择思考设置 (当前: ${modelConfigManager.getDisplayLabel().effort})`);

        if (!selectedEffort) {
            return;
        }

        modelConfigManager.configureModel(selectedModel, selectedEffort);
        for (const warning of modelConfigManager.getModelConfig().capabilities.warnings) {
            console.log(`${colors.yellow}${warning}${colors.reset}`);
        }

        console.log(
            `\n${colors.green}✔ 运行模型已切换为:${colors.reset} ${colors.bold}${selectedModel}${colors.reset} (${colors.yellow}${modelConfigManager.getDisplayLabel().effort}${colors.reset})\n`
        );
    }

    /** 开启全新独立会话并输出提示 */
    public handleNew(newSessionId?: number): void {
        turnHistoryManager.reset();
        const idLabel = newSessionId ? ` #${newSessionId}` : "";
        console.log(`\n${colors.green}✔ 已开启全新会话${idLabel}${colors.reset}\n`);
    }

    /** 处理 /image 视图指令，支持指定本地路径或自动抓取剪贴板截图 */
    public async handleImage(argText: string): Promise<{ prompt: string; imagePaths: string[] } | null> {
        let prompt = argText.trim();
        const imagePaths: string[] = [];

        // 1. 若提供了参数，先尝试从参数中提取本地文件路径
        if (prompt) {
            const extracted = extractImagePaths(prompt);
            for (const p of extracted.imagePaths) {
                const resolved = path.resolve(process.cwd(), p);
                try {
                    await fs.access(resolved);
                    imagePaths.push(resolved);
                } catch {
                    // 文件不存在则忽略
                }
            }
            prompt = extracted.cleanText;
        }

        // 2. 若未从参数中提取到任何图片，则自动尝试从操作系统剪贴板获取
        if (imagePaths.length === 0) {
            console.log(`${colors.gray}正在从系统剪贴板读取图片...${colors.reset}`);
            const clipboardPath = await saveClipboardImage();
            if (clipboardPath) {
                imagePaths.push(clipboardPath);
            } else {
                console.log(`\n${colors.yellow}未在剪贴板中检测到图片，且未指定有效的本地图片路径。${colors.reset}`);
                console.log(`${colors.gray}用法: /image [图片路径] [提问任务]，或先截图后直接输入 /image [提问任务]${colors.reset}\n`);
                return null;
            }
        }

        // 3. 若用户未附加任务文本，给出一个默认友好的提问文本
        if (!prompt) {
            prompt = "请详细分析并说明该图片中的内容。";
        }

        return { prompt, imagePaths };
    }

    /** 输出命令指南 */
    public handleHelp(): void {
        printHelpTable();
    }

    /** 展开指定轮次或最新轮次的完整思考、工具集合与响应详情 */
    public async handleTurn(arg?: string): Promise<void> {
        const turnNo = arg && /^\d+$/.test(arg.trim()) ? parseInt(arg.trim(), 10) : undefined;
        await turnInspector.open(turnNo);
    }

    /** 展示技能的实际来源、目录和会话设置 */
    private showSkill(skill: SkillItem, state: SessionSkillState): void {
        const key = skill.name.toLowerCase();
        const status = state.disabled.includes(key) ? "会话已关闭" : state.pinned.includes(key) ? "会话已固定，下轮加载正文" : "可用，尚未手动激活";
        console.log(`\n${colors.cyan}● ${skill.name} [${skill.source}] ${status}${colors.reset}`);
        console.log(`描述：${skill.description}\n根目录：${skill.skillDir}\n正文：${skill.skillMdPath}`);
        for (const reference of skill.references) {
            console.log(`参考资料：${reference.absolutePath}`);
        }
        for (const script of skill.scripts) {
            console.log(`脚本：${path.resolve(skill.skillDir, "scripts", script)}`);
        }
    }

    /** 查看、启用或关闭当前会话的技能 */
    public async handleSkill(arg: string | undefined, sessionId: number): Promise<void> {
        const current = await sessionService.getSessionById(sessionId);
        if (!current) {
            throw new Error("当前会话不存在");
        }
        const project = current.projectId ? await projectService.getProjectById(current.projectId) : undefined;
        await skillRegistry.reload(project?.rootPath ?? process.cwd());
        const state = normalizeSkillState(current.skillStateJson);
        const command = this.parseSkillCommand(arg);
        if (command.action === "clear") {
            await sessionService.saveSkillState(sessionId, changeSkillState(state, "clear"));
            console.log("\n已清除手动技能和禁用名单，当前会话恢复自动选择。\n");
            return;
        }
        if (command.action === "off") {
            await sessionService.saveSkillState(sessionId, changeSkillState(state, "off", command.name));
            console.log(`\n已关闭 ${command.name}，本会话不会自动重新选中。\n`);
            return;
        }
        const choice = command.action === "browse" ? await this.chooseSkill(state) : command;
        if (choice && "name" in choice) {
            await this.applySkillChoice(choice, state, sessionId);
        }
    }

    /** 解析技能命令，保留直接关闭和清空设置的既有语义 */
    private parseSkillCommand(arg?: string): SkillCommand {
        const input = arg?.trim() ?? "";
        if (input.toLowerCase() === "clear") {
            return { action: "clear" };
        }
        const off = /^off\s+(.+)$/i.exec(input);
        if (off) {
            return { action: "off", name: off[1] };
        }
        return input ? { action: "pin", name: input } : { action: "browse" };
    }

    /** 交互式选择技能及启用、关闭或查看操作 */
    private async chooseSkill(state: SessionSkillState): Promise<SkillChoice | undefined> {
        const skills = await skillRegistry.getAll();
        console.log(`\n会话固定：${state.pinned.join("、") || "无"}；会话关闭：${state.disabled.join("、") || "无"}。`);
        if (!skills.length) {
            console.log("未发现可用技能。仅扫描内置目录、用户 ~/.dusk/skills 和项目 .dusk/skills，下载到其他目录不会自动加载。\n");
            return undefined;
        }
        const items: SelectItem<string>[] = skills.map(skill => ({
            label: `${skill.name} [${skill.source}] ${state.pinned.includes(skill.name.toLowerCase()) ? "已固定" : state.disabled.includes(skill.name.toLowerCase()) ? "已关闭" : "自动"}`,
            value: skill.name,
            hint: skill.description.slice(0, 70)
        }));
        const name = await interactiveSelect(items, "选择技能");
        if (!name) {
            return undefined;
        }
        const action = await interactiveSelect<SkillAction>([
            { label: "启用并固定到当前会话", value: "pin" },
            { label: "关闭且禁止自动选择", value: "off" },
            { label: "仅查看来源和目录", value: "view" }
        ], "选择操作") ?? "view";
        return { name, action };
    }

    /** 执行技能查看或在校验通过后保存会话设置 */
    private async applySkillChoice(choice: SkillChoice, state: SessionSkillState, sessionId: number): Promise<void> {
        const skill = await skillRegistry.get(choice.name);
        if (!skill) {
            console.log(`\n未发现技能 ${choice.name}。输入 /skill 查看实际扫描到的技能。\n`);
            return;
        }
        if (choice.action === "view") {
            this.showSkill(skill, state);
            return;
        }
        if (choice.action === "pin" && !await this.canPinSkill(skill.name)) {
            return;
        }

        // 正文校验通过后才保存会话设置，新会话不会继承
        const next = changeSkillState(state, choice.action, skill.name);
        await sessionService.saveSkillState(sessionId, next);
        this.showSkill(skill, next);
        console.log(choice.action === "pin" ? "正文读取校验成功，后续轮次持续加载；/skill off <name> 可关闭。\n" : "本会话已关闭，自动选择将跳过该技能。\n");
    }

    /** 确认正文可读且非空，失败时保留原有会话设置 */
    private async canPinSkill(name: string): Promise<boolean> {
        const result = await skillActivator.activate(name);
        if (result.success === false || !result.content.trim()) {
            const error = result.success === false ? result.error : "技能正文为空";
            console.log(`\n激活失败：${error}；未改变会话设置。\n`);
            return false;
        }
        return true;
    }
}

export const commandHandler = new CommandHandler();
