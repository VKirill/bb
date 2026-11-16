import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { z } from "zod";
import {
  getLatestThreadSequence,
  createEnvironment,
  type EnvironmentRow,
  createEventId,
  findProjectEnvironmentByHostPath,
  getThreadPluginMetadata,
  getEnvironment,
  getThread,
  updateThread,
} from "@bb/db";
import {
  canonicalizeHostPath,
  isAbsoluteHostPath,
  isHostPathRoot,
  turnScope,
} from "@bb/domain";
import type { DynamicTool, Thread, ToolCallResponse } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { runTrackedEnvironmentAttach } from "../environments/environment-engine.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { suppliedWorkspacePathRefusal } from "./workspace-path-claims.js";
import { createHash } from "node:crypto";
import { pluginHookProvider } from "../plugins/plugin-hook-registry.js";
import {
  invokeVkDirectoryMove,
  vkDirectoryMoveCapability,
  type VkDirectoryMoveInput,
} from "../plugins/vk-directory-move.js";

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME =
  "update_environment_directory";

export const ENVIRONMENT_DIRECTORY_UPDATE_OPERATION =
  "environment_directory_update";

const UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 5 * 60 * 1000;
const LANE_PILOT_PLUGIN_ID = "lane-pilot";

const updateEnvironmentDirectoryInputSchema = z
  .object({
    path: z.string().trim().min(1),
  })
  .strict();

const threadMoveLocks = new Map<string, Promise<void>>();

async function withThreadMoveLock<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = threadMoveLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  threadMoveLocks.set(threadId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (threadMoveLocks.get(threadId) === current)
      threadMoveLocks.delete(threadId);
  }
}

function directoryMoveOperationId(args: {
  projectId: string;
  threadId: string;
  sourceEnvironmentId: string;
  sourcePath: string;
  targetEnvironmentId: string;
  targetPath: string;
}): string {
  return `envmove_${createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex")}`;
}

function hasLanePilotRunMetadata(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const stored = getThreadPluginMetadata(
    deps.db,
    threadId,
    LANE_PILOT_PLUGIN_ID,
  );
  return stored.corrupt || typeof stored.metadata.lanePilotRunId === "string";
}

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL: DynamicTool = {
  name: UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
  description:
    "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. The tool reuses this project's existing bb environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, end the current turn because the running provider cwd will not change until the next turn; bb then starts the next turn in the new directory automatically so you can continue the task there.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
};

interface HandleUpdateEnvironmentDirectoryToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
  turnId: string;
}

type ReadyEnvironment = EnvironmentRow & { path: string; status: "ready" };

type AttachEnvironmentResult =
  | { kind: "attached"; changed: boolean }
  | { kind: "environment_changed" }
  | { kind: "thread_unavailable"; message: string };

function toolCallTextResponse(
  success: boolean,
  text: string,
): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function toolCallFailure(text: string): ToolCallResponse {
  return toolCallTextResponse(false, text);
}

function toolCallSuccess(text: string): ToolCallResponse {
  return toolCallTextResponse(true, text);
}

function normalizeDirectoryPath(path: string): string {
  return canonicalizeHostPath(path.trim());
}

function validateDirectoryPath(path: string): string | null {
  if (!isAbsoluteHostPath(path)) {
    return "Path must be an absolute path on the current host.";
  }
  if (isHostPathRoot(path)) {
    return "Path must name a project directory, not the filesystem root.";
  }
  if (path.includes("\0")) {
    return "Path must not contain NUL bytes.";
  }
  return null;
}

export function threadWritableFailure(thread: Thread): string | null {
  if (thread.deletedAt !== null) {
    return "Cannot update the environment directory for a deleted thread.";
  }
  if (thread.archivedAt !== null) {
    return "Cannot update the environment directory for an archived thread.";
  }
  return null;
}

function resolveReadyEnvironment(
  environment: EnvironmentRow,
): ReadyEnvironment | { failure: string } {
  if (environment.status !== "ready") {
    return {
      failure: `Environment at this path is ${environment.status}, not ready.`,
    };
  }
  if (!environment.path) {
    return {
      failure: "Environment at this path does not have a resolved directory.",
    };
  }
  return {
    ...environment,
    path: environment.path,
    status: environment.status,
  };
}

function successMessage(path: string): string {
  return `Environment directory updated to ${path}. This applies to future turns; end this turn now and bb will start the next turn in the updated directory so you can continue the task there.`;
}

function attachReadyEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    currentEnvironment: EnvironmentRow;
    createdEnvironment: boolean;
    targetEnvironment: ReadyEnvironment;
    thread: Thread;
    turnId: string;
  },
): AttachEnvironmentResult {
  const result = deps.db.transaction(
    (tx): AttachEnvironmentResult => {
      const latestThread = getThread(tx, args.thread.id);
      if (!latestThread || latestThread.deletedAt !== null) {
        return {
          kind: "thread_unavailable",
          message: "Thread no longer exists.",
        };
      }

      const writableFailure = threadWritableFailure(latestThread);
      if (writableFailure) {
        return { kind: "thread_unavailable", message: writableFailure };
      }

      if (latestThread.environmentId === args.targetEnvironment.id) {
        return { kind: "attached", changed: false };
      }

      if (latestThread.environmentId !== args.currentEnvironment.id) {
        return { kind: "environment_changed" };
      }

      updateThread(tx, deps.hub, latestThread.id, {
        environmentId: args.targetEnvironment.id,
      });
      appendThreadEventInTransaction(tx, {
        threadId: latestThread.id,
        environmentId: args.targetEnvironment.id,
        type: "system/operation",
        scope: turnScope(args.turnId),
        data: {
          operation: ENVIRONMENT_DIRECTORY_UPDATE_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: `Updated environment directory to ${args.targetEnvironment.path}`,
          metadata: {
            createdEnvironment: args.createdEnvironment,
            previousEnvironmentId: args.currentEnvironment.id,
            previousPath: args.currentEnvironment.path,
            nextEnvironmentId: args.targetEnvironment.id,
            nextPath: args.targetEnvironment.path,
          },
        },
      });
      return { kind: "attached", changed: true };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "attached" && result.changed) {
    deps.hub.notifyThread(args.thread.id, ["events-appended"], {
      timelineSequence: getLatestThreadSequence(deps.db, {
        threadId: args.thread.id,
      }),
      eventTypes: ["system/operation"],
    });
  }

  return result;
}

async function provisionUnmanagedEnvironmentForPath(
  deps: AppDeps,
  args: {
    currentEnvironment: EnvironmentRow;
    path: string;
    thread: Thread;
  },
): Promise<ReadyEnvironment | ToolCallResponse> {
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: args.thread.projectId,
    hostId: args.currentEnvironment.hostId,
    providerOwnsPath: false,
    status: "provisioning",
    environmentProvider: null,
  });
  const command = buildEnvironmentProvisionCommand({
    environmentId: environment.id,
    hostId: args.currentEnvironment.hostId,
    initiator: null,
    path: args.path,
    setupScriptTimeoutMs: null,
  });

  try {
    await runTrackedEnvironmentAttach(deps, {
      hostId: args.currentEnvironment.hostId,
      command,
      timeoutMs: UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallFailure(
      `Could not update environment directory to ${args.path}: ${message}`,
    );
  }

  const readyEnvironment = getEnvironment(deps.db, environment.id);
  if (!readyEnvironment) {
    return toolCallFailure("Prepared environment no longer exists.");
  }
  const ready = resolveReadyEnvironment(readyEnvironment);
  if ("failure" in ready) {
    return toolCallFailure(ready.failure);
  }
  return ready;
}

async function performUpdateEnvironmentDirectoryToolCall(
  deps: AppDeps,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
): Promise<ToolCallResponse> {
  const input = updateEnvironmentDirectoryInputSchema.safeParse(args.input);
  if (!input.success) {
    return toolCallFailure(
      "Invalid arguments. Provide an object with an absolute path string.",
    );
  }

  const normalizedPath = normalizeDirectoryPath(input.data.path);
  const pathFailure = validateDirectoryPath(normalizedPath);
  if (pathFailure) {
    return toolCallFailure(pathFailure);
  }

  const writableFailure = threadWritableFailure(args.thread);
  if (writableFailure) {
    return toolCallFailure(writableFailure);
  }

  try {
    assertEnvironmentPathAvailable(deps, {
      hostId: args.currentEnvironment.hostId,
      path: normalizedPath,
      threadId: args.thread.id,
    });
  } catch (error) {
    return toolCallFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  if (
    getEnvironment(deps.db, args.currentEnvironment.id)?.path === normalizedPath
  ) {
    return toolCallSuccess(
      `This thread is already using ${normalizedPath} as its environment directory.`,
    );
  }

  const hookProvider = pluginHookProvider();
  const capability = vkDirectoryMoveCapability(hookProvider);
  if (
    capability.kind === "absent" &&
    hasLanePilotRunMetadata(deps, args.thread.id)
  ) {
    return toolCallFailure(
      "Cannot update environment directory: Lane Pilot directory move checkpoint is unavailable.",
    );
  }
  if (capability.kind === "unavailable") {
    return toolCallFailure(
      `Cannot update environment directory: ${capability.reason}`,
    );
  }
  const sourcePath =
    capability.kind === "absent" ? null : args.currentEnvironment.path;
  if (capability.kind !== "absent" && sourcePath === null) {
    return toolCallFailure(
      "Cannot update environment directory because the current environment has no resolved directory.",
    );
  }

  const existingEnvironment = findProjectEnvironmentByHostPath(
    deps.db,
    args.thread.projectId,
    args.currentEnvironment.hostId,
    normalizedPath,
  );
  let createdEnvironment = false;
  let targetEnvironment: ReadyEnvironment;

  if (existingEnvironment) {
    const ready = resolveReadyEnvironment(existingEnvironment);
    if ("failure" in ready) {
      return toolCallFailure(ready.failure);
    }
    targetEnvironment = ready;
  } else {
    const dataDir = findHostDataDir(deps, args.currentEnvironment.hostId);
    const refusal = suppliedWorkspacePathRefusal(deps.db, {
      dataDir,
      hostId: args.currentEnvironment.hostId,
      path: normalizedPath,
      projectId: args.thread.projectId,
    });
    if (refusal !== null) {
      return toolCallFailure(`${refusal}. Use a different directory.`);
    }
    const provisionedEnvironment = await provisionUnmanagedEnvironmentForPath(
      deps,
      {
        currentEnvironment: args.currentEnvironment,
        path: normalizedPath,
        thread: args.thread,
      },
    );

    if ("success" in provisionedEnvironment) {
      return provisionedEnvironment;
    }
    targetEnvironment = provisionedEnvironment;
    createdEnvironment = true;
  }

  let moveInput: VkDirectoryMoveInput | null = null;
  if (capability.kind !== "absent") {
    moveInput = {
      phase: "prepare",
      operationId: directoryMoveOperationId({
        projectId: args.thread.projectId,
        threadId: args.thread.id,
        sourceEnvironmentId: args.currentEnvironment.id,
        sourcePath,
        targetEnvironmentId: targetEnvironment.id,
        targetPath: targetEnvironment.path,
      }),
      threadId: args.thread.id,
      projectId: args.thread.projectId,
      source: {
        environmentId: args.currentEnvironment.id,
        hostId: args.currentEnvironment.hostId,
        path: sourcePath,
      },
      target: {
        environmentId: targetEnvironment.id,
        hostId: targetEnvironment.hostId ?? args.currentEnvironment.hostId,
        path: targetEnvironment.path,
      },
    };
    const prepared = await invokeVkDirectoryMove(hookProvider, moveInput);
    if (!prepared.ok) {
      return toolCallFailure(
        `Cannot update environment directory: ${prepared.error}`,
      );
    }
  }

  let attachResult: AttachEnvironmentResult;
  try {
    assertEnvironmentPathAvailable(deps, {
      ...targetEnvironment,
      threadId: args.thread.id,
    });
    attachResult = attachReadyEnvironment(deps, {
      currentEnvironment: args.currentEnvironment,
      createdEnvironment,
      targetEnvironment,
      thread: args.thread,
      turnId: args.turnId,
    });
  } catch (error) {
    if (
      moveInput !== null &&
      getThread(deps.db, args.thread.id)?.environmentId === targetEnvironment.id
    ) {
      attachResult = { kind: "attached", changed: true };
    } else {
      if (moveInput !== null) {
        const aborted = await invokeVkDirectoryMove(hookProvider, {
          ...moveInput,
          phase: "abort",
        });
        if (!aborted.ok) {
          return toolCallFailure(
            `${error instanceof Error ? error.message : String(error)}; directory move cleanup failed: ${aborted.error}`,
          );
        }
      }
      return toolCallFailure(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  switch (attachResult.kind) {
    case "attached": {
      if (moveInput !== null) {
        const committed = await invokeVkDirectoryMove(hookProvider, {
          ...moveInput,
          phase: "commit",
        });
        if (!committed.ok) {
          return toolCallFailure(
            `Environment directory attached, but rollover is pending: ${committed.error}`,
          );
        }
      }
      return toolCallSuccess(successMessage(targetEnvironment.path));
    }
    case "environment_changed": {
      if (moveInput !== null) {
        const aborted = await invokeVkDirectoryMove(hookProvider, {
          ...moveInput,
          phase: "abort",
        });
        if (!aborted.ok) {
          return toolCallFailure(
            `Directory move cleanup failed: ${aborted.error}`,
          );
        }
      }
      return toolCallFailure(
        "Thread environment changed while preparing the new directory. Try again with the desired path.",
      );
    }
    case "thread_unavailable": {
      if (moveInput !== null) {
        const aborted = await invokeVkDirectoryMove(hookProvider, {
          ...moveInput,
          phase: "abort",
        });
        if (!aborted.ok) {
          return toolCallFailure(
            `Directory move cleanup failed: ${aborted.error}`,
          );
        }
      }
      return toolCallFailure(attachResult.message);
    }
  }
}

export async function handleUpdateEnvironmentDirectoryToolCall(
  deps: AppDeps,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
): Promise<ToolCallResponse> {
  return withThreadMoveLock(args.thread.id, () =>
    performUpdateEnvironmentDirectoryToolCall(deps, args),
  );
}
