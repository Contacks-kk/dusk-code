import * as fs from "node:fs/promises";
import { agentService } from "./services/agent.service";
import { projectService } from "./services/project.service";
import { sessionService } from "./services/session.service";
import { permissionManager } from "./agent/runtime/permission-manager";
import { modelConfigManager } from "./agent/runtime/model-config";
import { commandHandler } from "./cli/command-handler";
import { colors, printHeaderBanner, renderLiveStep, renderAssistantReply, renderCrunchedSummary, printImageAttachmentBadge } from "./cli/theme";
import { interactivePrompt, interactiveSelect } from "./cli/interactive-prompt";
import { extractImagePaths } from "./utils/image";
import { mouseTracker } from "./cli/mouse-tracker";
import { liveInputManager } from "./cli/live-input";
import { isPlanConfirmationPrompt, promptPlanConfirmation } from "./cli/plan-confirmation";
import type { AgentRunResult } from "./agent/types";

/** 检测异常是否为 Ctrl+C 中断引发的取消错误 */
function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    const e = err as { name?: string; code?: string; message?: string };
    return (
        e.name === "AbortError" ||
        e.code === "ABORT_ERR" ||
        (typeof e.message === "string" && e.message.includes("Ctrl+C"))
    );
}

/** 启动现代化交互式终端 CLI */
async function startCli(): Promise<void> {
    let currentSessionId: number | undefined;
    let activeController: AbortController | undefined;
    let exitRequested = false;

    /** 取消活动任务，保存最终执行状态后退出 */
    const onSigInt = () => {
        if (exitRequested) return;
        exitRequested = true;
        console.log(`\n${colors.gray}检测到中断信号，正在安全退出...${colors.reset}`);
        if (activeController) activeController.abort();
        else process.exit(0);
    };
    process.on("SIGINT", onSigInt);
    /** 接入共享键盘与思考详情，主界面保留原生终端滚动 */
    mouseTracker.enable();

    // 1. 初始化并绑定当前工程上下文
    const currentProject = await projectService.getOrCreateProject(process.cwd());

    // 默认创建当前工程下的全新会话
    const initialSession = await sessionService.createSession("新对话", currentProject.id);
    currentSessionId = initialSession.id;

    // 2. 打印品牌 Banner 与工程看板
    const initialModelCfg = modelConfigManager.getModelConfig();
    printHeaderBanner({
        projectName: currentProject.name,
        projectPath: currentProject.rootPath,
        sessionId: currentSessionId,
        permissionMode: permissionManager.getMode(),
        modelName: initialModelCfg.model,
        reasoningEffort: initialModelCfg.reasoningEffort,
        reasoningDisplay: modelConfigManager.getDisplayLabel().effort
    });
    for (const warning of initialModelCfg.capabilities.warnings) {
        console.log(`${colors.yellow}${warning}${colors.reset}`);
    }

    /** 越界或高危操作通过交互式上下键进行提权确认 */
    const askUserPermission = async (promptText: string): Promise<boolean> => {
        const cleanPrompt = promptText.replace(/\x1b\[[0-9;]*m/g, "").replace(/\(y\/N\):.*/, "").trim();
        const confirmed = await interactiveSelect(
            [
                { label: "拒绝 (推荐：安全拦截越界操作)", value: false },
                { label: "允许 (授权 Agent 访问工作区外部路径)", value: true }
            ],
            cleanPrompt || "越界沙箱操作授权确认"
        );
        return confirmed === true;
    };

    /** 为所有 CLI 对话入口绑定统一取消控制器并开放执行态输入框 */
    const chat = async (prompt: string, imagePaths?: string[]) => {
        activeController = new AbortController();

        // 开放执行期输入框供用户键入
        liveInputManager.start();

        try {
            // 调用 AgentService 执行对话链路
            return await agentService.chat(currentSessionId, prompt, {
                projectId: currentProject.id,
                imagePaths,
                signal: activeController.signal,
                onStep: renderLiveStep,
                onAskPermission: askUserPermission
            });
        } finally {
            // 关闭执行期输入框并清理状态
            liveInputManager.stop();
            activeController = undefined;
        }
    };

    /** 统一渲染每轮 Assistant 结果、耗时结算并处理方案确认弹窗流转 */
    const handleTurnCompletion = async (
        result: AgentRunResult,
        turnDurationMs: number,
        isExplicitPlan = false
    ): Promise<void> => {
        currentSessionId = result.sessionId;

        // 1. 渲染最终回复（原生 Markdown 终端美化）
        renderAssistantReply(result.reply, result.status);

        // 2. 结算全链路耗时
        renderCrunchedSummary(turnDurationMs);

        // 3. 检查是否为 Agent 制定的方案并等待用户确认
        if (isPlanConfirmationPrompt(result.reply, isExplicitPlan)) {
            const confirmation = await promptPlanConfirmation();
            if (confirmation.action === "confirm") {
                const followUpPrompt = "确认执行该修改，请立即调用相关工具落地方案。";
                const followUpStart = Date.now();
                const followUpResult = await chat(followUpPrompt);
                const followUpDuration = Date.now() - followUpStart;

                // 递归流转执行后续阶段
                await handleTurnCompletion(followUpResult, followUpDuration, false);
            } else if (confirmation.action === "supplement" && confirmation.supplementText) {
                const followUpStart = Date.now();
                const followUpResult = await chat(confirmation.supplementText);
                const followUpDuration = Date.now() - followUpStart;

                // 递归流转执行补充方案
                await handleTurnCompletion(followUpResult, followUpDuration, false);
            }
        }
    };

    try {
        while (!exitRequested) {
            const currentModelCfg = modelConfigManager.getModelConfig();

            // 调用 Codex CLI 风格输入器（暗色背景输入条 + 状态行 + 精确中文光标）
            const userInput = await interactivePrompt({
                modelName: currentModelCfg.model,
                reasoningEffort: currentModelCfg.reasoningEffort,
                reasoningDisplay: modelConfigManager.getDisplayLabel().effort,
                projectPath: currentProject.rootPath,
                placeholder: "How can I help you?"
            });
            const trimmed = userInput.trim();

            if (!trimmed) {
                continue;
            }

            // 快捷退出指令
            if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit" || trimmed === "/quit") {
                break;
            }

            // 3. 斜杠命令分发路由
            if (trimmed.startsWith("/")) {
                const parts = trimmed.split(/\s+/);
                const cmd = parts[0].toLowerCase();
                const cmdArg = parts.slice(1).join(" ");

                if (cmd === "/image") {
                    const imgData = await commandHandler.handleImage(cmdArg);
                    if (!imgData) {
                        continue;
                    }
                    printImageAttachmentBadge(imgData.imagePaths);

                    // 3.1 记录起始时间并调用 agent 执行对话
                    const turnStart = Date.now();
                    const result = await chat(imgData.prompt, imgData.imagePaths);
                    const turnDuration = Date.now() - turnStart;

                    // 3.2 渲染回复、耗时并处理方案确认
                    await handleTurnCompletion(result, turnDuration, false);
                    continue;
                }

                if (cmd === "/model") {
                    await commandHandler.handleModel(cmdArg);
                    continue;
                }

                if (cmd === "/compact") {
                    await commandHandler.handleCompact(currentSessionId);
                    continue;
                }

                if (cmd === "/permissions" || cmd === "/permission" || cmd === "/perm") {
                    await commandHandler.handlePermissions(cmdArg);
                    continue;
                }

                if (cmd === "/resume") {
                    const resumedId = await commandHandler.handleResume(cmdArg, currentProject.id);
                    if (resumedId !== null) {
                        currentSessionId = resumedId;
                    }
                    continue;
                }

                if (cmd === "/new") {
                    // 创建当前工程下新的独立会话
                    const newSession = await sessionService.createSession("新对话", currentProject.id);
                    currentSessionId = newSession.id;

                    commandHandler.handleNew(newSession.id);
                    continue;
                }

                if (cmd === "/help") {
                    commandHandler.handleHelp();
                    continue;
                }

                if (cmd === "/turn" || cmd === "/turns" || cmd === "/inspect") {
                    await commandHandler.handleTurn(cmdArg);
                    continue;
                }

                if (cmd === "/plan") {
                    if (!cmdArg) {
                        console.log(`\n${colors.yellow}用法: /plan <任务描述> - 显式启动规划模式，深入查阅代码并输出技术方案。${colors.reset}\n`);
                        continue;
                    }

                    // 构造严格的 Planning 模式 Prompt，引导只读分析与产出方案
                    const planPrompt = `【PLANNING 规划模式】请针对以下任务进行深入分析与调研规划。在此模式下，请仅使用只读工具（如 list_files, read_file, grep_search, git_status 等）查阅代码，切勿执行任何写操作或修改代码。请输出一份条理清晰、步骤明确的完整技术实施方案：\n\n${cmdArg}`;

                    console.log(`\n${colors.bold}● Plan: ${cmdArg}${colors.reset}\n`);

                    // 记录起始时间并执行规划模式
                    const turnStart = Date.now();
                    const result = await chat(planPrompt);
                    const turnDuration = Date.now() - turnStart;

                    // 渲染方案回复并自动弹出确认弹窗
                    await handleTurnCompletion(result, turnDuration, true);
                    continue;
                }

                console.log(`\n${colors.red}未知指令 "${cmd}"，输入 /help 查看支持的命令列表。${colors.reset}\n`);
                continue;
            }

            // 4. 普通自然语言问答与代码任务处理（支持自动提取拖拽或包含的图片文件）
            const extracted = extractImagePaths(trimmed);
            let activePrompt = trimmed;
            const attachedImages: string[] = [];

            if (extracted.imagePaths.length > 0) {
                for (const p of extracted.imagePaths) {
                    try {
                        await fs.access(p);
                        attachedImages.push(p);
                    } catch {
                        // 忽略不存在的文件
                    }
                }
                if (attachedImages.length > 0) {
                    activePrompt = extracted.cleanText || "请详细分析并说明该图片中的内容。";
                    printImageAttachmentBadge(attachedImages);
                }
            }

            // 记录用户输入提交起始时间
            const turnStart = Date.now();
            const result = await chat(activePrompt, attachedImages.length > 0 ? attachedImages : undefined);
            const turnDuration = Date.now() - turnStart;

            // 渲染最终回复、结算耗时并处理方案确认流转
            await handleTurnCompletion(result, turnDuration, false);
        }
    } catch (err) {
        if (!isAbortError(err)) {
            console.error(`\n${colors.red}运行异常:${colors.reset}`, err);
        }
    } finally {
        mouseTracker.disable();
        process.off("SIGINT", onSigInt);
        console.log(`\n${colors.gray}=== DUSK CLI 已退出 ===${colors.reset}`);
    }
}

/** CLI 主入口，解析子命令并启动交互终端 */
function main(): void {
    const args = process.argv.slice(2);
    const firstArg = args[0]?.toLowerCase();

    if (firstArg === "-v" || firstArg === "--version") {
        console.log("dusk v1.0.0");
        return;
    }

    if (firstArg === "-h" || firstArg === "--help") {
        console.log(`
${colors.cyan}${colors.bold}Dusk - Autonomous Code Agent${colors.reset}

用法:
  dusk code        启动交互式终端 Code Agent
  dusk --help      查看帮助
  dusk --version   查看版本
`);
        return;
    }

    // 默认或接收 code 参数均启动交互式 Code Agent 终端
    startCli();
}

main();
