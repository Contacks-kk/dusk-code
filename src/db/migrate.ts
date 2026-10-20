import type Database from "better-sqlite3";

/** 幂等补全旧数据库的项目归属与执行记录字段 */
export function migrateDatabase(database: Database.Database): void {
    database.transaction(() => {
        database.exec(`CREATE TABLE IF NOT EXISTS project (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
            created_at INTEGER, updated_at INTEGER
        )`);
        /** 查询指定表的已有字段名 */
        const columns = (table: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
        if (!columns("session").includes("project_id")) database.exec("ALTER TABLE session ADD COLUMN project_id INTEGER REFERENCES project(id)");
        if (!columns("turn").includes("execution_json")) database.exec("ALTER TABLE turn ADD COLUMN execution_json TEXT");
    })();
}
