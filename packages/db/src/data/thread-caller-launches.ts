import { and, eq } from "drizzle-orm";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import { threadCallerLaunches } from "../schema.js";

export interface ThreadCallerLaunchRow {
  originPluginId: string;
  callerLaunchId: string;
  threadId: string;
  bindingJson: string;
}

export interface InsertThreadCallerLaunchInput {
  originPluginId: string;
  callerLaunchId: string;
  threadId: string;
  bindingJson: string;
}

export function getThreadCallerLaunchByKey(
  db: DbQueryConnection,
  args: { originPluginId: string; callerLaunchId: string },
): ThreadCallerLaunchRow | null {
  return (
    db
      .select()
      .from(threadCallerLaunches)
      .where(
        and(
          eq(threadCallerLaunches.originPluginId, args.originPluginId),
          eq(threadCallerLaunches.callerLaunchId, args.callerLaunchId),
        ),
      )
      .get() ?? null
  );
}

export function getThreadCallerLaunchByThreadId(
  db: DbQueryConnection,
  threadId: string,
): ThreadCallerLaunchRow | null {
  return (
    db
      .select()
      .from(threadCallerLaunches)
      .where(eq(threadCallerLaunches.threadId, threadId))
      .get() ?? null
  );
}

export function insertThreadCallerLaunch(
  tx: DbConnection | DbTransaction,
  input: InsertThreadCallerLaunchInput,
): void {
  tx.insert(threadCallerLaunches).values(input).run();
}

export function isThreadCallerLaunchKeyConstraint(error: Error): boolean {
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    (code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      code === "SQLITE_CONSTRAINT_UNIQUE") &&
    error.message.includes("thread_caller_launches")
  );
}
