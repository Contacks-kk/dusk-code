import * as path from "node:path";

export type PermissionMode = "read-only" | "workspace" | "full-access";

export interface PermissionCheckResult {
    allowed: boolean;
    reason?: string;
}

/** 敏感系统与凭证文件模式名单 */
const SENSITIVE_FILE_PATTERNS = [
    /^\.env(\..+)?$/i,
    /id_rsa/i,
    /id_ed25519/i,
    /\.pem$/i,
    /\.key$/i,
    /\.git[\/\\]config/i
];

/** 写文件与代码变更类工具 */
const WRITE_TOOLS = new Set(["apply_patch", "write_file", "edit_code"]);

/** 命令执行类工具 */
const EXECUTE_TOOLS = new Set(["execute_command"]);

/** 只读探索类工具 */
export const READ_TOOLS = new Set([
    "read_file",
    "read_code",
    "list_files",
    "grep_search",
    "git_status",
    "git_diff",
    "get_current_time",
    "calculator"
]);

/** 统一权限与沙箱边界管理器 */
export class PermissionManager {
    private currentMode: PermissionMode = "workspace";
    private allowedEscapePaths: Set<string> = new Set();

    /** 获取当前生效的权限模式 */
    public getMode(): PermissionMode {
        return this.currentMode;
    }

    /** 切换权限模式并返回是否需要安全风险警告 */
    public setMode(mode: PermissionMode): { mode: PermissionMode; warnRisk: boolean } {
        this.currentMode = mode;
        const warnRisk = mode === "full-access";
        return { mode, warnRisk };
    }

    /** 检测目标文件是否命中敏感凭据黑名单 */
    private isSensitiveFile(targetPath: string): boolean {
        const baseName = path.basename(targetPath);
        return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(baseName) || pattern.test(targetPath));
    }

    /** 检测文件路径是否越界脱离当前项目工作区根目录 */
    private isPathEscaping(targetPath: string, cwd: string): boolean {
        const resolvedTarget = path.resolve(cwd, targetPath);
        const resolvedCwd = path.resolve(cwd);

        // Windows 系统下不区分大小写比对
        const targetStr = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
        const cwdStr = process.platform === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd;

        return !(targetStr === cwdStr || targetStr.startsWith(cwdStr + path.sep));
    }

    /** 核心权限校验逻辑：根据当前模式、工具类型与目标参数裁定是否放行 */
    public async checkToolPermission(
        toolName: string,
        args: Record<string, any> = {},
        askUserConfirm?: (prompt: string) => Promise<boolean>
    ): Promise<PermissionCheckResult> {
        // 1. 只读模式下拦截所有写入与命令执行操作
        if (this.currentMode === "read-only") {
            if (WRITE_TOOLS.has(toolName)) {
                return { allowed: false, reason: `当前处于 [Read Only] 只读模式，禁止执行文件写入/修改操作 [${toolName}]。可通过 /permissions workspace 解锁。` };
            }
            if (EXECUTE_TOOLS.has(toolName)) {
                return { allowed: false, reason: `当前处于 [Read Only] 只读模式，禁止执行终端命令。可通过 /permissions workspace 解锁。` };
            }
            return { allowed: true };
        }

        // 2. Full Access 模式：默认全面授权放行
        if (this.currentMode === "full-access") {
            return { allowed: true };
        }

        // 3. Workspace 默认模式：执行沙箱与敏感边界保护
        const cwd = process.cwd();
        const targetPath = args.filePath || args.directoryPath || args.repoPath;

        if (targetPath && typeof targetPath === "string") {
            // 敏感文件保护
            if (this.isSensitiveFile(targetPath)) {
                if (WRITE_TOOLS.has(toolName)) {
                    return { allowed: false, reason: `安全沙箱拒绝：目标文件 [${targetPath}] 属于敏感配置/凭据文件，禁止修改。` };
                }
            }

            // 越界脱离工作区保护
            if (this.isPathEscaping(targetPath, cwd)) {
                const resolvedTarget = path.resolve(cwd, targetPath);
                if (!this.allowedEscapePaths.has(resolvedTarget)) {
                    if (!askUserConfirm) {
                        return { allowed: false, reason: `安全沙箱拦截：试图跨目录访问工作区以外路径 [${targetPath}]。` };
                    }

                    const confirmed = await askUserConfirm(
                        `\x1b[33m⚠️ [越界沙箱警报]\x1b[0m Agent 试图访问工作区外部路径: \x1b[1m${resolvedTarget}\x1b[0m\n请问是否授权本次越界操作？(y/N): `
                    );

                    if (!confirmed) {
                        return { allowed: false, reason: `用户拒绝了对工作区外部路径 [${targetPath}] 的越界访问授权。` };
                    }

                    this.allowedEscapePaths.add(resolvedTarget);
                }
            }
        }

        return { allowed: true };
    }
}

export const permissionManager = new PermissionManager();
