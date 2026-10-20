import Database from "better-sqlite3"
import {drizzle} from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "./migrate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


// 统一管理全局数据持久化目录 ~/.dusk/
const globalConfigDir = path.join(os.homedir(), ".dusk");
if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true });
}

const dbPath = path.join(globalConfigDir, "dusk.db");

// 若全新环境下未发现数据库，自动从源码包自带模板拷贝以带入完整表结构
if (!fs.existsSync(dbPath)) {
    const templateDbPath = path.resolve(__dirname, "../../db/dusk.db");
    if (fs.existsSync(templateDbPath)) {
        try {
            fs.copyFileSync(templateDbPath, dbPath);
        } catch {}
    }
}

const sqlite = new Database(dbPath);

migrateDatabase(sqlite);

// Drizzle 数据库客户端实例
export const db = drizzle(sqlite, { schema });  
