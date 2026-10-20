import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

/** 项目/工作区实体表模型 */
export const project = sqliteTable("project", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name", { length: 255 }).notNull(),
    rootPath: text("root_path", { length: 1024 }).notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date())
});

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
