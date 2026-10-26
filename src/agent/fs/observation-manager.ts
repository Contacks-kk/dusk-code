import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeContentHash, detectEol } from "./atomic-io";
import type { FileObservationRecord, MutationVerificationResult } from "./types";

/** 会话级文件观察账本与版本冲突管理器 */
export class FileObservationManager {
    private readonly sessionObservations = new Map<number, Map<string, FileObservationRecord>>();

    /** 规范化路径用于统一映射与跨平台路径匹配 */
    private normalizePath(filePath: string): string {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }

    /** 获取或初始化会话的专属观察快照表 */
    private getSessionMap(sessionId: number): Map<string, FileObservationRecord> {
        let map = this.sessionObservations.get(sessionId);
        if (!map) {
            map = new Map<string, FileObservationRecord>();
            this.sessionObservations.set(sessionId, map);
        }
        return map;
    }

    /** 记录模型在指定会话中对文件的读取观察快照 */
    public recordObservation(sessionId: number, filePath: string, content: string): FileObservationRecord {
        const key = this.normalizePath(filePath);
        const map = this.getSessionMap(sessionId);

        const record: FileObservationRecord = {
            hash: computeContentHash(content),
            observedAt: Date.now(),
            eol: detectEol(content),
            size: Buffer.byteLength(content, "utf-8")
        };

        map.set(key, record);
        return record;
    }

    /** 校验指定会话是否被允许对目标文件执行写入修改 */
    public async verifyMutation(sessionId: number, filePath: string): Promise<MutationVerificationResult> {
        const key = this.normalizePath(filePath);
        const map = this.getSessionMap(sessionId);
        const observed = map.get(key);

        let currentContent: string;
        try {
            // 读取磁盘物理文件当前最新内容
            currentContent = await fs.readFile(filePath, "utf-8");
        } catch {
            // 目标文件物理上尚不存在，属于新建文件，无需前置观察记录
            return {
                allowed: true,
                isNewFile: true
            };
        }

        // 1. 目标文件存在，但当前会话从未读取观察过
        if (!observed) {
            return {
                allowed: false,
                reason: `安全防护拒绝：文件 [${filePath}] 已存在，但在本次修改前从未调用 read_file 查阅过其真实代码。请先调用 read_file 阅读代码后再执行修改。`
            };
        }

        // 2. 目标文件当前哈希与观察时记录不一致（检测到版本漂移）
        const currentHash = computeContentHash(currentContent);
        if (currentHash !== observed.hash) {
            return {
                allowed: false,
                reason: `版本冲突拦截：文件 [${filePath}] 自上一次读取后已被外部或其他流程修改（内容哈希不匹配）。为避免改写冲突，请重新调用 read_file 获取最新源码后再进行修改。`,
                observed
            };
        }

        return {
            allowed: true,
            isNewFile: false,
            observed
        };
    }

    /** 清理指定会话的观察快照释放内存 */
    public clearSession(sessionId: number): void {
        this.sessionObservations.delete(sessionId);
    }
}

export const fileObservationManager = new FileObservationManager();
