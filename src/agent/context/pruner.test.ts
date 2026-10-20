import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneHistoryContext, CONTEXT_LIMITS } from "./pruner";
import { estimateHistoryTokens } from "./token";

/** 构造 CJK 填充文本：按估算器约 0.7 token/字 */
const cjk = (tokens: number): string => "语".repeat(Math.ceil(tokens / 0.7));

/** 构造一条 tool_result 消息，result 为指定 token 量的 CJK 文本 */
const toolResultMessage = (resultTokens: number, id = "call_1") => ({
    id: Math.floor(Math.random() * 1e9),
    turnId: 1,
    role: "tool_result",
    content: JSON.stringify({ tool: "read_file", id, result: cjk(resultTokens), isError: false })
});

const textMessage = (role: string, tokens: number) => ({
    id: Math.floor(Math.random() * 1e9),
    turnId: 1,
    role,
    content: cjk(tokens)
});

const turnItem = (turnNo: number, messages: any[]) => ({
    turn: { id: turnNo, sessionId: 1, turnNo },
    messages
});

test("低于软水位：原样返回，不做任何改动", () => {
    const history = [
        turnItem(1, [textMessage("user", 500), textMessage("assistant", 500)]),
        turnItem(2, [textMessage("user", 1000)])
    ];
    const result = pruneHistoryContext(history, 100);
    assert.equal(result, history, "未触发裁剪时应返回原数组引用");
    assert.ok(estimateHistoryTokens(history) + 100 <= CONTEXT_LIMITS.TRIGGER_TOKENS, "前置条件：总用量低于软水位");
});

test("超过软水位：压缩超大 tool_result，且不污染原 history", () => {
    const bigToolResult = toolResultMessage(60000);
    const filler = textMessage("assistant", 55000);
    const history = [turnItem(1, [bigToolResult, filler])];
    assert.ok(estimateHistoryTokens(history) > CONTEXT_LIMITS.TRIGGER_TOKENS, "前置条件：总用量超过软水位");
    assert.ok(estimateHistoryTokens([turnItem(1, [bigToolResult])]) > CONTEXT_LIMITS.OVERSIZED_TOOL_RESULT_TOKENS, "前置条件：tool_result 超过压缩阈值");

    const originalContent = bigToolResult.content;
    const result = pruneHistoryContext(history, 0);

    assert.notEqual(result, history, "触发裁剪后应返回新数组");
    assert.equal(result.length, history.length, "未超过硬水位时不应丢弃轮次");
    const compacted = result[0].messages[0].content;
    assert.notEqual(compacted, originalContent, "超大 tool_result 应被压缩");
    assert.ok(compacted.includes("历史超长输出已紧凑压缩"), "压缩内容应带标记");
    assert.ok(estimateHistoryTokens(result) + 0 < estimateHistoryTokens(history), "压缩后总用量应下降");
    assert.equal(history[0].messages[0].content, originalContent, "原 history 对象不得被就地修改");
});

test("超过硬水位：从最旧轮次开始整轮丢弃，永远保留最新一轮", () => {
    // 两轮各约 70K token，总量约 140K > 128K 硬上限；内容非 tool_result，压缩无效
    const history = [
        turnItem(1, [textMessage("user", 70000)]),
        turnItem(2, [textMessage("user", 70000)])
    ];
    assert.ok(estimateHistoryTokens(history) > CONTEXT_LIMITS.MAX_CONTEXT_TOKENS, "前置条件：总用量超过硬水位");

    const result = pruneHistoryContext(history, 0);

    assert.equal(result.length, 1, "应丢弃最旧的一轮");
    assert.equal(result[0].turn.turnNo, 2, "保留的必须是最新一轮");
    assert.ok(estimateHistoryTokens(result) + 0 <= CONTEXT_LIMITS.MAX_CONTEXT_TOKENS, "保留内容应低于硬水位");
});

test("inputTokens 参与水位计算：历史 109K + 输入 5K 应触发压缩", () => {
    const bigToolResult = toolResultMessage(60000);
    // 历史本身约 109K，低于软水位；加上 5K 本轮输入后越过软水位
    const history = [turnItem(1, [bigToolResult, textMessage("assistant", 49000)])];
    const historyTokens = estimateHistoryTokens(history);
    assert.ok(historyTokens < CONTEXT_LIMITS.TRIGGER_TOKENS, "前置条件：历史本身低于软水位");
    assert.ok(historyTokens + 5000 > CONTEXT_LIMITS.TRIGGER_TOKENS, "前置条件：加入输入后越过软水位");

    const withoutInput = pruneHistoryContext(history, 0);
    assert.equal(withoutInput, history, "不加输入时不应触发裁剪");

    const withInput = pruneHistoryContext(history, 5000);
    assert.notEqual(withInput, history, "加入输入后应触发裁剪");
    assert.ok(withInput[0].messages[0].content.includes("历史超长输出已紧凑压缩"), "触发后应压缩超大 tool_result");
});
