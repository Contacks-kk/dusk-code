import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const timeParams = Type.Object({
    timezone: Type.Optional(Type.String({ description: "时区名称，例如 Asia/Shanghai，默认使用本地时区" }))
});

/** 当前时间查询工具 */
export const currentTimeTool: AgentTool<typeof timeParams> = {
    name: "get_current_time",
    label: "当前时间查询",
    description: "获取系统当前的精确日期和时间。当用户询问时间、今天几号、周几等问题时使用该工具。",
    parameters: timeParams,
    /** 执行当前时间获取操作 */
    execute: async (toolCallId, params) => {
        const now = new Date();
        const formatted = now.toLocaleString("zh-CN", { timeZone: params.timezone || undefined });
        return {
            content: [{ type: "text", text: `当前时间为：${formatted} (${now.toISOString()})` }],
            details: { time: formatted, iso: now.toISOString() }
        };
    }
};
