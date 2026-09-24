import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  insertVkCompiledMainAgentSnapshot,
  readVkCompiledMainAgentSnapshot,
  threadPluginMetadata,
} from "@bb/db";
import { ApiError } from "../../src/errors.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

const compiled = {
  id: "copy-lead",
  sourceVersion: "lp-owned-1",
  sourceHash:
    "1e094bd44751835710629a6ea275c41e37d97f5242131c5d80f4b8646c5fe928",
  description: "Lane Pilot copy lead",
  prompt: "You are the Lane Pilot copy lead.",
};

describe("compiled main agent create path", () => {
  it("rejects a reserved key in ordinary pluginMetadata", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-vk-meta" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/vk-compiled-meta",
      });
      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: "/tmp/vk-compiled-meta" },
          },
          input: textInput("ordinary"),
          origin: "plugin",
          originPluginId: "bb-plugin-lane-pilot",
          pluginMetadata: {
            role: "pm",
            experimental_vkCompiledMainAgent: compiled,
          },
          projectId: project.id,
          providerId: "claude-code",
          startedOnBehalfOf: null,
        }),
      ).rejects.toMatchObject({
        body: {
          message:
            "experimental_vkCompiledMainAgent is not writable pluginMetadata",
        },
      });
    });
  });

  it("does not start a compiled profile on a non-Claude provider", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-vk-codex" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/vk-compiled-codex",
      });
      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: "/tmp/vk-compiled-codex" },
          },
          input: textInput("writer"),
          origin: "plugin",
          originPluginId: "bb-plugin-lane-pilot",
          pluginMetadata: { role: "pm" },
          experimental_vkCompiledMainAgent: compiled,
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        }),
      ).rejects.toBeInstanceOf(ApiError);
      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: "/tmp/vk-compiled-codex" },
          },
          input: textInput("writer"),
          origin: "plugin",
          originPluginId: "bb-plugin-lane-pilot",
          pluginMetadata: { role: "pm" },
          experimental_vkCompiledMainAgent: compiled,
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        }),
      ).rejects.toMatchObject({
        body: { message: "vk_compiled_main_agent_unsupported_provider" },
      });
    });
  });

  it("leaves an ordinary thread without a required compiled snapshot", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-vk-legacy" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/vk-compiled-legacy",
      });
      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: "/tmp/vk-compiled-legacy" },
        },
        input: textInput("legacy"),
        origin: "plugin",
        originPluginId: "bb-plugin-lane-pilot",
        pluginMetadata: { role: "pm" },
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });
      expect(
        readVkCompiledMainAgentSnapshot(harness.deps.db, thread.id),
      ).toEqual({
        required: false,
        profile: null,
      });
    });
  });

  it("does not start a compiled thread after its snapshot row is lost", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-vk-lost" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/vk-compiled-lost",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/vk-compiled-lost",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
      });
      insertVkCompiledMainAgentSnapshot(harness.deps.db, {
        threadId: thread.id,
        profile: compiled,
      });
      harness.deps.db
        .delete(threadPluginMetadata)
        .where(
          and(
            eq(threadPluginMetadata.threadId, thread.id),
            eq(threadPluginMetadata.pluginId, "__vk.compiled-main-agent"),
          ),
        )
        .run();
      await expect(
        resolveThreadRuntimeCommandConfig(harness.deps, {
          thread,
          model: "claude-sonnet-5",
          environment,
        }),
      ).rejects.toMatchObject({
        body: { code: "vk_compiled_main_agent_dropped" },
      });
    });
  });
});
