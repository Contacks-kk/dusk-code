import * as path from "node:path";
import * as os from "node:os";

/** 返回数据库及验收产物使用的数据目录 */
export function duskDataDirectory(): string {
    return path.resolve(process.env.DUSK_DATA_DIR || path.join(os.homedir(), ".dusk"));
}
