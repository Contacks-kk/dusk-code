import * as readline from "node:readline";
import { colors, formatDuration } from "./theme";
import { turnHistoryManager, type TurnRecord, type ToolCallDetail } from "./turn-history";
import { interactiveSelect, type SelectItem } from "./interactive-prompt";
import { renderMarkdown } from "./markdown";
import { mouseTracker } from "./mouse-tracker";
import { imageArchiveReplacer } from "../utils/image";

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
            resStr = JSON.stringify(tool.result, imageArchiveReplacer, 2);
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

            if (turn.execution?.skills) {
                items.push({
                    label: "查看技能加载与视觉反馈",
                    value: "skills",
                    hint: `${turn.execution.skills.snapshots.filter(item => item.status === "loaded").length} 个已加载技能`
                });
            }

            items.push({
                label: "🛠️ 查看工具调用集合与响应",
                value: "tools",
                hint: `${turn.toolCalls.length} 个工具调用`
            });
            items.push({
                label: "查看任务验收与续修证据",
                value: "delivery",
                hint: turn.execution?.delivery?.status ?? "无验收记录"
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
            } else if (choice === "skills") {
                this.showSkills(turn);
                await this.waitForKey("按任意键返回执行详情...");
            } else if (choice === "delivery") {
                this.showDelivery(turn);
                await this.waitForKey("按任意键返回执行详情...");
            }
        }
    }

    /** 展示实际验收结果，旧执行记录不追溯认定为通过 */
    private showDelivery(turn: TurnRecord): void {
        const delivery = turn.execution?.delivery;
        if (!delivery) {
            console.log("\n无验收记录\n");
            return;
        }
        console.log(`\n任务 ${delivery.taskId}；验收 ${delivery.status}；续修 ${delivery.repairRounds}/3`);
        console.log(`要求版本 ${delivery.contract.version}；停止原因：${delivery.stoppedReason ?? "无"}`);
        for (const check of delivery.contract.checks) {
            console.log(`${check.id} [${check.status}] ${check.title}${check.required ? "（必验）" : ""}：${check.feedback ?? check.expected}`);
        }
        for (const proof of delivery.evidence) {
            console.log(`${proof.checkId} ${proof.kind} ${proof.success ? "证据支持通过" : "证据显示未通过"}；源码 ${proof.codeHash}；证据 ${proof.artifactPath}；SHA256 ${proof.hash}`);
        }
        console.log(`内部续修指令 ${delivery.continuations.length} 条；要求变更：${JSON.stringify(delivery.contract.changes)}`);
    }

    /** 展示技能选择、真实操作与视觉反馈证据 */
    private showSkills(turn: TurnRecord): void {
        const record = turn.execution?.skills;
        if (!record) {
            return;
        }
        console.log(`\n技能选择：${record.selection.status}${record.selection.error ? `；失败：${record.selection.error}` : ""}`);
        for (const selected of record.selection.skills) {
            console.log(`自动选择 ${selected.name}：${selected.reason}`);
        }
        for (const item of record.selection.coverage ?? []) {
            console.log(`产出 ${item.output}：${item.skills.join("、") || item.reason}`);
        }
        for (const snapshot of record.snapshots) {
            console.log(`\n${snapshot.name}：${snapshot.status === "loaded" ? "正文已加载" : "预算不足未加载"} [${snapshot.origin}/${snapshot.source}]`);
            console.log(`来源：${snapshot.skillMdPath}\n根目录：${snapshot.skillDir}\nSHA256：${snapshot.hash}`);
            if (snapshot.missingDependencies?.length) {
                console.log(`未安装的引用技能：${snapshot.missingDependencies.join("、")}`);
            }
        }
        for (const failure of record.failures) {
            console.log(`加载失败 ${failure.name}：${failure.error}`);
        }
        const labels = {
            not_required: "本轮未要求视觉验收",
            pending: "视觉反馈待完成",
            feedback_received: "模型已接收最新截图并返回正文，验收结论需核对响应",
            incomplete: "视觉未验收"
        };
        console.log(`\n视觉反馈：${labels[record.visual.status]}${record.visual.reason ? `；${record.visual.reason}` : ""}`);
        console.log("实际操作记录：");
        for (const event of record.events) {
            console.log(`${new Date(event.timestamp).toLocaleTimeString()} ${event.kind} ${event.success ? "成功" : "失败"} ${event.name ?? ""} ${event.path ?? ""} ${event.toolCallId ?? ""} ${event.detail ?? ""}`);
        }
        const diagnostics = turn.execution?.auxiliaryRequests?.filter(item => item.purpose === "skill_selection") ?? [];
        console.log(`\n技能选择请求统计：${JSON.stringify(diagnostics, null, 2)}`);
        console.log("正文加载及图片反馈均不直接代表整个技能工作流或界面验收通过。\n");
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
