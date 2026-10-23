import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vkLinkWorktreeDependencies } from "./vk-worktree-deps.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

async function repo() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vk-deps-")));
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "node_modules", "lodash"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", "@scope", "b"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", ".vite"), { recursive: true });
  await fs.mkdir(path.join(source, "libs", "own"), { recursive: true });
  await fs.writeFile(path.join(source, "libs", "own", "index.js"), "export {};\n");
  await fs.symlink(path.join(source, "libs", "own"), path.join(source, "node_modules", "own"), "dir");
  await fs.mkdir(path.join(source, "intro-video", "node_modules", "remotion"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), "{}\n");
  await fs.writeFile(path.join(source, "intro-video", "package.json"), "{}\n");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  git(source, "init", "-q"); git(source, "add", "-A"); git(source, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const target = path.join(root, "wt");
  git(source, "worktree", "add", "-q", target);
  return { source, target };
}

describe("VK: a new worktree reuses the checkout's installed packages", () => {
  it("links each package to the checkout, keeps the repo's own package in the worktree, copies npm state, and mirrors a nested package", async () => {
    const { source, target } = await repo();
    expect(await vkLinkWorktreeDependencies({ sourcePath: source, targetPath: target, env: {} })).toEqual(["node_modules", "intro-video/node_modules"]);
    expect(await fs.readlink(path.join(target, "node_modules", "lodash"))).toBe(path.join(source, "node_modules", "lodash"));
    expect(await fs.readlink(path.join(target, "node_modules", "@scope", "b"))).toBe(path.join(source, "node_modules", "@scope", "b"));
    expect(await fs.readlink(path.join(target, "node_modules", "own"))).toBe(path.join(target, "libs", "own"));
    expect((await fs.lstat(path.join(target, "node_modules", ".bin"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(target, "node_modules", ".vite"))).isDirectory()).toBe(true);
    expect(await fs.readlink(path.join(target, "intro-video", "node_modules", "remotion"))).toBe(path.join(source, "intro-video", "node_modules", "remotion"));
    expect(git(target, "status", "--porcelain")).toBe("");
  });

  it("leaves a worktree that has node_modules alone, and does nothing when turned off", async () => {
    const { source, target } = await repo();
    expect(await vkLinkWorktreeDependencies({ sourcePath: source, targetPath: target, env: { BB_VK_WORKTREE_DEPS: "0" } })).toEqual([]);
    await fs.mkdir(path.join(target, "node_modules"));
    expect(await vkLinkWorktreeDependencies({ sourcePath: source, targetPath: target, env: {} })).toEqual([]);
  });
});
