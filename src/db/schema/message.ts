import { sqliteTable, integer, text} from "drizzle-orm/sqlite-core"
import { turn } from "./turn"

export const message = sqliteTable("message", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    turnId: integer("turn_id")
        .notNull()
        .references(() => turn.id),
    role: text("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date())
})

export type Message=typeof message.$inferSelect;
export type NewMessage=typeof message.$inferInsert;