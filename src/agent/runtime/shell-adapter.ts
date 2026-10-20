import { spawn } from "node:child_process";
import * as path from "node:path";

export interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}

/** 跨平台终端执行与命令安全防护适配器 */
export class ShellAdapter {
    private isWindows = process.platform === "win32";

    /** 检查命令是否包含高危禁止操作 */
    private validateCommandSafety(command: string): void {
        const dangerousPatterns = [
            /rm\s+-rf\s+[\/\*]/i,
            /Remove-Item\s+.*-Recurse/i,
            /format\s+[a-zA-Z]:/i,
            /del\s+\/f\s+\/s\s+\/q/i,
            /mkfs\./i
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                throw new Error(`执行被安全拦截：检测到高风险破坏性指令 [${command}]，已被系统策略拒绝。`);
            }
        }
    }

    /** 智能截断输出以防撑爆模型上下文 */
    private sanitizeOutput(raw: string, maxLen: number = 3000): string {
        const text = raw.trim();
        if (text.length <= maxLen) {
            return text;
        }
        const truncatedNotice = `\n...[输出过长，已自动截断后部 ${text.length - maxLen} 个字符]...`;
        return text.slice(0, maxLen) + truncatedNotice;
    }

    /** 根据当前操作系统环境执行终端命令并返回安全格式化结果 */
    public async execute(
        command: string,
        cwd: string = process.cwd(),
        timeoutMs: number = 30000
    ): Promise<CommandExecutionResult> {
        this.validateCommandSafety(command);

        const targetCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);

        return new Promise<CommandExecutionResult>((resolve) => {
            let shellProgram: string;
            let shellArgs: string[];

            if (this.isWindows) {
                // Windows 环境下强制启用 PowerShell 并指定 UTF-8 编码
                shellProgram = "powershell.exe";
                shellArgs = [
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
                ];
            } else {
                // Unix/Linux/macOS 环境下使用 sh
                shellProgram = "/bin/sh";
                shellArgs = ["-c", command];
            }

            const proc = spawn(shellProgram, shellArgs, {
                cwd: targetCwd,
                env: { ...process.env, LANG: "zh_CN.UTF-8" }
            });

            let stdout = "";
            let stderr = "";
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, timeoutMs);

            proc.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });

            proc.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });

            proc.on("close", (code) => {
                clearTimeout(timer);
                resolve({
                    stdout: this.sanitizeOutput(stdout),
                    stderr: this.sanitizeOutput(stderr),
                    exitCode: timedOut ? -1 : (code ?? 0),
                    timedOut
                });
            });

            proc.on("error", (err) => {
                clearTimeout(timer);
                resolve({
                    stdout: this.sanitizeOutput(stdout),
                    stderr: this.sanitizeOutput(`进程启动失败: ${err.message}`),
                    exitCode: -1,
                    timedOut: false
                });
            });
        });
    }
}

export const shellAdapter = new ShellAdapter();
