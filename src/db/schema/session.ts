import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { project } from "./project";

/** 会话实体表模型 */
export const session = sqliteTable("session", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").references(() => project.id),
    title: text("title", { length: 255 }),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date())
});

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;