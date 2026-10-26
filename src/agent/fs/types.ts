/** 换行风格类型定义 */
export type EolType = "LF" | "CRLF";

/** 文件观察记录快照元数据 */
export interface FileObservationRecord {
    hash: string;
    observedAt: number;
    eol: EolType;
    size: number;
}

/** 修改前置校验结果 */
export interface MutationVerificationResult {
    allowed: boolean;
    reason?: string;
    isNewFile?: boolean;
    observed?: FileObservationRecord;
}
