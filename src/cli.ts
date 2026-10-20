import * as fs from "node:fs/promises";
import { agentService } from "./services/agent.service";
import { projectService } from "./services/project.service";
import { permissionManager } from "./agent/runtime/permission-manager";
import { modelConfigManager } from "./agent/runtime/model-config";
import { commandHandler } from "./cli/command-handler";
import { colors, printHeaderBanner, renderLiveStep, renderAssistantReply, renderCrunchedSummary, printImageAttachmentBadge } from "./cli/theme";
import { interactivePrompt, interactiveSelect } from "./cli/interactive-prompt";
import { extractImagePaths } from "./utils/image";
import { mouseTracker } from "./cli/mouse-tracker";

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

    // 2. 打印品牌 Banner 与工程看板
    const initialModelCfg = modelConfigManager.getModelConfig();
    printHeaderBanner({
        projectName: currentProject.name,
        projectPath: currentProject.rootPath,
        sessionId: currentSessionId,
        permissionMode: permissionManager.getMode(),
        modelName: initialModelCfg.model,
        reasoningEffort: initialModelCfg.reasoningEffort
    });

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

    /** 为所有 CLI 对话入口绑定统一取消控制器 */
    const chat = async (prompt: string, imagePaths?: string[]) => {
        activeController = new AbortController();
        try {
            return await agentService.chat(currentSessionId, prompt, {
                projectId: currentProject.id, imagePaths, signal: activeController.signal,
                onStep: renderLiveStep, onAskPermission: askUserPermission
            });
        } finally { activeController = undefined; }
    };

    try {
        while (!exitRequested) {
            const currentModelCfg = modelConfigManager.getModelConfig();

            // 调用 Codex CLI 风格输入器（暗色背景输入条 + 状态行 + 精确中文光标）
            const userInput = await interactivePrompt({
                modelName: currentModelCfg.model,
                reasoningEffort: currentModelCfg.reasoningEffort,
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

                    // 3.1 调用agent进行chat
                    const result = await chat(imgData.prompt, imgData.imagePaths);
                    currentSessionId = result.sessionId;

                    // 3.2 渲染包含原生 Markdown
                    renderAssistantReply(result.reply, result.status);
                    if (result.totalDurationMs) {
                        renderCrunchedSummary(result.totalDurationMs);
                    }
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
                    commandHandler.handleNew();
                    currentSessionId = undefined;
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
                    const result = await chat(planPrompt);
                    currentSessionId = result.sessionId;

                    renderAssistantReply(result.reply, result.status);
                    if (result.totalDurationMs) {
                        renderCrunchedSummary(result.totalDurationMs);
                    }
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

            const result = await chat(activePrompt, attachedImages.length > 0 ? attachedImages : undefined);
            currentSessionId = result.sessionId;

            // 渲染最终回复（原生 Markdown 终端美化与耗时结算）
            renderAssistantReply(result.reply, result.status);
            if (result.totalDurationMs) {
                renderCrunchedSummary(result.totalDurationMs);
            }
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
