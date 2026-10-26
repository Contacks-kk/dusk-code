/** 截取完整 UTF-8 字符组成的前缀 */
export function utf8Head(text: string, bytes: number): string {
    const buffer = Buffer.from(text);
    let end = Math.max(0, Math.min(buffer.length, bytes));
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
        end--;
    }
    return buffer.subarray(0, end).toString("utf8");
}

/** 截取完整 UTF-8 字符组成的后缀 */
export function utf8Tail(text: string, bytes: number): string {
    const buffer = Buffer.from(text);
    let start = Math.max(0, buffer.length - Math.max(0, bytes));
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
        start++;
    }
    return buffer.subarray(start).toString("utf8");
}

/** 计算序列化结果占用的 UTF-8 字节数 */
export function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}
