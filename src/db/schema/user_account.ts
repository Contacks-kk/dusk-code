
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core"

export const userAccount = sqliteTable("user_account", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("name").notNull(),
    password: text("password").notNull(),
    email: text("email").notNull(),
    sex: integer("sex").notNull(), //1:男,0:女
    phongnum: text("number").notNull(),//电话
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    lastLoginAt: integer("last_login_at", { mode: "timestamp" }).$defaultFn(() => new Date())
})

export type UserAccount = typeof userAccount.$inferSelect;
export type NewUserAccount = typeof userAccount.$inferInsert;