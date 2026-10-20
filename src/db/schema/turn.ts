import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core"
import {session} from "./session"
import type { ExecutionRecord } from "../../agent/types";
export const turn = sqliteTable("turn", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
        .notNull()
        .references(() => session.id),
    turnNo: integer("turn_no").notNull(),
    executionJson: text("execution_json", { mode: "json" }).$type<ExecutionRecord>(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date())
})

export type Turn=typeof turn.$inferSelect;
export type NewTurn=typeof turn.$inferInsert;
