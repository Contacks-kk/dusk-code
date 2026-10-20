import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 保存剪贴板位图到指定的本地缓存目录 */
export async function saveClipboardImage(cacheDir: string = ".dusk/cache"): Promise<string | null> {
    const resolvedDir = path.resolve(process.cwd(), cacheDir);
    await fs.mkdir(resolvedDir, { recursive: true });

    const timestamp = Date.now();
    const targetFile = path.join(resolvedDir, `clipboard_${timestamp}.png`);

    if (process.platform === "win32") {
        return saveWindowsClipboardImage(targetFile);
    } else if (process.platform === "darwin") {
        return saveDarwinClipboardImage(targetFile);
    } else {
        return saveLinuxClipboardImage(targetFile);
    }
}

/** 在 Windows 平台下调用原生 PowerShell 提取剪贴板位图 */
async function saveWindowsClipboardImage(targetFile: string): Promise<string | null> {
    const escapedTarget = targetFile.replace(/'/g, "''");
    const script = `
        Add-Type -AssemblyName System.Windows.Forms;
        Add-Type -AssemblyName System.Drawing;
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            $img = [System.Windows.Forms.Clipboard]::GetImage();
            $img.Save('${escapedTarget}', [System.Drawing.Imaging.ImageFormat]::Png);
            Write-Output 'SAVED';
        } else {
            Write-Output 'EMPTY';
        }
    `.trim();

    try {
        const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
        if (stdout.trim().includes("SAVED")) {
            return targetFile;
        }
        return null;
    } catch {
        return null;
    }
}

/** 在 macOS 平台下提取剪贴板位图 */
async function saveDarwinClipboardImage(targetFile: string): Promise<string | null> {
    try {
        await execFileAsync("pngpaste", [targetFile]);
        return targetFile;
    } catch {
        return null;
    }
}

/** 在 Linux 平台下提取剪贴板位图 */
async function saveLinuxClipboardImage(targetFile: string): Promise<string | null> {
    try {
        await execFileAsync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
            encoding: "buffer"
        }).then(async ({ stdout }) => {
            if (stdout && stdout.length > 0) {
                await fs.writeFile(targetFile, stdout);
            }
        });
        return targetFile;
    } catch {
        return null;
    }
}
