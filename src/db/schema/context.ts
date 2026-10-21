import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import { session } from "./session";
import type { ContextArtifact } from "../../agent/context/types";

export const contextArtifact = sqliteTable("context_artifact", {
    id: text("id").primaryKey(),
    sessionId: integer("session_id").notNull().references(() => session.id),
    payloadJson: text("payload_json", { mode: "json" }).notNull().$type<ContextArtifact>(),
    createdAt: integer("created_at").notNull()
}, table => [index("context_artifact_session").on(table.sessionId)]);

export const sessionContextState = sqliteTable("session_context_state", {
    sessionId: integer("session_id").primaryKey().references(() => session.id),
    revision: integer("revision").notNull().default(0),
    artifactIds: text("artifact_ids").notNull().default("[]"),
    ownerId: text("owner_id"),
    leaseUntil: integer("lease_until").notNull().default(0),
    updatedAt: integer("updated_at").notNull().default(0)
});
