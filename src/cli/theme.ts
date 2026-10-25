import * as path from "node:path";
import type { PermissionMode } from "../agent/runtime/permission-manager";
import type { AgentExecutionStep, RunStatus } from "../agent/types";
import { reasoningLabel } from "../agent/runtime/generation-policy";
import { renderMarkdown } from "./markdown";
import { readToolDetails, isToolRecord } from "../agent/tools/result";
import { getTerminalWidth, truncateTerminalText, wrapTerminalText } from "./terminal-layout";
import { liveInputManager } from "./live-input";
import { compactSummary, failureSummary, previewLine, resultFailed } from "./tool-summary";

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
            return `${colors.gray}[Full Access]${colors.reset}`;
        case "workspace":
        default:
            return `${colors.green}${colors.bold}[Workspace]${colors.reset}`;
    }
}

/** 提炼紧凑简短的工具返回结果，过滤冗余大报文 */
export function formatCompactResult(result: unknown): string {
    return truncateTerminalText(compactSummary(result), Math.min(80, getTerminalWidth()));
}

/** 格式化工具调用参数简要信息 */
export function formatToolArgs(args: Record<string, any> = {}): string {
    const keys = Object.keys(args);
    if (keys.length === 0) {
        return "";
    }
    const preview = keys
        .map((k) => {
            const v = args[k];
            const strVal = typeof v === "string" ? `"${v.length > 30 ? v.slice(0, 30) + "..." : v}"` : String(v);
            return `${k}: ${strVal}`;
        })
        .join(", ");
    return `(${preview.length > 80 ? preview.slice(0, 80) + "..." : preview})`;
}

/** 用简短动作和目标展示工具调用 */
export function formatToolHeader(toolName: string, args: Record<string, any> = {}): string {
    let target = "";
    if (args.filePath) {
        target = path.basename(args.filePath);
    } else if (args.directoryPath) {
        target = path.basename(path.resolve(args.directoryPath)) || ".";
    } else if (args.command) {
        target = args.command;
    } else if (args.query) {
        target = `"${args.query}"`;
    } else if (args.expression) {
        target = args.expression;
    }

    const actions: Record<string, string> = {
        write_file: "写入",
        read_file: "读取",
        read_code: "读取",
        apply_patch: "修改",
        execute_command: "运行",
        list_files: "列出",
        grep_search: "搜索",
        git_status: "查看 Git 状态",
        git_diff: "查看 Git 差异"
    };
    const action = actions[toolName] || toolName;
    const detail = target || (toolName.startsWith("git_") ? "" : formatToolArgs(args));
    return truncateTerminalText(`${colors.gray}•${colors.reset} ${action}${detail ? ` ${previewLine(detail)}` : ""}`);
}

/** 显示一行工具结果，失败详情由执行记录按需展开 */
export function formatToolBranchResult(
    toolName: string,
    result: unknown,
    durationMs?: number,
    isError?: boolean
): string {
    const failed = resultFailed(result, isError);
    const details = readToolDetails(result) ?? (isToolRecord(result) ? result : {});
    let summary: string;
    if (failed) {
        summary = failureSummary(result);
    } else if (toolName === "write_file") {
        summary = typeof details.lineCount === "number" ? `已写入 ${details.lineCount} 行` : "已写入文件";
    } else if (toolName === "read_file" || toolName === "read_code") {
        const lines = details.lineCount ?? (typeof result === "string" ? result.split(/\r?\n/).length : undefined);
        summary = typeof lines === "number" ? `已读取 ${lines} 行` : "已读取文件";
    } else if (toolName === "apply_patch") {
        summary = "已应用修改";
    } else if (toolName === "execute_command") {
        summary = typeof details.exitCode === "number" ? `退出码 ${details.exitCode}` : "命令已完成";
    } else if (toolName === "grep_search") {
        const count = details.count ?? (Array.isArray(result) ? result.length : undefined);
        summary = typeof count === "number" ? `${count} 处匹配` : compactSummary(result);
    } else if (toolName === "list_files") {
        const count = details.totalCount ?? (Array.isArray(result) ? result.length : undefined);
        summary = typeof count === "number" ? `${count} 项文件` : compactSummary(result);
    } else if (toolName === "git_status") {
        summary = details.clean ? "工作区无改动" : "已查看状态";
    } else {
        summary = compactSummary(result);
    }

    const duration = durationMs !== undefined ? ` (${formatDuration(durationMs)})` : "";
    const hint = failed ? " · /turn 详情" : "";
    const suffix = `${duration}${hint}`;
    const label = failed ? `${colors.yellow}未完成${colors.gray} · ` : "";
    const prefix = `  ${colors.gray}└ ${label}`;
    const width = getTerminalWidth();
    const preview = truncateTerminalText(previewLine(summary), Math.max(1, width - stringWidth(prefix) - stringWidth(suffix)));
    return `${truncateTerminalText(`${prefix}${preview}${colors.gray}${suffix}`, width)}${colors.reset}`;
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

/** 渲染模型思考用时摘要 */
export function renderThought(durationMs: number, turnNo = 1): void {
    turnHistoryManager.recordThoughtLine(turnNo);
    turnHistoryManager.recordOutputLines(1);
    rollingTicker.finish(durationMs);
}

/** 渲染单轮从用户输入到 Assistant 输出截止的全链路耗时总结 */
export function renderCrunchedSummary(totalMs: number, deliveryStatus?: string): void {
    rollingTicker.flush();
    turnHistoryManager.recordOutputLines(3);
    const label = deliveryStatus === "passed" ? "验收通过" : deliveryStatus && deliveryStatus !== "not_required" ? "本轮执行结束，验收未完成" : "本轮执行结束";
    console.log(`\n${colors.gray}─ ${label} · ${formatDuration(totalMs)}${colors.reset}\n`);
}

/** 渲染思考、工具和中间回复，隐藏内部循环编号 */
export function renderLiveStep(step: AgentExecutionStep): void {
    const turnNo = step.turnNo ?? 1;

    if (step.type === "task_status" && step.taskStatus) {
        const state = step.taskStatus;
        const phases = {
            routing: "识别要求",
            pending: "实现",
            verifying: "验收",
            repairing: "续修",
            not_required: "处理要求",
            finished: "结束"
        };
        liveInputManager.setTaskStatus(`本轮 ${state.request.slice(0, 24)} · ${phases[state.phase] ?? state.phase} · 通过 ${state.counts.passed ?? 0} · 待评审 ${state.counts.awaiting_review ?? 0} · 耗时 ${formatDuration(state.elapsedMs ?? state.remainingMs ?? 0)}`);
    } else if (step.type === "turn_start") {
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
        console.log(`\n${colors.gray}•${colors.reset}\n`);
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
        const failed = resultFailed(step.result, step.isError);
        turnHistoryManager.recordToolResult(
            turnNo,
            step.toolCallId || "",
            step.result,
            step.durationMs,
            failed
        );
        const branchLine = formatToolBranchResult(step.toolName || "tool", step.result, step.durationMs, failed);
        turnHistoryManager.recordOutputLines(1);
        console.log(branchLine);
    } else if (step.type === "turn_end") {
        turnHistoryManager.finishTurn(turnNo);
        rollingTicker.setStage("正在整理回复");
    } else if (step.type === "status") {
        const content = previewLine(step.content ?? "生成状态更新");
        if (/^模型生成中，已等待/.test(content)) {
            return;
        }
        rollingTicker.setStage(content);
        turnHistoryManager.recordOutputLines(2);
        console.log(`\n${colors.gray}• ${truncateTerminalText(content, Math.max(1, getTerminalWidth() - 2))}${colors.reset}`);
    }
}

/** 用普通正文展示最终回复与执行状态 */
export function renderAssistantReply(content: string, status?: RunStatus): void {
    rollingTicker.flush();
    const label = status && status !== "completed" ? ` [${status}]` : "";
    const md = renderMarkdown(content || "本轮没有可显示的回复，请查看执行状态。");
    turnHistoryManager.recordOutputLines(countScreenLines(md) + 3);
    console.log(`\n${colors.gray}•${label}${colors.reset}\n`);
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

/** 简短说明全量授权模式的权限范围 */
export function printFullAccessWarning(): void {
    console.log(`\n${colors.gray}Full Access：允许执行命令及跨目录写入，不再逐项确认。${colors.reset}\n`);
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
  ${colors.yellow}/verify [taskId]${colors.reset}        继续最近未完成的验收，保留实际证据与缺口
  ${colors.yellow}/permissions [mode]${colors.reset}    查看或切换权限: read-only | workspace | full-access
  ${colors.yellow}/compact${colors.reset}               显式压缩当前会话上下文，释放 Token 消耗
  ${colors.yellow}/turn [n]${colors.reset}              查看执行记录的完整思考过程、工具调用与响应结果
  ${colors.yellow}/resume [id]${colors.reset}           列出当前项目历史会话，或按 ID 恢复指定会话
  ${colors.yellow}/new${colors.reset}                   开启当前项目下的全新会话
  ${colors.yellow}/help${colors.reset}                  显示本帮助指南
  ${colors.yellow}exit / quit${colors.reset}            退出命令行程序
`);
}
