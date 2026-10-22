import * as readline from "node:readline";
import stringWidth from "string-width";
import { colors } from "./theme";
import { reasoningLabel } from "../agent/runtime/generation-policy";
import { turnHistoryManager } from "./turn-history";
import { turnInspector } from "./turn-inspector";
import { mouseTracker } from "./mouse-tracker";

export interface CommandOption {
    name: string;
    description: string;
    requiresArg?: boolean;
}

export const SLASH_COMMANDS: CommandOption[] = [
    { name: "/image", description: "视图输入：自动提取剪贴板截图或加载拖拽图片进行视觉分析", requiresArg: true },
    { name: "/model", description: "模型调节：上下键切换模型与推理思考等级 (Reasoning Effort)" },
    { name: "/plan", description: "规划模式：深入只读调研代码并输出实施方案", requiresArg: true },
    { name: "/permissions", description: "权限调节：上下键切换 Read Only / Workspace / Full Access" },
    { name: "/compact", description: "上下文压缩：显式压缩历史大报文并释放 Token" },
    { name: "/resume", description: "会话恢复：上下键选择当前工程历史会话" },
    { name: "/new", description: "新建会话：开启当前工程下的全新独立会话" },
    { name: "/turn", description: "链路检查：查看思考全文、工具调用与响应结果" },
    { name: "/help", description: "帮助指南：显示支持的指令与快捷说明" },
    { name: "exit", description: "退出终端程序" }
];

export interface SelectItem<T> {
    label: string;
    value: T;
    hint?: string;
}

export interface PromptContext {
    reasoningDisplay?: string;
    modelName: string;
    reasoningEffort: string;
    projectPath: string;
    placeholder?: string;
}

/** 终端交互式上下键单选菜单 */
export async function interactiveSelect<T>(
    items: SelectItem<T>[],
    title: string
): Promise<T | null> {
    if (!items || items.length === 0) {
        return null;
    }

    // 非 TTY 环境兜底，默认直接选第一项
    if (!process.stdin.isTTY) {
        return items[0].value;
    }

    const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
    readline.emitKeypressEvents(input);
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?25l"); // 隐藏光标

    let selectedIndex = 0;
    let isFirstRender = true;

    /** 渲染选项列表 */
    const render = () => {
        if (!isFirstRender) {
            // 回退光标至选项第一行
            process.stdout.write(`\x1b[${items.length}A\r`);
        } else {
            console.log(`\n${colors.cyan}? ${title}${colors.reset} ${colors.gray}(方向键 ↑/↓ 切换，Enter 确认，Esc 取消)${colors.reset}`);
            isFirstRender = false;
        }

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const isSelected = i === selectedIndex;
            const pointer = isSelected ? `${colors.cyan}  ❯ ` : `    `;
            const label = isSelected
                ? `${colors.cyan}${colors.bold}${item.label}${colors.reset}`
                : `${colors.white}${item.label}${colors.reset}`;
            const hint = item.hint ? ` ${colors.gray}(${item.hint})${colors.reset}` : "";
            process.stdout.write(`\x1b[2K${pointer}${label}${hint}\n`);
        }
    };

    return new Promise<T | null>((resolve) => {
        render();

        /** 清理输入监听与恢复光标 */
        const cleanup = () => {
            input.off("keypress", onKeypress);
            if (process.stdin.isTTY && !mouseTracker.isActive()) {
                process.stdin.setRawMode(false);
            }
            process.stdout.write("\x1b[?25h"); // 恢复光标
        };

        /** 响应键盘方向键与确认操作 */
        const onKeypress = (str: string, key: readline.Key) => {
            if (!key) return;

            // 过滤鼠标逃逸序列
            if (str && (str.includes("\x1b[<") || (str.startsWith("<") && key.name === undefined))) {
                return;
            }

            // Ctrl+C 退出进程
            if (key.ctrl && key.name === "c") {
                cleanup();
                process.stdout.write("\n");
                process.emit("SIGINT");
                resolve(null);
                return;
            }

            // Esc 取消选择
            if (key.name === "escape") {
                cleanup();
                process.stdout.write(`\x1b[${items.length + 1}A\r\x1b[0J`);
                console.log(`${colors.gray}已取消操作${colors.reset}\n`);
                resolve(null);
                return;
            }

            // 上下键移动选择项
            if (key.name === "up") {
                selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                render();
                return;
            }
            if (key.name === "down") {
                selectedIndex = (selectedIndex + 1) % items.length;
                render();
                return;
            }

            // 回车确认选择
            if (key.name === "return" || key.name === "enter") {
                cleanup();
                process.stdout.write(`\x1b[${items.length + 1}A\r\x1b[0J`);
                const chosen = items[selectedIndex];
                console.log(`${colors.green}✔ ${title}:${colors.reset} ${colors.bold}${chosen.label}${colors.reset}\n`);
                resolve(chosen.value);
                return;
            }
        };

        input.on("keypress", onKeypress);
    });
}

/** 渲染终端输入区、状态行并响应思考详情快捷键 */
export async function interactivePrompt(
    contextOrPrefix: PromptContext | string,
    commands: CommandOption[] = SLASH_COMMANDS
): Promise<string> {
    const isContext = typeof contextOrPrefix === "object";
    const context: PromptContext = isContext
        ? (contextOrPrefix as PromptContext)
        : {
              modelName: "deepseek-chat",
              reasoningEffort: "high",
              projectPath: process.cwd(),
              placeholder: "How can I help you?"
          };

    if (!process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise<string>((resolve) => {
            rl.question("› ", (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }

    const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
    readline.emitKeypressEvents(input);
    process.stdin.setRawMode(true);

    let buffer = "";
    let cursorIndex = 0;
    let selectedMatchIndex = 0;
    let isFirstRender = true;
    let linesAbove = 1; // 记录当前光标距离整个输入组件顶部的垂直行数

    const placeholderText = context.placeholder || "How can I help you?";
    const bg = "\x1b[48;5;236m"; // Codex 暗灰输入框通体背景
    const reset = "\x1b[0m";

    // 专用前景色调，避免使用 reset 导致整行背景色撕裂脱落
    const FG_PROMPT = "\x1b[38;5;250m";      // 前缀 › 浅中灰
    const FG_INPUT = "\x1b[38;5;255m";       // 用户输入 纯白高亮
    const FG_PLACEHOLDER = "\x1b[38;5;244m"; // 占位符 中灰
    const FG_STATUS_MODEL = "\x1b[38;5;222m"; // 状态栏模型 亮暖黄
    const FG_STATUS_EFFORT = "\x1b[38;5;250m"; // 状态栏推理等级 浅灰
    const FG_STATUS_DOT = "\x1b[38;5;240m";   // 状态栏分隔点 深灰
    const FG_STATUS_PATH = "\x1b[38;5;114m";  // 状态栏路径 浅薄荷绿

    /** 过滤当前匹配的斜杠指令名单 */
    const getMatches = (): CommandOption[] => {
        const trimmed = buffer.trim();
        if (!trimmed.startsWith("/")) {
            return [];
        }
        if (trimmed.includes(" ")) {
            return [];
        }
        const query = trimmed.toLowerCase();
        return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query));
    };

    return new Promise<string>((resolve) => {
        /** 响应 Ctrl+O 快捷键，展开最近一次思考详情 */
        const toggleLatestTurn = async () => {
            if (mouseTracker.isActive()) {
                mouseTracker.openLatestThought();
                return;
            }
            const turnsList = turnHistoryManager.getTurns();
            if (turnsList.length === 0) return;
            const latestTurn = turnsList[turnsList.length - 1];

            // 临时解绑当前输入监听，防止用户确认收起时的按键回落进输入框
            input.off("keypress", onKeypress);
            process.stdout.write(`\x1b[${linesAbove}A\r\x1b[0J`);

            await turnInspector.toggleTurnExpansion(latestTurn.turnNo);

            // 重新进入 RawMode 并恢复输入渲染
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            input.on("keypress", onKeypress);
            isFirstRender = true;
            render();
        };

        /** 渲染输入框、模型状态和命令候选项 */
        const render = () => {
            process.stdout.write("\x1b[?25l"); // 隐藏光标防闪烁

            if (!isFirstRender) {
                // 回退到组件顶部，清理上一次渲染的全部内容
                process.stdout.write(`\x1b[${linesAbove}A\r\x1b[0J`);
            } else {
                isFirstRender = false;
            }

            // 1. Line 1: 上 padding 行（纯背景色整行铺满）
            process.stdout.write(`${bg}\x1b[K${reset}\n`);

            // 2. Line 2: 输入主体行（整行保持 bg，绝不使用 reset，彻底杜绝背景色穿帮）
            if (buffer.length === 0) {
                process.stdout.write(`${bg}  ${FG_PROMPT}› ${FG_PLACEHOLDER}${placeholderText}${bg}\x1b[K${reset}\n`);
            } else {
                process.stdout.write(`${bg}  ${FG_PROMPT}› ${FG_INPUT}${buffer}${bg}\x1b[K${reset}\n`);
            }

            // 3. Line 3: 下 padding 行（纯背景色整行铺满）
            process.stdout.write(`${bg}\x1b[K${reset}\n`);

            // 4. Line 4: 状态信息条（缩进 2 空格，模型 思考等级 · 路径）
            process.stdout.write(
                `  ${FG_STATUS_MODEL}${context.modelName}${reset} ${FG_STATUS_EFFORT}${context.reasoningDisplay ?? reasoningLabel(context.modelName, context.reasoningEffort)}${reset} ${FG_STATUS_DOT}·${reset} ${FG_STATUS_PATH}${context.projectPath}${reset}\n`
            );

            // 5. Line 5+: 若有斜杠命令候选，顺延展示在状态栏下方
            const matches = getMatches();
            let extraDropdownLines = 0;
            if (matches.length > 0) {
                if (selectedMatchIndex >= matches.length) {
                    selectedMatchIndex = 0;
                }
                for (let i = 0; i < matches.length; i++) {
                    const m = matches[i];
                    const isSelected = i === selectedMatchIndex;
                    const pointer = isSelected ? `${colors.cyan}  ❯ ` : `    `;
                    const name = isSelected
                        ? `${colors.cyan}${colors.bold}${m.name.padEnd(16, " ")}${colors.reset}`
                        : `${colors.white}${m.name.padEnd(16, " ")}${colors.reset}`;
                    const desc = isSelected
                        ? `${colors.cyan}${m.description}${colors.reset}`
                        : `${colors.gray}${m.description}${colors.reset}`;
                    process.stdout.write(`\x1b[2K${pointer}${name} ${desc}\n`);
                }
                extraDropdownLines = matches.length;
            }

            // 6. 动态计算输入行折行与光标精准回退
            const cols = Math.max(20, process.stdout.columns || 80);
            const fullText = buffer.length === 0 ? placeholderText : buffer;
            const totalInputWidth = 4 + stringWidth(fullText);
            const inputLineCount = Math.max(1, Math.floor(totalInputWidth / cols) + 1);

            const cursorWidth = 4 + stringWidth(buffer.slice(0, cursorIndex));
            const cursorRow = Math.floor(cursorWidth / cols);
            const cursorCol = cursorWidth % cols;

            // 回退到光标所在行：3行基础跨度 + 下拉菜单行数 + Line 2 末行向上到 cursorRow 的距离
            const totalLinesBelow = 3 + extraDropdownLines + Math.max(0, inputLineCount - 1 - cursorRow);
            process.stdout.write(`\x1b[${totalLinesBelow}A\r`);

            // 横坐标定位
            if (cursorCol > 0) {
                process.stdout.write(`\x1b[${cursorCol}C`);
            }

            // 记录当前光标距离组件顶部的行数，用于下次渲染回退清屏
            linesAbove = 1 + cursorRow;

            process.stdout.write("\x1b[?25h"); // 恢复光标可见
        };

        /** 清理输入监听与恢复光标 */
        const cleanup = () => {
            input.off("keypress", onKeypress);
            if (process.stdin.isTTY && !mouseTracker.isActive()) {
                process.stdin.setRawMode(false);
            }
            process.stdout.write("\x1b[?25h");
        };

        /** 响应用户输入按键与快捷键 */
        const onKeypress = async (str: string, key: readline.Key) => {
            if (!key) return;

            /** Ctrl+O 打开最近一次完整思考 */
            if (key.ctrl && key.name === "o") {
                await toggleLatestTurn();
                return;
            }

            // 过滤任何残留鼠标逃逸序列和非打印残余，防止误录入输入框
            if (
                str &&
                (str.includes("\x1b[<") ||
                 (str.startsWith("<") && key.name === undefined) ||
                 /^\d+;\d+;\d+[Mm]/.test(str))
            ) {
                return;
            }

            // Ctrl+C 退出进程
            if (key.ctrl && key.name === "c") {
                cleanup();
                process.stdout.write(`\x1b[${linesAbove}A\r\x1b[0J\n`);
                process.emit("SIGINT");
                resolve("");
                return;
            }

            const matches = getMatches();

            // 上下键在下拉列表中切换选项
            if (matches.length > 0 && (key.name === "up" || key.name === "down")) {
                if (key.name === "up") {
                    selectedMatchIndex = (selectedMatchIndex - 1 + matches.length) % matches.length;
                } else if (key.name === "down") {
                    selectedMatchIndex = (selectedMatchIndex + 1) % matches.length;
                }
                render();
                return;
            }

            // Tab 或回车在有候选项时自动选定
            if ((key.name === "tab" || (key.name === "return" || key.name === "enter")) && matches.length > 0) {
                const selected = matches[selectedMatchIndex];
                if (selected.requiresArg) {
                    // /plan 需要用户补充具体任务需求
                    buffer = `${selected.name} `;
                    cursorIndex = buffer.length;
                    selectedMatchIndex = 0;
                    render();
                    return;
                } else {
                    // /model, /permissions, /resume, /compact 等直接提交执行
                    cleanup();
                    process.stdout.write(`\x1b[${linesAbove}A\r\x1b[0J`);
                    process.stdout.write(`\x1b[38;5;250m› \x1b[38;5;255m${selected.name}\x1b[0m\n\n`);
                    resolve(selected.name);
                    return;
                }
            }

            // 普通回车提交输入内容
            if (key.name === "return" || key.name === "enter") {
                cleanup();
                process.stdout.write(`\x1b[${linesAbove}A\r\x1b[0J`);
                process.stdout.write(`\x1b[38;5;250m› \x1b[38;5;255m${buffer}\x1b[0m\n\n`);
                resolve(buffer);
                return;
            }

            // 退格删除字符
            if (key.name === "backspace") {
                if (cursorIndex > 0) {
                    buffer = buffer.slice(0, cursorIndex - 1) + buffer.slice(cursorIndex);
                    cursorIndex--;
                    selectedMatchIndex = 0;
                    render();
                }
                return;
            }

            // Delete 删除字符
            if (key.name === "delete") {
                if (cursorIndex < buffer.length) {
                    buffer = buffer.slice(0, cursorIndex) + buffer.slice(cursorIndex + 1);
                    selectedMatchIndex = 0;
                    render();
                }
                return;
            }

            // 左右方向键在输入文本中移动光标
            if (key.name === "left") {
                if (cursorIndex > 0) {
                    cursorIndex--;
                    render();
                }
                return;
            }
            if (key.name === "right") {
                if (cursorIndex < buffer.length) {
                    cursorIndex++;
                    render();
                }
                return;
            }

            // Home / End 键
            if (key.name === "home") {
                cursorIndex = 0;
                render();
                return;
            }
            if (key.name === "end") {
                cursorIndex = buffer.length;
                render();
                return;
            }

            // 普通字符或汉字输入
            if (str && !key.ctrl && !key.meta) {
                buffer = buffer.slice(0, cursorIndex) + str + buffer.slice(cursorIndex);
                cursorIndex += str.length;
                selectedMatchIndex = 0;
                render();
                return;
            }
        };

        render();
        input.on("keypress", onKeypress);
    });
}
