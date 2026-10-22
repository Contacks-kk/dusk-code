import type { SkillMetadata } from "./types";

/** 解析 YAML Frontmatter 中的键值对映射 */
function parseYamlMap(rawYaml: string): Record<string, any> {
    const lines = rawYaml.split(/\r?\n/);
    const result: Record<string, any> = {};
    let currentKey = "";
    let isMultiLine = false;
    let multiLineContent: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        // 处理多行文本读取状态
        if (isMultiLine) {
            if (/^[a-zA-Z0-9_-]+:/.test(trimmed)) {
                // 遇到新的顶级 key，结算前一个多行
                result[currentKey] = multiLineContent.join(" ").trim();
                isMultiLine = false;
                multiLineContent = [];
            } else {
                multiLineContent.push(trimmed);
                continue;
            }
        }

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
            continue;
        }

        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();

        // 支持多行语法：`description: >-` 或 `description: |`
        if (value === ">-" || value === ">" || value === "|") {
            currentKey = key;
            isMultiLine = true;
            multiLineContent = [];
            continue;
        }

        // 去除字符串两侧可能存在的引号
        const unquoted = value.replace(/^["']|["']$/g, "").trim();
        result[key] = unquoted;
    }

    if (isMultiLine && currentKey) {
        result[currentKey] = multiLineContent.join(" ").trim();
    }

    return result;
}

/** 解析 SKILL.md 文件并分离 Frontmatter 元数据与正文内容 */
export function parseSkillMarkdown(rawContent: string, fallbackName: string): {
    metadata: SkillMetadata;
    content: string;
} {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = frontmatterRegex.exec(rawContent.trim());

    if (!match) {
        return {
            metadata: {
                name: fallbackName,
                description: rawContent.slice(0, 150).replace(/[\r\n#]+/g, " ").trim()
            },
            content: rawContent
        };
    }

    const rawYaml = match[1];
    const markdownContent = match[2];
    const parsedObj = parseYamlMap(rawYaml);

    // 格式化解析后的 tags 列表
    let tags: string[] | undefined = undefined;
    if (parsedObj.tags) {
        tags = String(parsedObj.tags)
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean);
    }

    const metadata: SkillMetadata = {
        name: parsedObj.name || fallbackName,
        description: parsedObj.description || "无描述",
        tags,
        author: parsedObj.author,
        version: parsedObj.version,
        argumentHint: parsedObj["argument-hint"] || parsedObj.argumentHint
    };

    return {
        metadata,
        content: markdownContent
    };
}
