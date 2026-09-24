import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import type { VkSessionPolicy } from "@bb/domain/vk-session-policy";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../src/services/threads/thread-commands.js";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { resolveVkExcludedPluginIds } from "../../src/services/threads/vk-excluded-plugins.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

// VK EXPERIMENTAL: core's half of a plugin-supplied session policy.

async function writeSkill(rootPath: string, name: string): Promise<void> {
  await mkdir(path.join(rootPath, name), { recursive: true });
  await writeFile(
    path.join(rootPath, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use ${name} in vk tests.\n---\n`,
    "utf8",
  );
}

function stub(policy: VkSessionPolicy | null): void {
  setPluginAgentContributions({
    listSkillRootContributions: () => [],
    listAgentTools: () => [
      {
        pluginId: "keep",
        tool: { name: "keep_tool", description: "kept", inputSchema: {} },
        instructions: "Use keep_tool.",
      },
      {
        pluginId: "drop",
        tool: { name: "drop_tool", description: "dropped", inputSchema: {} },
        instructions: "Use drop_tool.",
      },
    ],
    listInstructionContributions: () => [
      { pluginId: "keep", provider: () => "keep instructions" },
      { pluginId: "drop", provider: () => "drop instructions" },
    ],
    findAgentTool: () => undefined,
    invokeAgentTool: async () => ({
      success: false,
      contentItems: [{ type: "inputText", text: "unused" }],
    }),
    resolveMention: async () => ({ ok: false, error: "unused" }),
    resolveProviderEnv: async () => ({
      entries: [
        {
          name: "KEEP_ENV",
          value: "1",
          source: { plugin: "keep" },
          reason: "test",
        },
        {
          name: "DROP_ENV",
          value: "1",
          source: { plugin: "drop" },
          reason: "test",
        },
      ],
    }),
    resolveVkSessionPolicy: async () =>
      policy === null ? null : { pluginId: "project-folders", policy },
  });
}

async function seed(harness: TestAppHarness, hostId: string) {
  seedHostSession(harness.deps, { id: hostId });
  const workspacePath = path.join(harness.config.dataDir, `${hostId}-ws`);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId,
    path: workspacePath,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId,
    projectId: project.id,
    path: workspacePath,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  return { environment, project, thread, workspacePath };
}

describe("vk session policy", () => {
  afterEach(() => setPluginAgentContributions(undefined));

  it("drops denied plugins' tools and instructions and user instructions", async () => {
    await withTestHarness(async (harness) => {
      await writeFile(
        path.join(harness.config.dataDir, "AGENTS.md"),
        "user rules",
        "utf8",
      );
      const { environment, thread, workspacePath } = await seed(
        harness,
        "host-vk-drop",
      );
      await mkdir(path.join(workspacePath, ".bb"), { recursive: true });
      await writeFile(
        path.join(workspacePath, ".bb", "AGENTS.md"),
        "project rules",
        "utf8",
      );
      stub({
        bbPlugins: { mode: "deny", names: ["drop"] },
        userInstructions: false,
        projectInstructions: false,
      });
      const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
        thread,
        model: "test-model",
        environment,
      });
      const toolNames = config.dynamicTools.map((tool) => tool.name);
      expect(toolNames).toContain("keep_tool");
      expect(toolNames).toContain("update_environment_directory");
      expect(toolNames).not.toContain("drop_tool");
      expect(config.instructions).toContain("keep instructions");
      expect(config.instructions).toContain("Use keep_tool.");
      expect(config.instructions).not.toContain("drop instructions");
      expect(config.instructions).not.toContain("Use drop_tool.");
      expect(config.instructions).not.toContain("user rules");
      expect(config.instructions).not.toContain("project rules");
      const envNames = config.contributedEnv.map((entry) => entry.name);
      expect(envNames).toContain("KEEP_ENV");
      expect(envNames).not.toContain("DROP_ENV");
      expect(config.vkSessionPolicy).toEqual({
        version: 1,
        projectInstructions: false,
      });
    });
  });

  it("resolves BB skills to exact denied names and sends them to the bridge", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, thread, workspacePath } = await seed(
        harness,
        "host-vk-skills",
      );
      const skillsRoot = path.join(harness.config.dataDir, "skills");
      await writeSkill(skillsRoot, "ru-text");
      await writeSkill(skillsRoot, "web-design");
      await writeSkill(path.join(workspacePath, ".bb", "skills"), "local-one");
      stub({
        skills: { mode: "allow", names: ["ru-text"] },
        mcpServers: { mode: "deny", names: ["discord-web"] },
      });
      const execution = await buildExecutionOptions(
        harness.deps,
        { model: "gpt-5" },
        { threadId: thread.id },
      );
      const command = await buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        syncGeneratedTitle: false,
        thread,
      });
      expect(command.options.providerOptions.vkSessionPolicy).toEqual({
        version: 1,
        bbSkillsDenied: ["local-one", "web-design"],
        skills: { mode: "allow", names: ["ru-text"] },
        mcpServers: { mode: "deny", names: ["discord-web"] },
      });
      // The environment's shared catalog is untouched; bridges filter it.
      expect(command.injectedSkillSources.map((s) => s.name).sort()).toEqual([
        "local-one",
        "ru-text",
        "web-design",
      ]);
    });
  });

  it("leaves the session as bb builds it when no plugin answers", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = await seed(harness, "host-vk-none");
      stub(null);
      const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
        thread,
        model: "test-model",
        environment,
      });
      expect(config.dynamicTools.map((tool) => tool.name)).toContain(
        "drop_tool",
      );
      expect(config.instructions).toContain("drop instructions");
      expect(config.contributedEnv.map((entry) => entry.name)).toContain(
        "DROP_ENV",
      );
      expect(config.vkSessionPolicy).toBeNull();
    });
  });
});

describe("vk excluded plugins", () => {
  afterEach(() => setPluginAgentContributions(undefined));

  it("lists plugins a place's policy leaves out, never the policy owner", async () => {
    await withTestHarness(async (harness) => {
      const { project, thread } = await seed(harness, "host-vk-excluded");
      setPluginAgentContributions({
        listSkillRootContributions: () => [],
        listAgentTools: () => [],
        listInstructionContributions: () => [],
        findAgentTool: () => undefined,
        invokeAgentTool: async () => ({
          success: false,
          contentItems: [{ type: "inputText", text: "unused" }],
        }),
        resolveMention: async () => ({ ok: false, error: "unused" }),
        listVkContextContributions: () =>
          ["agency", "env-catalog", "project-folders"].map((pluginId) => ({
            pluginId,
            instructions: false,
            configure: false,
            tools: [],
            skills: [],
          })),
        resolveVkSessionPolicy: async () => ({
          pluginId: "project-folders",
          policy: { bbPlugins: { mode: "allow", names: ["env-catalog"] } },
        }),
      });
      expect([
        ...(await resolveVkExcludedPluginIds(harness.deps.db, {
          threadId: thread.id,
        })),
      ]).toEqual(["agency"]);
      expect([
        ...(await resolveVkExcludedPluginIds(harness.deps.db, {
          projectId: project.id,
        })),
      ]).toEqual(["agency"]);
      expect((await resolveVkExcludedPluginIds(harness.deps.db, {})).size).toBe(
        0,
      );
    });
  });
});
