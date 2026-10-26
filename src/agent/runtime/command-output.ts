import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { SpillStore } from "../spill/spill-store";
import { utf8Head, utf8Tail } from "../spill/text";
import type { CommandOutputContext } from "../spill/types";

export class CommandOutputSink extends Writable {
    private readonly decoder = new StringDecoder("utf8");
    private head = "";
    private tail = "";
    private decodedBytes = 0;
    private closedFile = false;
    totalBytes = 0;
    storageError?: string;
    readonly completion: Promise<void>;

    /** 绑定已经打开的日志文件并立即接管错误结算 */
    constructor(readonly filename: string, private readonly handle: FileHandle) {
        super({ highWaterMark: 65536 });
        this.completion = finished(this).catch(error => {
            this.storageError = error instanceof Error ? error.message : String(error);
        });
    }

    /** 顺序落盘原始字节，写入速度自然约束上游管道 */
    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.totalBytes += chunk.length;
        this.retain(this.decoder.write(chunk));
        void this.handle.writeFile(chunk).then(() => callback(), error => callback(error));
    }

    /** 保存解码尾部并刷新日志文件 */
    override _final(callback: (error?: Error | null) => void): void {
        this.retain(this.decoder.end());
        void this.handle.sync().then(() => this.closeFile()).then(() => callback(), error => callback(error));
    }

    /** 错误和正常销毁均释放文件句柄 */
    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        void this.closeFile().then(() => callback(error), closeError => callback(error ?? closeError));
    }

    /** 只关闭自己持有的文件一次 */
    private async closeFile(): Promise<void> {
        if (!this.closedFile) {
            this.closedFile = true;
            await this.handle.close();
        }
    }

    /** 保留有限首尾文本，不累积完整输出 */
    private retain(text: string): void {
        this.decodedBytes += Buffer.byteLength(text);
        if (Buffer.byteLength(this.head) < 6000) {
            this.head = utf8Head(this.head + text, 6000);
        }
        this.tail = utf8Tail(this.tail + text, 6000);
    }

    /** 返回可展示预览，完整字节由日志路径读取 */
    preview(): string {
        if (this.decodedBytes <= 6000) {
            return this.head;
        }
        if (this.decodedBytes <= 12000) {
            const overlap = Buffer.byteLength(this.head) + Buffer.byteLength(this.tail) - this.decodedBytes;
            return this.head + Buffer.from(this.tail).subarray(Math.max(0, overlap)).toString("utf8");
        }
        return `${this.head}\n[…完整输出见日志文件…]\n${this.tail}`;
    }
}

/** 在启动命令之前建立独立的标准输出与错误输出文件 */
export async function createCommandOutput(context: CommandOutputContext): Promise<{ stdout: CommandOutputSink; stderr: CommandOutputSink }> {
    const directory = await SpillStore.createCallDirectory(context);
    const stdoutPath = path.join(directory, "stdout.log");
    const stderrPath = path.join(directory, "stderr.log");
    const stdout = new CommandOutputSink(stdoutPath, await open(stdoutPath, "wx", 0o600));
    try {
        return { stdout, stderr: new CommandOutputSink(stderrPath, await open(stderrPath, "wx", 0o600)) };
    } catch (error) {
        stdout.destroy();
        await stdout.completion;
        throw error;
    }
}
