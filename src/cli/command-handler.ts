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

export class CommandHandler {
    /** 展示恢复会话上一轮的执行结果 */
    private async showExecutionStatus(sessionId: number): Promise<void> {
        const history = await sessionService.getSessionHistory(sessionId);
        const execution = history.at(-1)?.turn.executionJson;
        if (execution) {
            console.log(`${colors.gray}上一轮状态: ${execution.status}，共 ${execution.attempts.length} 次尝试${colors.reset}\n`);
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

    /** 交互式查看可用技能或激活指定专属技能 */
    public async handleSkill(arg?: string): Promise<void> {
        const skillName = arg?.trim();

        if (skillName) {
            // 根据用户传入的技能名直接查询
            const skill = await skillRegistry.get(skillName);

            if (!skill) {
                console.log(`\n${colors.yellow}未找到技能 "${skillName}"。输入 /skill 可查看所有可用技能列表。${colors.reset}\n`);
                return;
            }

            console.log(`\n${colors.cyan}${colors.bold}● 专属技能: ${skill.name}${colors.reset} [来源: ${skill.source}]`);
            console.log(`${colors.gray}描述: ${skill.description}${colors.reset}`);
            console.log(`${colors.gray}路径: ${skill.path}${colors.reset}`);

            if (skill.references.length > 0) {
                console.log(`${colors.gray}配套参考文档:${colors.reset}`);
                for (const ref of skill.references) {
                    console.log(`  - ${ref.name}`);
                }
            }

            console.log(`\n${colors.green}✔ 提示：该技能已装配在 Code Agent 提示词索引中，Agent 在相关任务中会自动调用 activate_skill。${colors.reset}\n`);
            return;
        }

        // 获取全部已注册技能
        const skills = await skillRegistry.getAll();

        if (skills.length === 0) {
            console.log(`\n${colors.yellow}当前未加载到任何可用技能。请检查 skills/ 或 .dusk/skills/ 目录。${colors.reset}\n`);
            return;
        }

        // 构建交互式选择菜单项
        const items: SelectItem<string>[] = skills.map((s) => {
            return {
                label: `${s.name} [${s.source}]`,
                value: s.name,
                hint: s.description.length > 40 ? s.description.slice(0, 37) + "..." : s.description
            };
        });

        // 交互式上下键选择技能
        const selectedName = await interactiveSelect(items, "请选择要查看或激活的专属技能");

        if (!selectedName) {
            return;
        }

        // 获取选中的技能并展示其元数据与参考资料
        const selectedSkill = await skillRegistry.get(selectedName);

        if (!selectedSkill) {
            return;
        }

        console.log(`\n${colors.cyan}${colors.bold}● 专属技能: ${selectedSkill.name}${colors.reset} [来源: ${selectedSkill.source}]`);
        console.log(`${colors.gray}描述: ${selectedSkill.description}${colors.reset}`);
        console.log(`${colors.gray}路径: ${selectedSkill.path}${colors.reset}`);

        if (selectedSkill.references.length > 0) {
            console.log(`${colors.gray}配套参考文档:${colors.reset}`);
            for (const ref of selectedSkill.references) {
                console.log(`  - ${ref.name}`);
            }
        }

        console.log(`\n${colors.green}✔ 提示：该技能已装配在 Code Agent 提示词索引中，Agent 在相关任务中会自动调用 activate_skill。${colors.reset}\n`);
    }
}

export const commandHandler = new CommandHandler();
