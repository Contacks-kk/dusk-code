import * as path from "node:path";
import type { PermissionMode } from "../agent/runtime/permission-manager";
import type { AgentExecutionStep, RunStatus } from "../agent/types";
import { reasoningLabel } from "../agent/runtime/generation-policy";
import { renderMarkdown } from "./markdown";
import { imageArchiveReplacer } from "../utils/image";
import { getTerminalWidth, wrapTerminalText } from "./terminal-layout";

export const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    brightRed: "\x1b[91m",
    brightYellow: "\x1b[93m"
};

/** 将毫秒转换为人类可读的时间长度 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }

    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

/** 格式化权限模式标签 */
export function formatPermissionBadge(mode: PermissionMode): string {
    switch (mode) {
        case "read-only":
            return `${colors.blue}${colors.bold}[Read Only]${colors.reset}`;
        case "full-access":
            return `${colors.brightRed}${colors.bold}[Full Access ⚠️]${colors.reset}`;
        case "workspace":
        default:
            return `${colors.green}${colors.bold}[Workspace]${colors.reset}`;
    }
}

/** 提炼紧凑简短的工具返回结果，过滤冗余大报文 */
export function formatCompactResult(result: any): string {
    if (result === undefined || result === null) {
        return "完成 (无返回值)";
    }

    if (typeof result === "object") {
        if ("result" in result) {
            return formatCompactResult(result.result);
        }
        const json = JSON.stringify(result, imageArchiveReplacer);
        return json.length > 80 ? json.slice(0, 80) + "..." : json;
    }

    const str = String(result).replace(/[\r\n]+/g, " ").trim();
    return str.length > 80 ? str.slice(0, 80) + "..." : str;
}

/** 格式化工具调用参数简要信息 */
export function formatToolArgs(args: Record<string, any> = {}): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return "";
    const preview = keys
        .map((k) => {
            const v = args[k];
            const strVal = typeof v === "string" ? `"${v.length > 30 ? v.slice(0, 30) + "..." : v}"` : String(v);
            return `${k}: ${strVal}`;
        })
        .join(", ");
    return `(${preview.length > 80 ? preview.slice(0, 80) + "..." : preview})`;
}

/** 格式化 Claude Code 风格的工具调用标头 */
export function formatToolHeader(toolName: string, args: Record<string, any> = {}): string {
    let target = "";
    if (args.filePath) {
        target = path.basename(args.filePath);
    } else if (args.directoryPath) {
        target = path.basename(path.resolve(args.directoryPath)) || ".";
    } else if (args.command) {
        const cmdStr = args.command.replace(/[\r\n]+/g, " ").trim();
        target = cmdStr.length > 40 ? cmdStr.slice(0, 40) + "..." : cmdStr;
    } else if (args.query) {
        target = `"${args.query}"`;
    } else if (args.expression) {
        target = args.expression;
    }

    switch (toolName) {
        case "write_file":
            return `${colors.bold}● Write(${target || "file"})${colors.reset}`;
        case "read_file":
        case "read_code":
            return `${colors.bold}● Read(${target || "file"})${colors.reset}`;
        case "apply_patch":
            return `${colors.bold}● Patch(${target || "file"})${colors.reset}`;
        case "execute_command":
            return `${colors.bold}● Bash(${target || "command"})${colors.reset}`;
        case "list_files":
            return `${colors.bold}● List(${target || "."})${colors.reset}`;
        case "grep_search":
            return `${colors.bold}● Grep(${target || "pattern"})${colors.reset}`;
        case "git_status":
            return `${colors.bold}● Git(status)${colors.reset}`;
        case "git_diff":
            return `${colors.bold}● Git(diff)${colors.reset}`;
        default:
            return `${colors.bold}● ${toolName}(${target || formatToolArgs(args)})${colors.reset}`;
    }
}

/** 格式化工具分支返回结果（Claude Code ⎿ 样式） */
export function formatToolBranchResult(
    toolName: string,
    result: any,
    durationMs?: number,
    isError?: boolean
): string {
    const branchPrefix = `  ${colors.gray}⎿ ${colors.reset} `;
    const durationSuffix = durationMs !== undefined ? ` ${colors.gray}(${formatDuration(durationMs)})${colors.reset}` : "";

    if (isError) {
        const errorText = typeof result === "string" ? result : (result?.message || JSON.stringify(result, imageArchiveReplacer));
        return `${branchPrefix}${colors.red}Error: ${errorText}${colors.reset}${durationSuffix}`;
    }

    let summary = "";
    if (toolName === "write_file") {
        if (typeof result === "string" && result.includes("成功")) {
            summary = result.trim();
        } else {
            summary = "Wrote file successfully";
        }
    } else if (toolName === "read_file" || toolName === "read_code") {
        if (typeof result === "string") {
            const lines = result.split(/\r?\n/).length;
            summary = `Read ${lines} lines`;
        } else {
            summary = "Read file completed";
        }
    } else if (toolName === "apply_patch") {
        summary = "Applied patch chunk(s) successfully";
    } else if (toolName === "execute_command") {
        if (typeof result === "object" && result !== null && "exitCode" in result) {
            summary = `Exited with code ${result.exitCode}`;
        } else {
            summary = "Command execution completed";
        }
    } else if (toolName === "grep_search") {
        if (Array.isArray(result)) {
            summary = `Found ${result.length} matches`;
        } else {
            summary = formatCompactResult(result);
        }
    } else if (toolName === "list_files") {
        if (Array.isArray(result)) {
            summary = `Listed ${result.length} entries`;
        } else {
            summary = formatCompactResult(result);
        }
    } else if (toolName === "git_status") {
        if (typeof result === "object" && result !== null) {
            summary = result.clean ? "Working tree clean" : "Status inspected";
        } else {
            summary = String(result).slice(0, 60);
        }
    } else {
        summary = formatCompactResult(result);
    }

    return `${branchPrefix}${colors.white}${summary}${colors.reset}${durationSuffix}`;
}

import { rollingTicker } from "./rolling-ticker";
import { turnHistoryManager } from "./turn-history";

import stringWidth from "string-width";

/** 计算字符串在当前终端列宽下占据的物理显示行数 */
export function countScreenLines(text: string, cols = process.stdout.columns || 80): number {
    const rawLines = text.split(/\r?\n/);
    let total = 0;
    for (const line of rawLines) {
        const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        const width = stringWidth(clean);
        total += Math.max(1, Math.ceil(width / cols));
    }
    return total;
}

/** 渲染模型思考用时卡片 */
export function renderThought(durationMs: number, turnNo = 1): void {
    turnHistoryManager.recordThoughtLine(turnNo);
    turnHistoryManager.recordOutputLines(1);
    rollingTicker.finish(durationMs);
}

/** 渲染单轮从用户输入到 Assistant 输出截止的全链路耗时总结 */
export function renderCrunchedSummary(totalMs: number): void {
    rollingTicker.flush();
    turnHistoryManager.recordOutputLines(3);
    console.log(`\n${colors.cyan}✻ Completed in ${formatDuration(totalMs)} (本轮耗时: ${formatDuration(totalMs)})${colors.reset}\n`);
}

/** 渲染思考、工具和中间回复，隐藏内部循环编号 */
export function renderLiveStep(step: AgentExecutionStep): void {
    const turnNo = step.turnNo ?? 1;

    if (step.type === "turn_start") {
        rollingTicker.setStage("正在等待模型响应");
        turnHistoryManager.recordTurnStart(turnNo);
    } else if (step.type === "thinking_delta") {
        if (step.delta) {
            turnHistoryManager.appendThinking(turnNo, step.delta);
            rollingTicker.update(step.delta);
        }
    } else if (step.type === "thought") {
        turnHistoryManager.finishThinking(turnNo, step.durationMs || 0);
        turnHistoryManager.recordThoughtLine(turnNo);
        turnHistoryManager.recordOutputLines(1);
        rollingTicker.finish(step.durationMs);
    } else if (step.type === "intermediate_text") {
        rollingTicker.setStage("正在准备工具调用");
        turnHistoryManager.recordIntermediateText(turnNo, step.content ?? "");
        const md = renderMarkdown(step.content ?? "");
        turnHistoryManager.recordOutputLines(countScreenLines(md) + 3);
        console.log(`\n${colors.magenta}● Assistant${colors.reset}\n`);
        console.log(md);
    } else if (step.type === "tool_call") {
        rollingTicker.setStage(`正在执行 ${step.toolName || "工具"}`);
        turnHistoryManager.recordToolCall(turnNo, {
            id: step.toolCallId || "",
            name: step.toolName || "tool",
            args: step.args || {}
        });
        turnHistoryManager.recordOutputLines(2);
        console.log(`\n${formatToolHeader(step.toolName || "tool", step.args)}`);
    } else if (step.type === "tool_result") {
        rollingTicker.setStage("正在等待模型继续回复");
        turnHistoryManager.recordToolResult(
            turnNo,
            step.toolCallId || "",
            step.result,
            step.durationMs,
            step.isError
        );
        const branchLine = formatToolBranchResult(step.toolName || "tool", step.result, step.durationMs, step.isError);
        const hint = ` ${colors.dim}[输入 /turn 查看完整响应]${colors.reset}`;
        turnHistoryManager.recordOutputLines(1);
        console.log(`${branchLine}${hint}`);
    } else if (step.type === "turn_end") {
        turnHistoryManager.finishTurn(turnNo);
        rollingTicker.setStage("正在整理回复");
    } else if (step.type === "status") {
        rollingTicker.setStage(step.content ?? "生成状态更新");
        turnHistoryManager.recordOutputLines(2);
        console.log(`\n${colors.cyan}↻ ${step.content ?? "生成状态更新"}${colors.reset}`);
    }
}

/** 渲染包含原生 Markdown 终端美化的高级 Assistant 回复 */
export function renderAssistantReply(content: string, status?: RunStatus): void {
    rollingTicker.flush();
    const label = status && status !== "completed" ? ` [${status}]` : "";
    const md = renderMarkdown(content || "本轮没有可显示的回复，请查看执行状态。");
    turnHistoryManager.recordOutputLines(countScreenLines(md) + 3);
    console.log(`\n${colors.magenta}● Assistant${label}${colors.reset}\n`);
    console.log(md);
}

/** 打印启动 Banner 与控制台看板 */
export function printHeaderBanner(info: {
    projectName: string;
    projectPath: string;
    sessionId?: number;
    permissionMode: PermissionMode;
    modelName?: string;
    reasoningEffort?: string;
    reasoningDisplay?: string;
}): void {
    const permBadge = formatPermissionBadge(info.permissionMode);
    const sessionText = info.sessionId ? `#${info.sessionId}` : "(未创建，首次发送自动生成)";
    const modelText = `${colors.bold}${info.modelName || "deepseek-chat"}${colors.reset} ${colors.gray}(${info.reasoningDisplay ?? reasoningLabel(info.modelName || "deepseek-chat", info.reasoningEffort || "high")})${colors.cyan}`;

    const width = Math.min(90, getTerminalWidth());
    const content = [
        `${colors.bold}✦ DUSK CLI${colors.reset}  ${colors.gray}Autonomous Code Agent${colors.reset}`,
        "",
        `${colors.white}Project :${colors.reset} ${colors.bold}${info.projectName}${colors.reset} ${colors.gray}(${info.projectPath})${colors.reset}`,
        `${colors.white}Session :${colors.reset} ${colors.magenta}${sessionText}${colors.reset}`,
        `${colors.white}Model   :${colors.reset} ${modelText}${colors.reset}`,
        `${colors.white}Security:${colors.reset} ${permBadge}`,
        "",
        `${colors.gray}常用指令: /help · /image · /model · /plan · /turn · /permissions · /compact · exit${colors.reset}`
    ];
    if (width < 8) {
        console.log(content.flatMap(line => wrapTerminalText(line, width)).join("\n"));
        return;
    }

    // 所有边框行使用相同的显示宽度，长路径与中文提示在框内折行
    const innerWidth = width - 4;
    const rows = content.flatMap(line => wrapTerminalText(line, innerWidth)).map(line =>
        `${colors.cyan}│${colors.reset} ${line}${" ".repeat(Math.max(0, innerWidth - stringWidth(line)))} ${colors.cyan}│${colors.reset}`
    );
    console.log(`\n${colors.cyan}╭${"─".repeat(width - 2)}╮${colors.reset}\n${rows.join("\n")}\n${colors.cyan}╰${"─".repeat(width - 2)}╯${colors.reset}\n`);
}

/** 打印图片附件提示标签 */
export function printImageAttachmentBadge(imagePaths: string[]): void {
    if (!imagePaths || imagePaths.length === 0) return;
    const names = imagePaths.map((p) => path.basename(p)).join(", ");
    console.log(`  ${colors.cyan}📷 附加图片 [${imagePaths.length}]: ${colors.bold}${names}${colors.reset}\n`);
}

/** 打印 Full Access 危险权限安全警告卡片 */
export function printFullAccessWarning(): void {
    console.log(`
${colors.brightYellow}┌──────────────────────────────── 安全风险警报 ────────────────────────────────┐
│ ⚠️  您已切换至 [Full Access] 全量授权模式！                                  │
│                                                                              │
│ 1. Agent 具有任意终端命令执行与跨目录写文件权限。                           │
│ 2. 系统将不再拦截越界写入或敏感凭证修改操作。                               │
│ 3. 建议仅在隔离的测试沙箱或明确受信任的仓库中开启。                         │
└──────────────────────────────────────────────────────────────────────────────┘${colors.reset}
`);
}

/** 打印斜杠命令帮助表 */
export function printHelpTable(): void {
    console.log(`
${colors.cyan}${colors.bold}DUSK CLI 命令指引${colors.reset}

  ${colors.yellow}/image [路径] [任务]${colors.reset}    附加本地图片或自动提取剪贴板截图进行视图分析
  ${colors.yellow}/model [name] [effort]${colors.reset} 切换语言模型与推理等级: xhigh | high | medium | low | off
  ${colors.yellow}/plan <任务需求>${colors.reset}        显式进入规划模式，深入只读调研代码并输出实施计划
  ${colors.yellow}/skill [name]${colors.reset}           查看技能；指定名称后固定到当前会话
  ${colors.yellow}/skill off <name> | clear${colors.reset}  关闭技能，或清除手动设置并恢复自动选择
  ${colors.yellow}/permissions [mode]${colors.reset}    查看或切换权限: read-only | workspace | full-access
  ${colors.yellow}/compact${colors.reset}               显式压缩当前会话上下文，释放 Token 消耗
  ${colors.yellow}/turn [n]${colors.reset}              查看执行记录的完整思考过程、工具调用与响应结果
  ${colors.yellow}/resume [id]${colors.reset}           列出当前项目历史会话，或按 ID 恢复指定会话
  ${colors.yellow}/new${colors.reset}                   开启当前项目下的全新会话
  ${colors.yellow}/help${colors.reset}                  显示本帮助指南
  ${colors.yellow}exit / quit${colors.reset}            退出命令行程序
`);
}
