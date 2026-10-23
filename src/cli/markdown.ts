import stringWidth from "string-width";
import { getTerminalWidth, truncateTerminalText, wrapTerminalText } from "./terminal-layout";

export const mdColors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    strikethrough: "\x1b[9m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    brightYellow: "\x1b[93m",
    brightCyan: "\x1b[96m",
    brightWhite: "\x1b[97m"
};

/** 解析行内样式（粗体、斜体、代码、删除线、超链接）并替换为 ANSI 转义符 */
export function formatInline(text: string): string {
    return text
        // 粗体: **text** 或 __text__
        .replace(/\*\*([^*]+)\*\*/g, `${mdColors.bold}$1\x1b[22m`)
        .replace(/__([^_]+)__/g, `${mdColors.bold}$1\x1b[22m`)
        // 行内代码: `code`
        .replace(/`([^`]+)`/g, `${mdColors.cyan}$1${mdColors.reset}`)
        // 斜体: *text* 或 _text_ (避免误伤下划线变量)
        .replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, `$1${mdColors.italic}$2\x1b[23m$3`)
        .replace(/(^|[^_a-zA-Z0-9])_([^_]+)_([^_a-zA-Z0-9]|$)/g, `$1${mdColors.italic}$2\x1b[23m$3`)
        // 删除线: ~~text~~
        .replace(/~~([^~]+)~~/g, `${mdColors.strikethrough}$1\x1b[29m`)
        // 链接: [text](url)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${mdColors.underline}${mdColors.blue}$1${mdColors.reset} ${mdColors.gray}($2)${mdColors.reset}`);
}

/** 渲染 Unicode 等宽对齐表格 */
function renderTable(tableLines: string[]): string {
    const rawRows = tableLines.map((line) => {
        const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
        return trimmed.split("|").map((c) => c.trim());
    });

    if (rawRows.length === 0) {
        return "";
    }

    /** 识别表头下方的分隔行 */
    const isDivider = (row: string[]) => row.length > 0 && row.every((cell) => /^:?-+:?$/.test(cell.trim()));
    const dividerIndex = rawRows.findIndex(isDivider);
    const dataRows = rawRows.filter((_, idx) => idx !== dividerIndex);

    if (dataRows.length === 0) {
        return "";
    }

    const colCount = Math.max(...dataRows.map((r) => r.length));
    const availableWidth = getTerminalWidth() - (3 * colCount + 3);

    // 极窄窗口逐项展示，避免边框挤占正文空间
    if (availableWidth < colCount * 4) {
        const headers = dividerIndex === -1 ? [] : dataRows[0];
        return dataRows.slice(headers.length ? 1 : 0).map(row => row.map((cell, index) => {
            const label = headers[index] ? `${headers[index]}: ` : "";
            return wrapTerminalText(formatInline(`${label}${cell}`)).join("\n");
        }).join("\n")).join("\n\n");
    }

    // 计算每列最大显示宽度（支持汉字等全角字符）
    const colWidths: number[] = [];
    for (let c = 0; c < colCount; c++) {
        let maxW = 4;
        for (const row of dataRows) {
            const cell = row[c] || "";
            const formatted = formatInline(cell);
            maxW = Math.max(maxW, stringWidth(formatted));
        }
        colWidths[c] = maxW;
    }

    // 优先压缩较宽的列，为每个单元格保留可读空间
    let totalWidth = colWidths.reduce((sum, width) => sum + width, 0);
    while (totalWidth > availableWidth) {
        const widest = colWidths.indexOf(Math.max(...colWidths));
        colWidths[widest]--;
        totalWidth--;
    }

    const topBorder = "  ┌─" + colWidths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
    const midBorder = "  ├─" + colWidths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
    const botBorder = "  └─" + colWidths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";

    const lines: string[] = [];
    lines.push(`${mdColors.gray}${topBorder}${mdColors.reset}`);

    dataRows.forEach((row, rowIdx) => {
        const wrappedCells: string[][] = [];
        for (let c = 0; c < colCount; c++) {
            const cell = row[c] || "";
            wrappedCells.push(wrapTerminalText(formatInline(cell), colWidths[c]));
        }

        const isHeader = dividerIndex !== -1 && rowIdx === 0;
        const rowHeight = Math.max(...wrappedCells.map(cell => cell.length));
        for (let lineNo = 0; lineNo < rowHeight; lineNo++) {
            const lineContent = wrappedCells.map((cell, index) => {
                const part = cell[lineNo] || "";
                const padded = part + " ".repeat(Math.max(0, colWidths[index] - stringWidth(part)));
                return isHeader ? `${mdColors.bold}${padded}${mdColors.reset}` : `${padded}${mdColors.reset}`;
            }).join(` ${mdColors.gray}│${mdColors.reset} `);
            lines.push(`  ${mdColors.gray}│${mdColors.reset} ${lineContent} ${mdColors.gray}│${mdColors.reset}`);
        }

        if (isHeader) {
            lines.push(`${mdColors.gray}${midBorder}${mdColors.reset}`);
        }
    });

    lines.push(`${mdColors.gray}${botBorder}${mdColors.reset}`);
    return lines.join("\n");
}

/** 渲染带语言标识的边框代码块 */
function renderCodeBlock(lang: string, codeLines: string[]): string {
    const width = Math.min(80, getTerminalWidth());
    if (width < 8) {
        return codeLines.flatMap(line => wrapTerminalText(line)).join("\n");
    }
    const langLabel = truncateTerminalText(lang.trim() ? ` ${lang.trim()} ` : "", width - 4);
    const topBar = "  ┌" + langLabel + "─".repeat(width - 4 - stringWidth(langLabel)) + "┐";
    const botBar = "  └" + "─".repeat(width - 4) + "┘";

    const result: string[] = [];
    result.push(`${mdColors.gray}${topBar}${mdColors.reset}`);

    for (const line of codeLines) {
        for (const part of wrapTerminalText(line, width - 6)) {
            const padded = part + " ".repeat(Math.max(0, width - 6 - stringWidth(part)));
            result.push(`  ${mdColors.gray}│${mdColors.reset} ${mdColors.white}${padded}${mdColors.reset} ${mdColors.gray}│${mdColors.reset}`);
        }
    }

    result.push(`${mdColors.gray}${botBar}${mdColors.reset}`);
    return result.join("\n");
}

/** 核心 Markdown 解析与美化渲染调度器 */
export function renderMarkdown(markdown: string): string {
    if (!markdown) {
        return "";
    }

    const lines = markdown.split(/\r?\n/);
    const output: string[] = [];

    let inCodeBlock = false;
    let codeBlockLang = "";
    let codeBlockLines: string[] = [];

    let tableBuffer: string[] = [];

    /** 输出已收集的表格行 */
    const flushTable = () => {
        if (tableBuffer.length > 0) {
            output.push(renderTable(tableBuffer));
            tableBuffer = [];
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // 1. 代码块起始与结束检测
        if (trimmed.startsWith("```")) {
            flushTable();
            if (inCodeBlock) {
                output.push(renderCodeBlock(codeBlockLang, codeBlockLines));
                codeBlockLines = [];
                codeBlockLang = "";
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
                codeBlockLang = trimmed.slice(3).trim();
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockLines.push(line);
            continue;
        }

        // 2. 表格收集
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            tableBuffer.push(trimmed);
            continue;
        } else {
            flushTable();
        }

        // 3. 标题解析 (# ~ ######)
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const headingText = formatInline(headingMatch[2].trim());
            if (level === 1) {
                output.push(`\n  ${mdColors.bold}${mdColors.brightCyan}━━━ ${headingText} ━━━${mdColors.reset}`);
            } else if (level === 2) {
                output.push(`\n  ${mdColors.bold}${mdColors.brightYellow}● ${headingText}${mdColors.reset}`);
            } else if (level === 3) {
                output.push(`\n  ${mdColors.bold}${mdColors.white}■ ${headingText}${mdColors.reset}`);
            } else {
                output.push(`\n  ${mdColors.gray}▸ ${mdColors.bold}${headingText}${mdColors.reset}`);
            }
            continue;
        }

        // 4. 水平分割线
        if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
            output.push(`  ${mdColors.gray}${"─".repeat(Math.max(0, Math.min(61, getTerminalWidth() - 2)))}${mdColors.reset}`);
            continue;
        }

        // 5. 任务清单
        const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
            const indent = taskMatch[1];
            const checked = taskMatch[2].toLowerCase() === "x";
            const icon = checked ? `${mdColors.green}✔${mdColors.reset}` : `${mdColors.gray}□${mdColors.reset}`;
            output.push(`  ${indent}${icon} ${formatInline(taskMatch[3])}`);
            continue;
        }

        // 6. 无序列表
        const unorderListMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (unorderListMatch) {
            const indent = unorderListMatch[1];
            output.push(`  ${indent}${mdColors.cyan}•${mdColors.reset} ${formatInline(unorderListMatch[2])}`);
            continue;
        }

        // 7. 有序列表
        const orderListMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (orderListMatch) {
            const indent = orderListMatch[1];
            const num = orderListMatch[2];
            output.push(`  ${indent}${mdColors.yellow}${num}.${mdColors.reset} ${formatInline(orderListMatch[3])}`);
            continue;
        }

        // 8. 引用块
        const quoteMatch = line.match(/^>\s?(.*)$/);
        if (quoteMatch) {
            output.push(`  ${mdColors.gray}│${mdColors.reset} ${mdColors.italic}${formatInline(quoteMatch[1])}${mdColors.reset}`);
            continue;
        }

        // 9. 普通段落文本
        if (trimmed === "") {
            output.push("");
        } else {
            output.push(`  ${formatInline(line)}`);
        }
    }

    // 处理末尾残留
    flushTable();
    if (inCodeBlock && codeBlockLines.length > 0) {
        output.push(renderCodeBlock(codeBlockLang, codeBlockLines));
    }

    return output.join("\n");
}
