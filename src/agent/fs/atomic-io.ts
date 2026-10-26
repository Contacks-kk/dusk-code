import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { EolType } from "./types";

/** 检测文本的主导换行风格 */
export function detectEol(content: string): EolType {
    const crlfCount = (content.match(/\r\n/g) || []).length;
    const lfCount = (content.match(/[^\r]\n/g) || []).length;
    return crlfCount > lfCount ? "CRLF" : "LF";
}

/** 将文本换行符转换为目标风格 */
export function convertEol(content: string, targetEol: EolType): string {
    const normalized = content.replace(/\r\n/g, "\n");
    if (targetEol === "CRLF") {
        return normalized.replace(/\n/g, "\r\n");
    }
    return normalized;
}

/** 计算文件内容的 SHA-256 哈希值 */
export function computeContentHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

/** 同文件写操作路径互斥队列池 */
export class PathMutexPool {
    private readonly locks = new Map<string, Promise<void>>();

    /** 规范化路径键以兼容不同操作系统的大小写敏感策略 */
    private normalizeKey(filePath: string): string {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }

    /** 锁定指定路径并串行执行异步回调 */
    public async runExclusive<T>(filePath: string, action: () => Promise<T>): Promise<T> {
        const key = this.normalizeKey(filePath);
        const currentLock = this.locks.get(key) ?? Promise.resolve();

        let releaseLock: () => void = () => {};
        const nextLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });

        // 串联新的锁句柄
        this.locks.set(key, currentLock.then(() => nextLock));

        try {
            await currentLock;

            // 执行受互斥锁保护的操作
            return await action();
        } finally {
            releaseLock();
            if (this.locks.get(key) === nextLock) {
                this.locks.delete(key);
            }
        }
    }
}

export const pathMutexPool = new PathMutexPool();

export interface AtomicWriteOptions {
    targetEol?: EolType;
    preserveExistingEol?: boolean;
}

export interface AtomicWriteResult {
    bytesWritten: number;
    lineCount: number;
    eol: EolType;
}

/** 具备同文件串行化、换行习惯自适应与原子替换的文件写入器 */
export async function atomicWriteFile(
    resolvedPath: string,
    content: string,
    options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
    return await pathMutexPool.runExclusive(resolvedPath, async () => {
        let finalEol: EolType = options.targetEol ?? "LF";

        // 若需要保留原文件换行风格，在覆写前先探测已有文件
        if (options.preserveExistingEol) {
            try {
                const existing = await fs.readFile(resolvedPath, "utf-8");
                finalEol = detectEol(existing);
            } catch {
                // 目标文件不存在时保持目标风格
            }
        }

        const adaptedContent = convertEol(content, finalEol);
        const dirname = path.dirname(resolvedPath);

        // 确保上级目录存在
        await fs.mkdir(dirname, {
            recursive: true
        });

        // 在同目录下创建隐藏临时文件以确保处于同一物理挂载点
        const randomSuffix = Math.random().toString(36).slice(2, 8);
        const tempPath = path.join(
            dirname,
            `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${randomSuffix}.tmp`
        );

        try {
            // 写入临时文件
            await fs.writeFile(tempPath, adaptedContent, "utf-8");

            // 执行内核级原子重命名替换
            await fs.rename(tempPath, resolvedPath);

            const lines = adaptedContent.split(/\r?\n/);
            return {
                bytesWritten: Buffer.byteLength(adaptedContent, "utf-8"),
                lineCount: lines.length,
                eol: finalEol
            };
        } catch (error) {
            // 异常时尽力清理临时文件
            await fs.unlink(tempPath).catch(() => undefined);
            throw error;
        }
    });
}
