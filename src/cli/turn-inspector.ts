import * as readline from "node:readline";
import { colors, formatDuration } from "./theme";
import { turnHistoryManager, type TurnRecord, type ToolCallDetail } from "./turn-history";
import { interactiveSelect, type SelectItem } from "./interactive-prompt";
import { renderMarkdown } from "./markdown";

export class TurnInspector {
    /** 等待用户按任意键继续 */
    private async waitForKey(promptText = "按任意键折叠收起..."): Promise<void> {
        if (!process.stdin.isTTY) return;
        return new Promise<void>((resolve) => {
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdout.write(`\n${colors.gray}${promptText}${colors.reset}\n`);

            const cleanup = () => {
                process.stdin.off("keypress", onKeypress);
                process.stdin.off("data", onData);
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
            };

            const onKeypress = () => {
                cleanup();
                resolve();
            };

            const onData = (chunk: Buffer) => {
                const str = chunk.toString("utf-8");
                if (str.length > 0) {
                    cleanup();
                    resolve();
                }
            };

            process.stdin.on("keypress", onKeypress);
            process.stdin.on("data", onData);
        });
    }

    /** 直接就地切换指定轮次的展开与折叠视图 */
    public async toggleTurnExpansion(turnNo: number): Promise<void> {
        const turn = turnHistoryManager.getTurn(turnNo);
        if (!turn) {
            console.log(`\n${colors.yellow}未找到 Turn #${turnNo} 的执行记录。${colors.reset}\n`);
            return;
        }

        const isNowExpanded = turnHistoryManager.toggleExpanded(turnNo);
        if (!isNowExpanded) {
            console.log(`\n${colors.gray}▸ Turn ${turnNo} 思考过程已折叠收起${colors.reset}\n`);
            return;
        }

        console.log(`\n${colors.cyan}╭──────────────────────── Turn ${turn.turnNo} 思考详情 (${formatDuration(turn.thinkingDurationMs)}) ────────────────────────╮${colors.reset}`);
        if (turn.thinkingText) {
            console.log(turn.thinkingText);
        } else {
            console.log(`${colors.gray}(本轮未产生思考记录)${colors.reset}`);
        }
        console.log(`${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);

        await this.waitForKey("▶ 按任意键折叠收起思考详情...");
        turnHistoryManager.toggleExpanded(turnNo);
        console.log(`${colors.gray}▸ Turn ${turnNo} 思考过程已折叠收起${colors.reset}\n`);
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

    /** Level 3: 展开该轮次的工具调用与响应集合 */
    private async inspectToolCalls(turn: TurnRecord): Promise<void> {
        if (turn.toolCalls.length === 0) {
            console.log(`\n${colors.yellow}Turn ${turn.turnNo} 本轮未发生任何工具调用。${colors.reset}\n`);
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
                    hint: `${status} ${time} · 点击展开完整响应`
                };
            });

            items.push({
                label: "↩ 返回上级",
                value: -1
            });

            const chosen = await interactiveSelect(
                items,
                `Turn ${turn.turnNo} 工具响应集合 (共 ${turn.toolCalls.length} 项)`
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

    /** Level 2: 展开指定 Turn 的核心要素集合（思考、说明、工具集合） */
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
                label: "↩ 返回轮次列表",
                value: "back"
            });

            const choice = await interactiveSelect(
                items,
                `Turn ${turn.turnNo} 详情检查器`
            );

            if (choice === null || choice === "back") {
                break;
            }

            if (choice === "thinking") {
                console.log(`
${colors.cyan}╭──────────────────────── Turn ${turn.turnNo} 完整思考链路 ────────────────────────╮${colors.reset}
${colors.gray}${turn.thinkingText || "(本轮未产生思考记录)"}${colors.reset}
${colors.cyan}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);
                await this.waitForKey("按任意键收起思考过程...");
            } else if (choice === "intermediate") {
                console.log(`
${colors.magenta}╭──────────────────────── Turn ${turn.turnNo} 中间发言说明 ────────────────────────╮${colors.reset}
${renderMarkdown(turn.intermediateText || "")}
${colors.magenta}╰────────────────────────────────────────────────────────────────────────╯${colors.reset}`);
                await this.waitForKey("按任意键收起发言说明...");
            } else if (choice === "tools") {
                await this.inspectToolCalls(turn);
            }
        }
    }

    /** Level 1: 打开交互式 Turn 检查器 */
    public async open(targetTurnNo?: number): Promise<void> {
        const turns = turnHistoryManager.getTurns();
        if (turns.length === 0) {
            console.log(`\n${colors.yellow}当前会话暂无执行轮次记录。${colors.reset}\n`);
            return;
        }

        if (targetTurnNo !== undefined) {
            const matched = turnHistoryManager.getTurn(targetTurnNo);
            if (matched) {
                await this.inspectTurn(matched);
                return;
            }
            console.log(`\n${colors.yellow}未找到 Turn #${targetTurnNo} 的执行记录。${colors.reset}\n`);
        }

        // 若仅有 1 轮，直接进入该轮
        if (turns.length === 1) {
            await this.inspectTurn(turns[0]);
            return;
        }

        while (true) {
            const items: SelectItem<number>[] = turns.map((t) => ({
                label: `Turn ${t.turnNo}`,
                value: t.turnNo,
                hint: `思考 ${formatDuration(t.thinkingDurationMs)} · ${t.toolCalls.length} 个工具调用`
            }));

            items.push({
                label: "✕ 退出检查器",
                value: -1
            });

            const selectedTurnNo = await interactiveSelect(
                items,
                "选择要展开查看的 Loop Turn 轮次"
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
