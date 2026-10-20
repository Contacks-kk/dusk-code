import * as fs from "node:fs/promises";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { message } from "../db/schema";
import { sessionService } from "../services/session.service";
import { projectService } from "../services/project.service";
import { permissionManager, type PermissionMode } from "../agent/runtime/permission-manager";
import { estimateHistoryTokens, estimateTokenCount } from "../agent/context/token";
import { colors, printFullAccessWarning, printHelpTable, formatPermissionBadge } from "./theme";
import { interactiveSelect, type SelectItem } from "./interactive-prompt";
import { modelConfigManager, type ReasoningEffort } from "../agent/runtime/model-config";
import { saveClipboardImage } from "../utils/clipboard";
import { extractImagePaths } from "../utils/image";
import { isMiMoModel, reasoningLabel } from "../agent/runtime/generation-policy";
import { turnInspector } from "./turn-inspector";
import { turnHistoryManager } from "./turn-history";

export class CommandHandler {
    /** 展示恢复会话上一轮的执行结果 */
    private async showExecutionStatus(sessionId: number): Promise<void> {
        const history = await sessionService.getSessionHistory(sessionId);
        const execution = history.at(-1)?.turn.executionJson;
        if (execution) console.log(`${colors.gray}上一轮状态: ${execution.status}，共 ${execution.attempts.length} 次尝试${colors.reset}\n`);
    }
    /** 显式执行当前会话历史压缩，释放 Token 并输出对比看板 */
    public async handleCompact(sessionId: number | undefined): Promise<void> {
        if (!sessionId) {
            console.log(`\n${colors.yellow}当前尚未创建会话，暂无可压缩的历史上下文。${colors.reset}\n`);
            return;
        }

        const rawHistory = await sessionService.getSessionHistory(sessionId);
        if (rawHistory.length === 0) {
            console.log(`\n${colors.yellow}当前会话暂无历史消息，无需压缩。${colors.reset}\n`);
            return;
        }

        const beforeTokens = estimateHistoryTokens(rawHistory);
        let modifiedCount = 0;

        // 对前序轮次中过长的大体积工具结果执行紧凑裁剪与持久化精简
        for (const item of rawHistory) {
            for (const msg of item.messages) {
                if (msg.role === "tool_result") {
                    const tokenCount = estimateTokenCount(msg.content);
                    if (tokenCount > 500) {
                        let compacted = msg.content;
                        try {
                            const parsed = JSON.parse(msg.content);
                            if (typeof parsed.result === "string" && parsed.result.length > 200) {
                                parsed.result = parsed.result.slice(0, 200) + "\n...[历史超长输出已紧凑压缩]...";
                                compacted = JSON.stringify(parsed);
                            } else if (typeof parsed.result === "object") {
                                const str = JSON.stringify(parsed.result);
                                if (str.length > 200) {
                                    parsed.result = { summary: str.slice(0, 200) + "...", compressed: true };
                                    compacted = JSON.stringify(parsed);
                                }
                            }
                        } catch {
                            compacted = msg.content.slice(0, 250) + "\n...[历史超长输出已紧凑压缩]...";
                        }

                        if (compacted !== msg.content) {
                            db.update(message).set({ content: compacted }).where(eq(message.id, msg.id)).run();
                            modifiedCount++;
                        }
                    }
                }
            }
        }

        const afterHistory = await sessionService.getSessionHistory(sessionId);
        const afterTokens = estimateHistoryTokens(afterHistory);
        const savedTokens = Math.max(0, beforeTokens - afterTokens);
        const savedPercent = beforeTokens > 0 ? Math.round((savedTokens / beforeTokens) * 100) : 0;

        console.log(`
${colors.green}${colors.bold}✔ 上下文显式压缩完成${colors.reset}
  ${colors.white}压缩前 Token:${colors.reset} ${colors.yellow}${beforeTokens}${colors.reset}
  ${colors.white}压缩后 Token:${colors.reset} ${colors.green}${afterTokens}${colors.reset}
  ${colors.white}释放 Token  :${colors.reset} ${colors.cyan}${savedTokens}${colors.reset} (${colors.bold}-${savedPercent}%${colors.reset})
  ${colors.gray}精简大报文数: ${modifiedCount} 条${colors.reset}
`);
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
            const targetEffort = (parts[1]?.toLowerCase() as ReasoningEffort) || "high";

            modelConfigManager.setModel(targetModel);
            if (["xhigh", "high", "medium", "low", "off"].includes(targetEffort)) {
                modelConfigManager.setReasoningEffort(targetEffort);
            }

            console.log(
                `\n${colors.green}✔ 模型配置已更新:${colors.reset} ${colors.bold}${targetModel}${colors.reset} (${colors.yellow}${reasoningLabel(targetModel, modelConfigManager.getModelConfig().reasoningEffort)}${colors.reset})\n`
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
        const effortOptions: SelectItem<ReasoningEffort>[] = isMiMoModel(selectedModel) ? [
            { label: "开启思考", value: "high", hint: "MiMo 使用开关模式，不区分 high/medium 等等级" },
            { label: "关闭思考", value: "off", hint: "优先生成正文与工具调用" }
        ] : [
            { label: "xhigh", value: "xhigh", hint: "极限深度思考，适合高难度复杂算法" },
            { label: "high", value: "high", hint: "深度思考，推荐代码架构与重构 (默认)" },
            { label: "medium", value: "medium", hint: "均衡思考，常规功能开发" },
            { label: "low", value: "low", hint: "轻量思考，快速响应" },
            { label: "off", value: "off", hint: "标准模式，不开启深度思考" }
        ];

        const selectedEffort = await interactiveSelect(effortOptions, `请选择思考设置 (当前: ${reasoningLabel(currentConfig.model, currentConfig.reasoningEffort)})`);
        if (!selectedEffort) {
            return;
        }

        modelConfigManager.setModel(selectedModel);
        modelConfigManager.setReasoningEffort(selectedEffort);

        console.log(
            `\n${colors.green}✔ 运行模型已切换为:${colors.reset} ${colors.bold}${selectedModel}${colors.reset} (${colors.yellow}${reasoningLabel(selectedModel, selectedEffort)}${colors.reset})\n`
        );
    }

    /** 开启全新独立会话 */
    public handleNew(): null {
        turnHistoryManager.reset();
        console.log(`\n${colors.green}✔ 已开启全新会话${colors.reset} ${colors.gray}(下一条消息将自动创建全新会话上下文)${colors.reset}\n`);
        return null;
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
}

export const commandHandler = new CommandHandler();
