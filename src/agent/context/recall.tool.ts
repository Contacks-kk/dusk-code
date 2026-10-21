import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ContextStore } from "./store";
import { estimateTokenCount } from "./token";
import { renderContextSources } from "./summarizer";

const params = Type.Object({
    mode: Type.Union([Type.Literal("search"), Type.Literal("read")]),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    turnId: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String({ maxLength: 2048 }))
}, { additionalProperties: false });

/** 提取不超过指定 Token 数的原文片段 */
export function boundedText(text: string, tokens: number): string {
    let low = 0, high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateTokenCount(text.slice(0, middle)) <= tokens) low = middle;
        else high = middle - 1;
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
    return text.slice(0, low);
}

/** 创建只允许访问当前会话归档的分页回查工具 */
export function createRecallTool(store: ContextStore): AgentTool<typeof params> {
    return { name: "recall_context", label: "回查历史原文", description:
        "搜索或读取本会话已压缩/裁剪的历史快照。search 用关键词找来源，read 用 sourceRef 分页读取。需要精确错误、命令、约束或代码时先回查；历史快照不代表当前状态。",
        parameters: params,
        /** 根据会话绑定的来源或关键词读取有界历史内容 */
        async execute(_id, input, signal) {
            signal?.throwIfAborted();
            try {
                const cursor = input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) : {};
                if (cursor.mode && (cursor.mode !== input.mode || cursor.ref !== input.sourceRef || cursor.query !== input.query || cursor.turnId !== input.turnId)) {
                    throw new Error("游标与当前回查条件不一致");
                }
                if (!Number.isSafeInteger(cursor.offset ?? 0) || (cursor.offset ?? 0) < 0) throw new Error("无效回查游标");
                if (!Number.isSafeInteger(cursor.sourceOffset ?? 0) || (cursor.sourceOffset ?? 0) < 0) throw new Error("无效搜索游标");
                let payload: any;
                if (input.mode === "read") {
                    if (!input.sourceRef) throw new Error("read 必须指定 sourceRef");
                    const messages = await store.readSources([input.sourceRef]);
                    if (!messages.length) throw new Error("当前会话中没有该来源");
                    const text = renderContextSources(messages);
                    if (cursor.hash && cursor.hash !== messages[0].contextSource!.hash) throw new Error("来源已变化，请从首页重新读取");
                    const offset = cursor.offset ?? 0;
                    const page = boundedText(text.slice(offset), 1600);
                    payload = { sourceRef: input.sourceRef, historical: true, timestamp: messages[0].timestamp,
                        text: page, truncated: offset + page.length < text.length };
                    if (payload.truncated) payload.nextCursor = Buffer.from(JSON.stringify({ mode: input.mode, ref: input.sourceRef,
                        offset: offset + page.length, hash: messages[0].contextSource!.hash })).toString("base64url");
                } else {
                    if (!input.query?.trim()) throw new Error("search 必须指定 query");
                    const result = await store.search(input.query.trim(), input.turnId, cursor.offset ?? 0, cursor.sourceOffset ?? 0);
                    payload = { historical: true, truncated: result.nextCursor !== undefined, matches: result.messages.slice(0, 5).map(message => {
                        const text = renderContextSources([message]);
                        const hit = text.toLocaleLowerCase().indexOf(input.query!.trim().toLocaleLowerCase());
                        return { sourceRef: message.contextSource!.ref, timestamp: message.timestamp, truncated: true,
                            excerpt: boundedText(text.slice(Math.max(0, hit - 100)), 180) };
                    }) };
                    if (result.nextCursor !== undefined) payload.nextCursor = Buffer.from(JSON.stringify({ mode: input.mode, query: input.query,
                        turnId: input.turnId, offset: result.nextCursor, sourceOffset: result.nextSourceOffset ?? 0 })).toString("base64url");
                }
                signal?.throwIfAborted();
                return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
            } catch (error) {
                signal?.throwIfAborted();
                const text = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text }], details: { error: text } };
            }
        }
    };
}
