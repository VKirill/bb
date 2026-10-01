import type { Hono } from "hono";
import type { DbConnection } from "@bb/db";
import type { ServerRuntimeConfig } from "../types.js";
import { browserRequestProblem } from "../browser-request-guard.js";
import { resolveVkExcludedPluginIds } from "../services/threads/vk-excluded-plugins.js";

export function registerVkPluginRoutes(
  app: Hono,
  deps: {
    db: DbConnection;
    config: Pick<ServerRuntimeConfig, "serverPort" | "appUrl" | "devAppPort">;
  },
): void {
  app.get("/plugins/vk-excluded-plugins", async (context) => {
    const problem = browserRequestProblem(context, deps, {
      requireJsonForMutation: true,
    });
    if (problem) {
      return context.json({ ok: false, error: problem.error }, problem.status);
    }
    const read = (name: string) => {
      const value = context.req.query(name);
      return value !== undefined && value.length > 0 ? value : null;
    };
    const excluded = await resolveVkExcludedPluginIds(deps.db, {
      projectId: read("projectId"),
      hostId: read("hostId"),
      environmentId: read("environmentId"),
      path: read("path"),
      threadId: read("threadId"),
    });
    return context.json({ ok: true, pluginIds: [...excluded].sort() });
  });
}
