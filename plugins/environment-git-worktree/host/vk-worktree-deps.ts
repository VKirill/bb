// VK EXPERIMENTAL: a new worktree gets the source checkout's installed packages as links, one copy on disk. A worktree has no ignored
// files, so the agent in a fresh worktree chat found no node_modules and ran `npm ci`: 1.9 GB per SelfyStudio worktree, 18 GB on one
// machine (2026-10-23). The same mirror Lane Pilot gives its writers (src/rooms/verification/git-integrate.ts): every package of
// node_modules is a link to the checkout's copy; a link back into the repository (a workspace package) points at the worktree's own
// copy; npm's own state, generated clients and tool caches get their own copies or folders, so a check in the worktree never writes
// into the checkout. Root, declared workspaces and nested packages (an app in a subfolder with its own install) are mirrored.
// `BB_VK_WORKTREE_DEPS=0` turns it off; a worktree that already has node_modules is left alone.
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "bb-environment-provider-host/git";

const CACHE_DIRS = new Set([".vite-temp", ".vite", ".vitest", ".cache"]);
const WRITABLE_COPIES = new Set([".prisma", "@prisma/client"]);
const NPM_STATE = new Set([".bin", ".package-lock.json"]);
const MAX_NESTED = 20;

const isDir = async (target: string) => (await fs.stat(target).catch(() => null))?.isDirectory() ?? false;
const exists = async (target: string) => (await fs.lstat(target).catch(() => null)) !== null;

async function workspaceDirs(sourcePath: string): Promise<string[]> {
  const manifest = await fs.readFile(path.join(sourcePath, "package.json"), "utf8").then((text) => JSON.parse(text) as { workspaces?: string[] | { packages?: string[] } }).catch(() => null);
  const patterns = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages ?? [];
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.startsWith("/") || pattern.includes("..")) continue;
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const name of await fs.readdir(path.join(sourcePath, parent)).catch(() => [] as string[])) {
        if (!name.startsWith(".") && (await fs.stat(path.join(sourcePath, parent, name, "package.json")).catch(() => null))?.isFile()) dirs.push(path.join(parent, name));
      }
    } else if (!pattern.includes("*") && (await fs.stat(path.join(sourcePath, pattern, "package.json")).catch(() => null))?.isFile()) dirs.push(pattern);
  }
  return [...new Set(dirs)].sort();
}

async function nestedPackageDirs(sourcePath: string, targetPath: string, taken: readonly string[]): Promise<string[]> {
  const stdout = (await runGit(["ls-files", "-z", "--", ":(glob)**/package.json"], { cwd: targetPath }).catch(() => null))?.stdout ?? "";
  const dirs: string[] = [];
  for (const file of stdout.split("\0").filter(Boolean)) {
    const dir = path.dirname(file);
    if (dir === "." || taken.includes(dir) || dir.split("/").length > 3 || dir.split("/").includes("node_modules")) continue;
    if (await isDir(path.join(sourcePath, dir, "node_modules"))) dirs.push(dir);
    if (dirs.length >= MAX_NESTED) break;
  }
  return [...new Set(dirs)].sort();
}

async function mirrorNodeModules(sourceReal: string, targetPath: string, dir: string): Promise<boolean> {
  const base = path.join(sourceReal, dir, "node_modules"), target = path.join(targetPath, dir, "node_modules");
  if (!(await isDir(base)) || !(await isDir(path.dirname(target))) || (await exists(target))) return false;
  const inRepo = (real: string) => (real === sourceReal || real.startsWith(`${sourceReal}/`)) && !real.startsWith(`${base}/`);
  await fs.mkdir(target);
  const linkEntry = async (rel: string[]) => {
    const source = path.join(base, ...rel), destination = path.join(target, ...rel);
    if (WRITABLE_COPIES.has(rel.join("/"))) {
      await fs.cp(source, destination, { recursive: true, dereference: true, errorOnExist: false }).catch(async () => { await fs.mkdir(destination, { recursive: true }); });
      return;
    }
    const info = await fs.lstat(source);
    if (info.isSymbolicLink()) {
      const real = await fs.realpath(source).catch(() => null);
      if (real && inRepo(real)) { await fs.symlink(path.join(targetPath, path.relative(sourceReal, real)), destination, "dir"); return; }
    }
    const followed = await fs.stat(source).catch(() => null);
    await fs.symlink(source, destination, followed?.isDirectory() ? "dir" : "file");
  };
  for (const name of await fs.readdir(base)) {
    if (CACHE_DIRS.has(name)) { await fs.mkdir(path.join(target, name)); continue; }
    if (NPM_STATE.has(name) && !(await fs.lstat(path.join(base, name))).isSymbolicLink()) {
      await fs.cp(path.join(base, name), path.join(target, name), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: false });
      continue;
    }
    if (name.startsWith("@") && !(await fs.lstat(path.join(base, name))).isSymbolicLink() && (await fs.stat(path.join(base, name))).isDirectory()) {
      await fs.mkdir(path.join(target, name));
      for (const child of await fs.readdir(path.join(base, name))) await linkEntry([name, child]);
    } else {
      await linkEntry([name]);
    }
  }
  return true;
}

/** Links the source checkout's node_modules folders into a new worktree; returns the folders it linked. Never throws. */
export async function vkLinkWorktreeDependencies(args: { sourcePath: string; targetPath: string; env?: NodeJS.ProcessEnv }): Promise<string[]> {
  if ((args.env ?? process.env).BB_VK_WORKTREE_DEPS === "0") return [];
  try {
    const sourceReal = await fs.realpath(args.sourcePath);
    if (await exists(path.join(args.targetPath, "node_modules"))) return [];
    const workspaces = await workspaceDirs(sourceReal);
    const nested = await nestedPackageDirs(sourceReal, args.targetPath, workspaces);
    const linked: string[] = [];
    for (const dir of ["", ...workspaces, ...nested]) {
      if (await mirrorNodeModules(sourceReal, args.targetPath, dir).catch(() => false)) linked.push(dir ? path.join(dir, "node_modules") : "node_modules");
    }
    return linked;
  } catch {
    return [];
  }
}
