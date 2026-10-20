import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";

const SUPPORTED_EXTENSIONS: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
};

/** 根据文件扩展名获取图片的 MIME 类型 */
export function getImageMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS[ext] || null;
}

/** 判断目标路径是否为支持的图片文件 */
export function isImageFile(filePath: string): boolean {
    return getImageMimeType(filePath) !== null;
}

/** 读取本地图片文件并包装为 Pi AI 标准 ImageContent */
export async function loadImageAsImageContent(filePath: string): Promise<ImageContent | null> {
    const mimeType = getImageMimeType(filePath);
    if (!mimeType) {
        return null;
    }

    try {
        const fileBuffer = await fs.readFile(filePath);
        const data = fileBuffer.toString("base64");
        return {
            type: "image",
            data,
            mimeType
        };
    } catch {
        return null;
    }
}

/** 从用户输入文本中解析出图片文件路径并提取剩余文本 */
export function extractImagePaths(text: string): { cleanText: string; imagePaths: string[] } {
    // 匹配被引号包裹或裸露的图片路径
    const imagePathRegex = /(?:["']?)([a-zA-Z]:[\\/][^"'\r\n]+?\.(?:png|jpe?g|webp|gif)|(?:\.{1,2}[\\/]|[\\/])[^"'\r\n]+?\.(?:png|jpe?g|webp|gif)|[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif))(?:["']?)/gi;

    const imagePaths: string[] = [];
    let cleanText = text;

    let match: RegExpExecArray | null;
    while ((match = imagePathRegex.exec(text)) !== null) {
        const potentialPath = match[1];
        if (isImageFile(potentialPath)) {
            imagePaths.push(potentialPath);
            cleanText = cleanText.replace(match[0], "").trim();
        }
    }

    return { cleanText, imagePaths };
}
