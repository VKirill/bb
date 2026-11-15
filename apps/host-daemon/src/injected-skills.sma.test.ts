import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import { stageInjectedSkillSources } from "./injected-skills.js";

async function writeSkill(
  rootPath: string,
  name: string,
  body: string,
): Promise<string> {
  const skillRootPath = path.join(rootPath, name);
  await mkdir(skillRootPath, { recursive: true });
  await writeFile(
    path.join(skillRootPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use ${name} in the staging proof.\n---\n\n${body}\n`,
    "utf8",
  );
  return skillRootPath;
}

function source(
  skillRootPath: string,
  name: string,
  kind: "workspace-path" | "host-path",
): HostDaemonInjectedSkillSource {
  const base = {
    name,
    description: `Use ${name} in the staging proof.`,
    sourceRootPath: skillRootPath,
    skillFilePath: path.join(skillRootPath, "SKILL.md"),
  };
  return kind === "workspace-path"
    ? { kind: "workspace-path", sourceType: "project", ...base }
    : { kind: "host-path", sourceType: "shared-user", ...base };
}

describe("managed skills staged for every runtime (SMA proofs)", () => {
  it("[sma:k_c_syncskills] managed skills from a project and from the shared user folder land in one catalog with their bytes, listed by name whatever order they arrive in; no skill stages nothing", async () => {
    const dataDir = await makeTempDir();
    const sources = path.join(dataDir, "sources");
    const zeta = await writeSkill(sources, "zeta-skill", "zeta body");
    const alpha = await writeSkill(sources, "alpha-skill", "alpha body");
    const forward = [
      source(zeta, "zeta-skill", "workspace-path"),
      source(alpha, "alpha-skill", "host-path"),
    ];

    const staged = await stageInjectedSkillSources({
      workspacePath: dataDir,
      dataDir,
      injectedSkillSources: forward,
    });
    expect(staged.skillRoots).toHaveLength(1);
    const root = staged.skillRoots[0]!;
    expect(root.skills.map((skill) => skill.name)).toEqual([
      "alpha-skill",
      "zeta-skill",
    ]);
    await expect(
      readFile(path.join(root.path, "alpha-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("alpha body");
    await expect(
      readFile(path.join(root.path, "zeta-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("zeta body");

    const reversed = await stageInjectedSkillSources({
      workspacePath: dataDir,
      dataDir,
      injectedSkillSources: [...forward].reverse(),
    });
    expect(reversed.catalogHash).toBe(staged.catalogHash);
    expect(reversed.skillRoots[0]?.skills.map((skill) => skill.name)).toEqual([
      "alpha-skill",
      "zeta-skill",
    ]);

    const none = await stageInjectedSkillSources({
      workspacePath: dataDir,
      dataDir,
      injectedSkillSources: [],
    });
    expect(none.skillRoots).toEqual([]);
    expect(none.catalogHash).not.toBe(staged.catalogHash);
  });
});
