import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { loadImageAsImageContent } from "../../../utils/image";

const readImageParams = Type.Object({
    filePath: Type.String({ description: "本地截图或图片路径，支持 PNG、JPEG、WebP、GIF" })
});

/** 将本地图片作为原生多模态内容提供给模型 */
export const readImageTool: AgentTool<typeof readImageParams> = {
    name: "read_image",
    label: "读取图片",
    description: "读取本地截图并将图片本身送入下一次模型请求，用于界面检查和视觉反馈。",
    parameters: readImageParams,
    /** 读取图片原始内容并返回可回放的图片块 */
    execute: async (_toolCallId, params, signal) => {
        signal?.throwIfAborted();
        const filePath = path.resolve(params.filePath);
        const image = await loadImageAsImageContent(filePath);
        signal?.throwIfAborted();
        if (!image) {
            return {
                content: [{ type: "text", text: `图片读取失败或格式不支持：${filePath}` }],
                details: { filePath, error: "图片不可读取或格式不支持" }
            };
        }
        return {
            content: [{ type: "text", text: `图片来源：${filePath}` }, image],
            details: { filePath, mimeType: image.mimeType }
        };
    }
};
