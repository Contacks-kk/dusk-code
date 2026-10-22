import * as readline from "node:readline";
import { colors } from "./theme";
import { mouseTracker } from "./mouse-tracker";
import { interactivePrompt } from "./interactive-prompt";

export type PlanAction = "confirm" | "supplement" | "cancel";

export interface PlanConfirmationResult {
    action: PlanAction;
    supplementText?: string;
}

/** 检测助手回复是否为等待用户授权执行的技术方案 */
export function isPlanConfirmationPrompt(reply: string, isExplicitPlan = false): boolean {
    if (!reply) {
        return false;
    }

    if (isExplicitPlan) {
        return true;
    }

    const keywords = [
        "请问是否确认执行",
        "是否确认执行",
        "确认执行该修改",
        "是否同意执行",
        "请确认是否执行",
        "是否确认开始执行",
        "请确认是否开始修改",
        "是否确认继续"
    ];

    return keywords.some((kw) => reply.includes(kw));
}

/** 弹出置于底部的方案确认弹窗，支持上下键选择确定或补充 */
export async function promptPlanConfirmation(): Promise<PlanConfirmationResult> {
    if (!process.stdin.isTTY) {
        return { action: "confirm" };
    }

    const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
    readline.emitKeypressEvents(input);
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?25l"); // 隐藏光标

    const options = [
        {
            key: "confirm" as PlanAction,
            label: "确定",
            desc: "立即授权 Agent 执行上述技术方案并落实修改"
        },
        {
            key: "supplement" as PlanAction,
            label: "补充",
            desc: "提出修改意见、补充设计约束或调整方案"
        }
    ];

    let selectedIndex = 0;
    let isFirstRender = true;

    /** 渲染方案确认弹窗卡片 */
    const render = () => {
        const linesToClear = 6;
        if (!isFirstRender) {
            process.stdout.write(`\x1b[${linesToClear}A\r`);
        } else {
            isFirstRender = false;
        }

        // 渲染弹窗上边框与标题
        process.stdout.write(`\x1b[2K${colors.cyan}╭──────────────────────── 方案确认与跟进 ────────────────────────╮${colors.reset}\n`);
        process.stdout.write(`\x1b[2K${colors.cyan}│${colors.reset}  ${colors.white}${colors.bold}请选择接下来的执行方式:${colors.reset} ${colors.gray}(方向键 ↑/↓ 切换，Enter 确认)${colors.reset}       ${colors.cyan}│${colors.reset}\n`);

        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const isSelected = i === selectedIndex;
            const pointer = isSelected ? `${colors.green}${colors.bold}❯ ` : `  `;
            const labelText = isSelected
                ? `${colors.green}${colors.bold}[${opt.label}]${colors.reset}`
                : `${colors.gray}[${opt.label}]${colors.reset}`;
            const descText = isSelected
                ? `${colors.white}${opt.desc}${colors.reset}`
                : `${colors.gray}${opt.desc}${colors.reset}`;

            process.stdout.write(`\x1b[2K${colors.cyan}│${colors.reset}  ${pointer}${labelText} ${descText}\x1b[K\n`);
        }

        // 渲染弹窗下边框
        process.stdout.write(`\x1b[2K${colors.cyan}│                                                                │${colors.reset}\n`);
        process.stdout.write(`\x1b[2K${colors.cyan}╰────────────────────────────────────────────────────────────────╯${colors.reset}\n`);
    };

    const action = await new Promise<PlanAction>((resolve) => {
        render();

        /** 清理输入监听与还原状态 */
        const cleanup = () => {
            input.off("keypress", onKeypress);
            if (process.stdin.isTTY && !mouseTracker.isActive()) {
                process.stdin.setRawMode(false);
            }
            process.stdout.write("\x1b[?25h"); // 恢复光标
        };

        /** 响应键盘方向键与确认操作 */
        const onKeypress = (str: string, key: readline.Key) => {
            if (!key) {
                return;
            }

            // 过滤鼠标转义序列
            if (str && (str.includes("\x1b[<") || (str.startsWith("<") && key.name === undefined))) {
                return;
            }

            // Ctrl+C 退出进程
            if (key.ctrl && key.name === "c") {
                cleanup();
                process.stdout.write("\n");
                process.emit("SIGINT");
                resolve("cancel");
                return;
            }

            // Esc 取消
            if (key.name === "escape") {
                cleanup();
                process.stdout.write(`\x1b[6A\r\x1b[0J`);
                resolve("cancel");
                return;
            }

            // 上下键切换
            if (key.name === "up" || key.name === "down") {
                selectedIndex = selectedIndex === 0 ? 1 : 0;
                render();
                return;
            }

            // 回车选定
            if (key.name === "return" || key.name === "enter") {
                cleanup();
                process.stdout.write(`\x1b[6A\r\x1b[0J`);
                resolve(options[selectedIndex].key);
                return;
            }
        };

        input.on("keypress", onKeypress);
    });

    if (action === "confirm") {
        console.log(`\n${colors.green}✔ 已确认技术方案，立即开始执行...${colors.reset}\n`);
        return { action: "confirm" };
    }

    if (action === "supplement") {
        console.log(`\n${colors.yellow}✎ 请输入对上述技术方案的补充说明或修改要求：${colors.reset}`);
        const supplementInput = await interactivePrompt({
            modelName: "方案补充",
            reasoningEffort: "high",
            projectPath: process.cwd(),
            placeholder: "例如：请额外补充参数校验，并注意兼容现有配置..."
        });

        const trimmed = supplementInput.trim();
        if (!trimmed) {
            console.log(`${colors.gray}(未输入补充内容，已取消)${colors.reset}\n`);
            return { action: "cancel" };
        }

        return {
            action: "supplement",
            supplementText: trimmed
        };
    }

    return { action: "cancel" };
}
