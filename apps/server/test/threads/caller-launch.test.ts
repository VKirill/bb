import {
  getThreadPluginMetadata,
  insertThreadCallerLaunch,
  insertThreadPluginMetadata,
} from "@bb/db";
import { CALLER_LAUNCH_METADATA_PLUGIN_ID } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import type { ThreadCreateServiceRequestInput } from "../../src/services/threads/thread-create-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const LAUNCH_A = "11111111-1111-4111-8111-111111111111";
const LAUNCH_B = "22222222-2222-4222-8222-222222222222";
const AGENCY = "agency";
const OTHER = "other-plugin";
const SKILL_A = `skill_${"ab".repeat(32)}`;
const SKILL_B = `skill_${"cd".repeat(32)}`;

function isCallerLaunchConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body.code === "caller_launch_conflict"
  );
}

function seedWorkspace(harness: TestAppHarness, path: string) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
  });
  return { host, project, environment };
}

function callerBody(
  projectId: string,
  hostId: string,
  path: string,
  extra: Partial<ThreadCreateServiceRequestInput> = {},
): ThreadCreateServiceRequestInput {
  return {
    projectId,
    providerId: "codex",
    origin: "plugin",
    originPluginId: AGENCY,
    environment: {
      type: "host",
      hostId,
      workspace: { type: "unmanaged", path },
    },
    input: textInput("caller-launch"),
    startedOnBehalfOf: null,
    originKind: null,
    ...extra,
  };
}

describe("caller launch identity", () => {
  it("creates, replays, conflicts, looks up, and rejects reserved patches", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/caller-launch-create";
      const { host, project } = seedWorkspace(harness, path);
      const created = await createThreadFromRequest(harness.deps, {
        ...callerBody(project.id, host.id, path, {
          experimental_callerLaunchId: LAUNCH_A,
          experimental_callerAttemptId: "att_1",
          experimental_callerJobId: "job_1",
        }),
      });

      const getOnce = await harness.app.request(
        `/api/v1/threads/${created.id}`,
      );
      expect(getOnce.status).toBe(200);
      const first = (await getOnce.json()) as {
        experimental_callerLaunchId?: string;
        experimental_callerAttemptId?: string;
        experimental_callerJobId?: string;
        originPluginId?: string;
      };
      expect(first).toMatchObject({
        experimental_callerLaunchId: LAUNCH_A,
        experimental_callerAttemptId: "att_1",
        experimental_callerJobId: "job_1",
        originPluginId: AGENCY,
      });

      const replay = await createThreadFromRequest(harness.deps, {
        ...callerBody(project.id, host.id, path, {
          experimental_callerLaunchId: LAUNCH_A,
          experimental_callerAttemptId: "att_1",
          experimental_callerJobId: "job_1",
        }),
      });
      expect(replay.id).toBe(created.id);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            experimental_callerLaunchId: LAUNCH_A,
            experimental_callerAttemptId: "att_other",
            experimental_callerJobId: "job_1",
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      const otherPlugin = await createThreadFromRequest(harness.deps, {
        ...callerBody(project.id, host.id, path, {
          originPluginId: OTHER,
          experimental_callerLaunchId: LAUNCH_A,
          experimental_callerAttemptId: "att_1",
          experimental_callerJobId: "job_1",
        }),
      });
      expect(otherPlugin.id).not.toBe(created.id);

      const unscoped = await harness.app.request(
        `/api/v1/threads?experimental_callerLaunchId=${LAUNCH_A}`,
      );
      expect(unscoped.status).toBe(400);

      const listed = await harness.app.request(
        `/api/v1/threads?experimental_callerLaunchId=${LAUNCH_A}&originPluginId=${AGENCY}`,
      );
      expect(listed.status).toBe(200);
      const rows = (await listed.json()) as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toEqual([created.id]);

      const reopen = await harness.app.request(
        `/api/v1/threads/${created.id}`,
      );
      expect(reopen.status).toBe(200);
      expect(await reopen.json()).toMatchObject({
        experimental_callerLaunchId: LAUNCH_A,
        experimental_callerAttemptId: "att_1",
        experimental_callerJobId: "job_1",
      });

      const reserved = await harness.app.request(
        `/api/v1/threads/${created.id}/plugin-metadata`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pluginId: CALLER_LAUNCH_METADATA_PLUGIN_ID,
            set: { callerAttemptId: "hacked" },
          }),
        },
      );
      expect(reserved.status).toBe(403);
      expect(
        getThreadPluginMetadata(
          harness.db,
          created.id,
          CALLER_LAUNCH_METADATA_PLUGIN_ID,
        ).metadata,
      ).toMatchObject({ callerAttemptId: "att_1", originPluginId: AGENCY });

      const parallel = await Promise.all([
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            experimental_callerLaunchId: LAUNCH_B,
            experimental_callerAttemptId: "att_p",
            experimental_callerJobId: "job_p",
          }),
        }),
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            experimental_callerLaunchId: LAUNCH_B,
            experimental_callerAttemptId: "att_p",
            experimental_callerJobId: "job_p",
          }),
        }),
      ]);
      expect(parallel[0].id).toBe(parallel[1].id);
    });
  });

  it("conflicts when replay changes project, env, root, provider, model, prompt, isolation, skillIds, or job", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/caller-launch-binding";
      const { host, project } = seedWorkspace(harness, path);
      const otherPath = "/tmp/caller-launch-other-root";
      const other = seedWorkspace(harness, otherPath);
      const otherProjectPath = "/tmp/caller-launch-other-project";
      const { project: otherProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: otherProjectPath,
      });
      await createThreadFromRequest(harness.deps, {
        ...callerBody(project.id, host.id, path, {
          experimental_callerLaunchId: LAUNCH_A,
          experimental_callerAttemptId: "att_1",
          experimental_callerJobId: "job_1",
          model: "model-a",
        }),
      });

      const sameIds = {
        experimental_callerLaunchId: LAUNCH_A,
        experimental_callerAttemptId: "att_1",
        experimental_callerJobId: "job_1",
        model: "model-a",
      } as const;

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(otherProject.id, host.id, otherProjectPath, sameIds),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(other.project.id, other.host.id, otherPath, sameIds),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, otherPath, sameIds),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            ...sameIds,
            providerId: "claude-code",
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            ...sameIds,
            model: "model-b",
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, sameIds),
          input: textInput("changed-prompt"),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            ...sameIds,
            isolatedSkillDelivery: true,
            skillIds: [SKILL_A],
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            ...sameIds,
            experimental_callerJobId: "job_other",
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);

      await createThreadFromRequest(harness.deps, {
        ...callerBody(project.id, host.id, path, {
          experimental_callerLaunchId: LAUNCH_B,
          experimental_callerAttemptId: "att_iso",
          isolatedSkillDelivery: true,
          skillIds: [SKILL_A],
        }),
      });
      await expect(
        createThreadFromRequest(harness.deps, {
          ...callerBody(project.id, host.id, path, {
            experimental_callerLaunchId: LAUNCH_B,
            experimental_callerAttemptId: "att_iso",
            isolatedSkillDelivery: true,
            skillIds: [SKILL_B],
          }),
        }),
      ).rejects.toSatisfy(isCallerLaunchConflict);
    });
  });

  it("forks without inheriting experimental_callerLaunchId unless a new identity is supplied", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/caller-launch-fork";
      const { project, environment } = seedWorkspace(harness, path);
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        originPluginId: AGENCY,
        projectId: project.id,
      });
      insertThreadPluginMetadata(harness.db, {
        threadId: parent.id,
        pluginId: CALLER_LAUNCH_METADATA_PLUGIN_ID,
        metadata: {
          callerLaunchId: LAUNCH_A,
          callerAttemptId: "att_1",
          originPluginId: AGENCY,
        },
      });
      insertThreadCallerLaunch(harness.db, {
        originPluginId: AGENCY,
        callerLaunchId: LAUNCH_A,
        threadId: parent.id,
        bindingJson: "{}",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        permissionMode: "full",
        providerThreadId: "provider-caller-fork",
        threadId: parent.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-caller-fork",
        sequence: 3,
        threadId: parent.id,
        turnId: "turn-caller-fork",
      });

      const inherited = await harness.app.request("/api/v1/threads/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId: parent.id,
          input: textInput("fork-plain"),
        }),
      });
      if (inherited.status !== 201) {
        throw new Error(
          `fork-plain ${inherited.status}: ${await inherited.text()}`,
        );
      }
      const child = (await inherited.json()) as {
        id: string;
        experimental_callerLaunchId?: string;
      };
      expect(child.experimental_callerLaunchId).toBeUndefined();
      expect(child.id).not.toBe(parent.id);

      const sameId = await harness.app.request("/api/v1/threads/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId: parent.id,
          origin: "plugin",
          originPluginId: AGENCY,
          experimental_callerLaunchId: LAUNCH_A,
          experimental_callerAttemptId: "att_fork",
          input: textInput("fork-same"),
        }),
      });
      expect(sameId.status).toBe(409);

      const fresh = await harness.app.request("/api/v1/threads/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId: parent.id,
          origin: "plugin",
          originPluginId: AGENCY,
          experimental_callerLaunchId: LAUNCH_B,
          experimental_callerAttemptId: "att_fork",
          input: textInput("fork-new"),
        }),
      });
      expect(fresh.status).toBe(201);
      expect(await fresh.json()).toMatchObject({
        experimental_callerLaunchId: LAUNCH_B,
        experimental_callerAttemptId: "att_fork",
        originPluginId: AGENCY,
      });
    });
  });
});
