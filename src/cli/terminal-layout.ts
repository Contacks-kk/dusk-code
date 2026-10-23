import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/** 获取终端可用列数，预留末列避免自动折行 */
export function getTerminalWidth(): number {
    return Math.max(1, (process.stdout.columns || 80) - 1);
}

/** 按显示宽度折行并保留文字颜色 */
export function wrapTerminalText(text: string, width = getTerminalWidth()): string[] {
    return wrapAnsi(text.replace(/\t/g, "    "), Math.max(1, width), {
        hard: true,
        wordWrap: false,
        trim: false
    }).split("\n");
}

/** 将单行文字限制在可用列数内并显示省略号 */
export function truncateTerminalText(text: string, width = getTerminalWidth()): string {
    const line = text.replace(/[\r\n\t]+/g, " ");
    if (width <= 0) {
        return "";
    }
    if (stringWidth(line) <= width) {
        return line;
    }
    if (width <= 2) {
        return "…";
    }
    return `${wrapTerminalText(line, Math.max(1, width - 1))[0]}\x1b[0m…`;
}
