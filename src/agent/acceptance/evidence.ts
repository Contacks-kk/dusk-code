import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { duskDataDirectory } from "../../config/data-directory";
import type { AcceptanceEvidence, DeliveryRecord, EvidenceKind } from "./types";
import { isToolRecord } from "../tools/result";

const IGNORED = new Set([".git", "node_modules", "target", "dist", "build", ".dusk", ".taste-skill", "coverage", ".cache"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|html?|css|scss|less|java|py|go|rs|rb|php|cs|kt|kts|swift|dart|[ch](?:pp)?|sh|bash|zsh|ps1|psm1|cmd|bat|json|ya?ml|toml|xml|sql|properties|gradle|lock|md|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf)$|(?:^|[\\/])Dockerfile$/i;

/** 计算文本或二进制原始内容的哈希 */
export function artifactHash(content: string | Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
}

/** 为可重试断言生成稳定标识，其他成功操作不能覆盖这项失败 */
function operationKey(kind: EvidenceKind, operation: unknown): string {
    if (!operation || typeof operation !== "object") {
        return kind;
    }
    const fields = operation as Record<string, unknown>;
    let url = fields.url;
    if (typeof url === "string" && /^https?:/.test(url)) {
        const parsed = new URL(url);
        url = parsed.pathname + parsed.search;
    }
    const key = Object.fromEntries(Object.entries({ ...fields, url }).filter(([name]) =>
        !["checkId", "env", "port", "id", "timeoutMs", "width", "height"].includes(name)).sort(([left], [right]) => left.localeCompare(right)));
    return artifactHash(kind + redactEvidence(key));
}

/** 只比较实际失败差异，进程编号和临时目录变化不算修复进展 */
function resultDigest(payload: unknown): string {
    if (!isToolRecord(payload)) {
        return artifactHash(redactEvidence(payload));
    }
    const result = {
        actual: payload.actual,
        expected: payload.expected,
        exitCode: payload.exitCode,
        error: payload.error,
        reason: payload.reason,
        response: isToolRecord(payload.response) ? { status: payload.response.status, body: payload.response.body } : undefined,
        stdout: payload.stdout,
        stderr: payload.stderr
    };
    const text = redactEvidence(result).replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, "[临时标识]")
        .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]+/g, "[时间]");
    return artifactHash(text);
}

/** 从展示数据中去掉凭据，同时保留错误结构 */
export function redactEvidence(value: unknown): string {
    return JSON.stringify(value, (key, item) => {
        if (/(?:password|authorization|cookie|token|secret|api[_-]?key)$|^(?:pw|pass)$/i.test(key)) {
            return "[已隐藏]";
        }
        if (item instanceof Error) {
            return item.message;
        }
        if (typeof item === "string") {
            return item.replace(/((?:SMTP_PASSWORD|password|authorization|access_token|token|api[_-]?key)\s*[=:]\s*)[^\s,;"<>]+/gi, "$1[已隐藏]")
                .replace(/("(?:password|pw|pass|authorization|cookie|set-cookie|token|access_token|SMTP_PASSWORD)"\s*:\s*)"[^"\n]*"/gi, '$1"[已隐藏]"');
        }
        return item;
    }) ?? "";
}

/** 收集影响应用实现的文件，跳过依赖、数据与构建产物 */
async function sourceFiles(root: string, prefix = ""): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        if (entry.isSymbolicLink() || IGNORED.has(entry.name) || path.relative(duskDataDirectory(), path.resolve(root, prefix, entry.name)) === "" ||
            (!prefix && entry.isDirectory() && entry.name === "data")) {
            continue;
        }
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
            files.push(...await sourceFiles(root, relative));
        } else if (SOURCE_FILE.test(relative)) {
            files.push(relative);
        }
    }
    return files;
}

/** 生成包含未提交源码的快照，读取失败不能当作源码未变 */
export async function projectSourceHash(root: string): Promise<string> {
    const hash = createHash("sha256");
    for (const file of (await sourceFiles(root)).sort()) {
        hash.update(file.replace(/\\/g, "/") + "\0");
        hash.update(await fs.readFile(path.join(root, file)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

/** 只比较界面源码，识别命令工具间接产生的界面变更 */
export async function projectInterfaceHash(root: string): Promise<string> {
    const hash = createHash("sha256");
    for (const file of (await sourceFiles(root)).filter(file => /\.(?:vue|tsx|jsx|svelte|html?|css|scss|less)$/i.test(file)).sort()) {
        hash.update(file);
        hash.update(await fs.readFile(path.join(root, file)));
    }
    return hash.digest("hex");
}

export class EvidenceStore {
    readonly directory: string;
    private readonly snapshots = new Map<string, string>();

    /** 为任务创建与业务工程分开的证据目录 */
    constructor(private readonly record: DeliveryRecord) {
        if (!/^[\w-]+$/.test(record.taskId)) {
            throw new Error("任务证据标识无效");
        }
        if (path.relative(record.projectRoot, duskDataDirectory()) === "") {
            throw new Error("DUSK_DATA_DIR 不能与业务项目目录相同，请使用独立目录或项目内的专用子目录");
        }
        this.directory = path.join(duskDataDirectory(), "acceptance", record.taskId);
    }

    /** 确保路径位于当前任务的证据目录 */
    resolve(name: string): string {
        const resolved = path.resolve(this.directory, name);
        if (!resolved.startsWith(path.resolve(this.directory) + path.sep)) {
            throw new Error("证据路径不能越过当前任务目录");
        }
        return resolved;
    }

    /** 保存真实操作结果，状态只能由宿主工具产生 */
    async save(kind: EvidenceKind, checkId: string, success: boolean, payload: unknown,
        toolCallId?: string, imagePath?: string, operation?: unknown): Promise<AcceptanceEvidence> {
        if (!this.record.contract.checks.some(check => check.id === checkId)) {
            throw new Error(`未登记的验收项：${checkId}`);
        }
        await fs.mkdir(this.directory, { recursive: true });
        const id = randomUUID();
        const raw = redactEvidence(payload);
        const artifactPath = this.resolve(`${id}.json`);
        await fs.writeFile(artifactPath, raw, "utf8");
        const codeHash = await projectSourceHash(this.record.projectRoot);
        const layout = isToolRecord(payload) && isToolRecord(payload.layout) ? payload.layout : undefined;
        const evidence: AcceptanceEvidence = {
            id,
            checkId,
            kind,
            success,
            isolated: true,
            codeHash,
            contractVersion: this.record.contract.version,
            sourcePath: await this.snapshot(codeHash),
            operationKey: operationKey(kind, operation),
            resultDigest: resultDigest(payload),
            layoutPassed: typeof layout?.horizontalOverflow === "boolean" ? !layout.horizontalOverflow : undefined,
            artifactPath,
            hash: artifactHash(raw),
            timestamp: Date.now(),
            toolCallId,
            imagePath,
            imageHash: imagePath ? artifactHash(await fs.readFile(imagePath)) : undefined,
            summary: raw.slice(0, 1400)
        };
        this.record.evidence.push(evidence);
        const check = this.record.contract.checks.find(item => item.id === checkId);
        if (check) {
            check.status = success ? "awaiting_review" : "failed";
            check.evidenceIds = this.record.evidence.filter(item => item.checkId === checkId && item.codeHash === codeHash).map(item => item.id);
        }
        return evidence;
    }

    /** 按内容版本归档源码，修复后仍能复现上一轮失败位置 */
    private async snapshot(hash: string): Promise<string> {
        const existing = this.snapshots.get(hash);
        if (existing) {
            return existing;
        }
        const directory = this.resolve(path.join("source", hash));
        for (const file of await sourceFiles(this.record.projectRoot)) {
            const target = path.join(directory, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(path.join(this.record.projectRoot, file), target);
        }
        this.snapshots.set(hash, directory);
        return directory;
    }

    /** 复核原始证据未被替换且仍对应当前源码 */
    async valid(evidence: AcceptanceEvidence, sourceHash: string, includeFailure = false, snapshots = new Map<string, boolean>()): Promise<boolean> {
        if (evidence.codeHash !== sourceHash || (!includeFailure && !evidence.success) || evidence.contractVersion !== this.record.contract.version) {
            return false;
        }
        try {
            const ownPath = this.resolve(path.relative(this.directory, evidence.artifactPath));
            const imageValid = !evidence.imagePath || artifactHash(await fs.readFile(this.resolve(path.relative(this.directory, evidence.imagePath)))) === evidence.imageHash;
            if (evidence.sourcePath && !snapshots.has(evidence.sourcePath)) {
                snapshots.set(evidence.sourcePath, await projectSourceHash(this.resolve(path.relative(this.directory, evidence.sourcePath))) === evidence.codeHash);
            }
            const sourceValid = Boolean(evidence.sourcePath && snapshots.get(evidence.sourcePath));
            return sourceValid && imageValid && artifactHash(await fs.readFile(ownPath)) === evidence.hash;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
            }
            throw error;
        }
    }
}
