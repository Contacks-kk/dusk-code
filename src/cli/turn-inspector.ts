import * as readline from "node:readline";
import { colors, formatDuration } from "./theme";
import { turnHistoryManager, type TurnRecord, type ToolCallDetail } from "./turn-history";
import { interactiveSelect, type SelectItem } from "./interactive-prompt";
import { renderMarkdown } from "./markdown";
import { mouseTracker } from "./mouse-tracker";

export class TurnInspector {
    /** 等待用户按任意键继续 */
    private async waitForKey(promptText = "按任意键折叠收起..."): Promise<void> {
        if (!process.stdin.isTTY) return;
        return new Promise<void>((resolve) => {
            const input = mouseTracker.isActive() ? mouseTracker.input : process.stdin;
            readline.emitKeypressEvents(input);
            process.stdin.setRawMode(true);
            process.stdout.write(`\n${colors.gray}${promptText}${colors.reset}\n`);

            /** 清理详情输入监听并按需还原终端模式 */
            const cleanup = () => {
                input.off("keypress", onKeypress);
                input.off("data", onData);
                if (process.stdin.isTTY && !mouseTracker.isActive()) {
                    process.stdin.setRawMode(false);
                }
            };

            /** 按键确认后返回上一层详情 */
            const onKeypress = (_text: string, key: readline.Key) => {
                cleanup();
                resolve();
                if (key?.ctrl && key.name === "c") process.emit("SIGINT");
            };

            /** 接收终端文本输入并返回详情 */
            const onData = (chunk: Buffer) => {
                const str = chunk.toString("utf-8");
                if (str.length > 0) {
                    cleanup();
                    resolve();
                }
            };

            input.on("keypress", onKeypress);
            input.on("data", onData);
        });
    }

    /** 切换指定执行记录的思考展开状态 */
    public async toggleTurnExpansion(turnNo: number): Promise<void> {
        const turn = turnHistoryManager.getTurn(turnNo);
        if (!turn) {
            console.log(`\n${colors.yellow}未找到对应的执行记录。${colors.reset}\n`);
            return;
        }

        const isNowExpanded = turnHistoryManager.toggleExpanded(turnNo);
        if (!isNowExpanded) {
            console.log(`\n${colors.gray}▸ 思考过程已折叠收起${colors.reset}\n`);
            return;
        }

        console.log(`\n${colors.cyan}╭──────────────────────── 思考详情 (${formatDuration(turn.thinkingDurationMs)}) ────────────────────────╮${colors.reset}`);
        if (turn.thinkingText) {
            console.log(turn.thinkingText);
        } else {
            console.log(`${colors.gray}(此记录没有思考内容)${colors.reset}`);
        }
        console.log(`${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);

        await this.waitForKey("▶ 按任意键折叠收起思考详情...");
        turnHistoryManager.toggleExpanded(turnNo);
        console.log(`${colors.gray}▸ 思考过程已折叠收起${colors.reset}\n`);
    }

    /** 展开展示某工具的完整参数与返回响应 */
    private async showToolDetail(tool: ToolCallDetail): Promise<void> {
        console.log(`
${colors.cyan}╭───────────────────────────── 工具响应详情 ─────────────────────────────╮${colors.reset}
  ${colors.white}${colors.bold}工具名称:${colors.reset} ${colors.green}${tool.name}${colors.reset}
  ${colors.white}${colors.bold}调用编号:${colors.reset} ${colors.gray}${tool.id}${colors.reset}
  ${colors.white}${colors.bold}执行耗时:${colors.reset} ${tool.durationMs ? formatDuration(tool.durationMs) : "未知"}
  ${colors.white}${colors.bold}执行状态:${colors.reset} ${tool.isError ? colors.red + "失败 ✗" : colors.green + "成功 ✔"}${colors.reset}

  ${colors.white}${colors.bold}输入参数:${colors.reset}
${colors.gray}${JSON.stringify(tool.args, null, 2)}${colors.reset}

  ${colors.white}${colors.bold}响应结果 (Response Content):${colors.reset}
${colors.cyan}────────────────────────────────────────────────────────────────────────${colors.reset}`);

        let resStr = "";
        if (typeof tool.result === "string") {
            resStr = tool.result;
        } else if (tool.result !== undefined && tool.result !== null) {
            resStr = JSON.stringify(tool.result, null, 2);
        } else {
            resStr = "(无返回值)";
        }

        console.log(resStr);
        console.log(`${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);

        await this.waitForKey("按任意键返回工具列表...");
    }

    /** 展开执行记录中的工具调用与响应 */
    private async inspectToolCalls(turn: TurnRecord): Promise<void> {
        if (turn.toolCalls.length === 0) {
            console.log(`\n${colors.yellow}此执行记录没有工具调用。${colors.reset}\n`);
            await this.waitForKey();
            return;
        }

        while (true) {
            const items: SelectItem<number>[] = turn.toolCalls.map((tc, idx) => {
                const status = tc.isError ? "失败" : "成功";
                const time = tc.durationMs ? `${formatDuration(tc.durationMs)}` : "";
                return {
                    label: `● ${tc.name}`,
                    value: idx,
                    hint: `${status} ${time} · Enter 查看完整响应`
                };
            });

            items.push({
                label: "↩ 返回上级",
                value: -1
            });

            const chosen = await interactiveSelect(
                items,
                `工具响应集合 (共 ${turn.toolCalls.length} 项)`
            );

            if (chosen === null || chosen === -1) {
                break;
            }

            const tool = turn.toolCalls[chosen];
            if (tool) {
                await this.showToolDetail(tool);
            }
        }
    }

    /** 展开执行记录的思考、说明和工具详情 */
    public async inspectTurn(turn: TurnRecord): Promise<void> {
        while (true) {
            const items: SelectItem<string>[] = [
                {
                    label: "🧠 查看完整思考过程",
                    value: "thinking",
                    hint: `${formatDuration(turn.thinkingDurationMs)} · ${turn.thinkingText.length} 字符`
                }
            ];

            if (turn.intermediateText) {
                items.push({
                    label: "💬 查看中间发言说明",
                    value: "intermediate",
                    hint: turn.intermediateText.slice(0, 30) + "..."
                });
            }

            items.push({
                label: "🛠️ 查看工具调用集合与响应",
                value: "tools",
                hint: `${turn.toolCalls.length} 个工具调用`
            });

            items.push({
                label: "↩ 返回执行记录列表",
                value: "back"
            });

            const choice = await interactiveSelect(
                items,
                "执行详情"
            );

            if (choice === null || choice === "back") {
                break;
            }

            if (choice === "thinking") {
                console.log(`
${colors.cyan}╭──────────────────────── 完整思考过程 ────────────────────────╮${colors.reset}
${colors.gray}${turn.thinkingText || "(此记录没有思考内容)"}${colors.reset}
${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);
                await this.waitForKey("按任意键收起思考过程...");
            } else if (choice === "intermediate") {
                console.log(`
${colors.magenta}╭──────────────────────── 中间发言说明 ────────────────────────╮${colors.reset}
${renderMarkdown(turn.intermediateText || "")}
${colors.magenta}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);
                await this.waitForKey("按任意键收起发言说明...");
            } else if (choice === "tools") {
                await this.inspectToolCalls(turn);
            }
        }
    }

    /** 打开思考与工具执行记录检查器 */
    public async open(targetTurnNo?: number): Promise<void> {
        const turns = turnHistoryManager.getTurns();
        if (turns.length === 0) {
            console.log(`\n${colors.yellow}当前会话暂无执行记录。${colors.reset}\n`);
            return;
        }

        if (targetTurnNo !== undefined) {
            const matched = turnHistoryManager.getTurn(targetTurnNo);
            if (matched) {
                await this.inspectTurn(matched);
                return;
            }
            console.log(`\n${colors.yellow}未找到对应的执行记录。${colors.reset}\n`);
        }

        // 若仅有 1 轮，直接进入该轮
        if (turns.length === 1) {
            await this.inspectTurn(turns[0]);
            return;
        }

        while (true) {
            const items: SelectItem<number>[] = turns.map((t) => ({
                label: t.toolCalls.slice(0, 2).map(tool => tool.name).join(" · ") || (t.intermediateText ? "助手回复" : "模型思考"),
                value: t.turnNo,
                hint: `思考 ${formatDuration(t.thinkingDurationMs)} · ${t.toolCalls.length} 个工具调用`
            }));

            items.push({
                label: "✕ 退出检查器",
                value: -1
            });

            const selectedTurnNo = await interactiveSelect(
                items,
                "选择要查看的执行记录"
            );

            if (selectedTurnNo === null || selectedTurnNo === -1) {
                break;
            }

            const record = turnHistoryManager.getTurn(selectedTurnNo);
            if (record) {
                await this.inspectTurn(record);
            }
        }
    }
}

export const turnInspector = new TurnInspector();
