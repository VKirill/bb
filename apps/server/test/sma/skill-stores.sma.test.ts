import type { DiscoveredSkill } from "@bb/host-daemon-contract";
import { skillListResponseSchema } from "@bb/server-contract";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleSkillList } from "../../src/services/skills/skill-listing.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function discovered(
  name: string,
  rootKind: DiscoveredSkill["rootKind"],
  filePath: string,
): DiscoveredSkill {
  const digest = createHash("sha256").update(filePath).digest("hex");
  return {
    id: `skill_${digest}`,
    name,
    description: `${name} skill`,
    rootKind,
    filePath,
    realPath: filePath,
    contentSha256: digest,
    linked: false,
  };
}

describe("skill stores (core)", () => {
  it("[sma:m_hs_skill_stores] project skills and the machine library are two stores, and every listed skill names its own", () => {
    const listed = assembleSkillList([
      {
        provider: "claude-code",
        skills: [
          discovered("local-flow", "bb-project", "/work/app/.bb/skills/local-flow/SKILL.md"),
          discovered("library-flow", "bb-data-dir", "/data/skills/library-flow/SKILL.md"),
        ],
      },
    ]);
    const byName = new Map(listed.map((skill) => [skill.name, skill]));
    expect(listed).toHaveLength(2);
    expect(byName.get("local-flow")).toMatchObject({
      scope: "bb-project",
      filePath: "/work/app/.bb/skills/local-flow/SKILL.md",
      manageable: true,
    });
    expect(byName.get("library-flow")).toMatchObject({
      scope: "bb-user",
      filePath: "/data/skills/library-flow/SKILL.md",
      manageable: true,
    });
    // a skill of the same name in both stores stays two entries, each in its store
    const both = assembleSkillList([
      {
        provider: "claude-code",
        skills: [
          discovered("twin", "bb-project", "/work/app/.bb/skills/twin/SKILL.md"),
          discovered("twin", "bb-data-dir", "/data/skills/twin/SKILL.md"),
        ],
      },
    ]);
    expect(both.map((skill) => skill.scope).sort()).toEqual([
      "bb-project",
      "bb-user",
    ]);
  });

  it("[sma:m_hs_skill_create] the person's text is written into the machine's skill library on disk, only against the revision they read", async () => {
    await withTestHarness(async (harness) => {
      const skillFilePath = join(
        harness.deps.config.dataDir,
        "skills",
        "notes",
        "SKILL.md",
      );
      await mkdir(join(skillFilePath, ".."), { recursive: true });
      await writeFile(
        skillFilePath,
        "---\nname: notes\ndescription: Notes.\n---\n",
      );
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-skill-library",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/skill-library-project",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "host.list_skills") {
            return { ok: true, result: { skills: [] } };
          }
          if (
            request.command.type === "plugin.host.call" &&
            request.command.method === "resolveNativeRoots"
          ) {
            return {
              ok: true,
              result: { output: { skills: [], commands: [] } },
            };
          }
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        },
      });
      const listed = skillListResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/projects/${project.id}/skills?environmentId=`,
          ),
        ),
      );
      const skill = listed.skills.find((entry) => entry.name === "notes");
      if (skill === undefined) throw new Error("Expected the library skill");
      expect(skill.scope).toBe("bb-user");
      const read = (await readJson(
        await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content?${new URLSearchParams({
            skillId: skill.id,
            environmentId: "",
            path: "SKILL.md",
          })}`,
        ),
      )) as { revision: string };

      const personsText =
        "---\nname: notes\ndescription: Written by a person.\n---\nBody the person typed.\n";
      const save = (revision: string, content: string) =>
        harness.app.request(`/api/v1/projects/${project.id}/skills/content`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skill.id,
            environmentId: null,
            content,
            revision,
          }),
        });

      expect((await save(read.revision, personsText)).status).toBe(200);
      await expect(readFile(skillFilePath, "utf8")).resolves.toBe(personsText);

      // a stale revision does not overwrite the person's text
      const stale = await save(read.revision, "---\nname: notes\n---\nlost\n");
      expect(stale.status).toBe(409);
      await expect(readFile(skillFilePath, "utf8")).resolves.toBe(personsText);
    });
  });
});
