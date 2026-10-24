import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    aborted: boolean;
    outputIncomplete: boolean;
}

/** 跨平台终端执行与命令安全防护适配器 */
export class ShellAdapter {
    private isWindows = process.platform === "win32";

    /** 优先使用新版 PowerShell，保留原生命令退出码并单独处理 Shell 异常 */
    private windowsInvocation(command: string): { program: string; args: string[] } {
        const modern = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
        const installed = [modern, ...(process.env.PATH ?? "").split(path.delimiter).map(directory => path.join(directory, "pwsh.exe"))]
            .find(filename => fs.existsSync(filename));
        const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$global:LASTEXITCODE = $null;
try {
    & { ${command}
    };
    $duskShellSucceeded = $?;
    if ($null -ne $global:LASTEXITCODE) {
        exit $global:LASTEXITCODE;
    };
    if (-not $duskShellSucceeded) {
        exit 1;
    };
    exit 0;
} catch {
    [Console]::Error.WriteLine($_.ToString());
    exit 1;
}`;
        return {
            program: installed ?? "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
        };
    }

    /** 检查命令是否包含高危禁止操作 */
    public validateCommandSafety(command: string): void {
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
        timeoutMs: number = 30000,
        signal?: AbortSignal
    ): Promise<CommandExecutionResult> {
        this.validateCommandSafety(command);

        if (signal?.aborted) {
            return {
                stdout: "",
                stderr: "",
                exitCode: -1,
                timedOut: false,
                aborted: true,
                outputIncomplete: false
            };
        }

        const targetCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);

        return new Promise<CommandExecutionResult>((resolve) => {
            let shellProgram: string;
            let shellArgs: string[];

            if (this.isWindows) {
                // Windows 环境下强制启用 PowerShell 并指定 UTF-8 编码
                const invocation = this.windowsInvocation(command);
                shellProgram = invocation.program;
                shellArgs = invocation.args;
            } else {
                // Unix/Linux/macOS 环境下使用 sh
                shellProgram = "/bin/sh";
                shellArgs = ["-c", command];
            }

            const proc = spawn(shellProgram, shellArgs, {
                cwd: targetCwd,
                env: { ...process.env, LANG: "zh_CN.UTF-8" },
                windowsHide: true
            });

            let stdout = "";
            let stderr = "";
            let timedOut = false;
            let aborted = false;
            let exited = false;
            let settled = false;
            let exitCode = -1;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;

            /** 清理本次命令的等待资源并只返回一次结果 */
            const finish = (outputIncomplete: boolean = false): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                clearTimeout(drainTimer);
                signal?.removeEventListener("abort", onAbort);

                // 后台进程可能仍持有管道，结束等待时只释放当前执行器的句柄
                proc.stdin?.destroy();
                proc.stdout.destroy();
                proc.stderr.destroy();
                proc.unref();
                resolve({
                    stdout: this.sanitizeOutput(stdout),
                    stderr: this.sanitizeOutput(stderr),
                    exitCode,
                    timedOut,
                    aborted,
                    outputIncomplete
                });
            };

            /** 尝试终止当前命令并结束超时或取消等待 */
            const stop = (cancelled: boolean): void => {
                if (settled) {
                    return;
                }
                aborted = cancelled;
                timedOut = !cancelled;

                // Shell 已退出时保留后台进程，仅停止回收剩余输出
                if (!exited) {
                    try {
                        if (!proc.kill()) {
                            stderr += "\n未能确认命令进程已终止，子进程可能仍在运行。";
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        stderr += `\n终止命令进程失败: ${message}`;
                    }
                }

                // 终止失败也必须返回，不能继续依赖进程或管道关闭
                finish(!proc.stdout.readableEnded || !proc.stderr.readableEnded);
            };

            /** 响应用户取消并结束本次命令等待 */
            const onAbort = (): void => {
                stop(true);
            };

            proc.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });

            proc.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });

            proc.once("exit", (code) => {
                if (settled) {
                    return;
                }
                exited = true;
                exitCode = code ?? -1;
                clearTimeout(timer);

                // Shell 退出后最多再回收一秒输出，避免被后台进程持有的管道拖住
                drainTimer = setTimeout(() => finish(true), 1000);
            });

            proc.once("close", (code) => {
                if (settled) {
                    return;
                }
                exitCode = code ?? exitCode;
                finish();
            });

            proc.on("error", (err) => {
                if (settled) {
                    return;
                }
                stderr += `\n进程执行失败: ${err.message}`;

                // 终止进程产生的错误由超时或取消分支统一收尾
                if (!timedOut && !aborted) {
                    finish();
                }
            });

            timer = setTimeout(() => stop(false), timeoutMs);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
            }
        });
    }
}

export const shellAdapter = new ShellAdapter();
