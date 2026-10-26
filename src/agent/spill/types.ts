export interface SpillConfig {
    maxInlineBytes: number;
    maxInlineLines: number;
    headLines: number;
    tailLines: number;
    maxDetailsBytes?: number;
}

export interface CommandOutputContext {
    sessionId: number;
    projectRoot: string;
    toolName: string;
    toolCallId: string;
}

export interface SpillSaveRequest {
    sessionId: number;
    toolName: string;
    toolCallId: string;
    content: string;
    projectRoot: string;
    source?: "result" | "details";
}

export interface SpillRef {
    locator: string;
    relativePath: string;
    absolutePath: string;
    totalBytes: number;
    totalLines: number;
    omittedBytes: number;
    omittedLines: number;
    retrievalHint: string;
    source?: "result" | "details" | "stdout" | "stderr";
    complete?: boolean;
}
