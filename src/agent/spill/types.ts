export interface SpillConfig {
    maxInlineBytes: number;
    maxInlineLines: number;
    headLines: number;
    tailLines: number;
}

export interface SpillSaveRequest {
    sessionId: number;
    toolName: string;
    toolCallId: string;
    content: string;
    projectRoot: string;
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
}
