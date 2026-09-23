import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * BB stages one skills root per environment and every bridge process shares
 * it, so a per-thread session policy cannot narrow the root itself. Instead a
 * bridge swaps the shared root for a filtered twin: a directory of symlinks
 * to every skill except the denied ones. The twin is content-addressed by
 * (root, denied names), so threads with the same policy share it and a
 * repeated call is a cheap `existsSync`.
 */
export function vkFilterSkillRoot(args: {
  cacheDir: string;
  deniedNames: ReadonlySet<string>;
  rootPath: string;
}): string {
  if (args.deniedNames.size === 0) return args.rootPath;
  const entries = listSkillDirs(args.rootPath);
  if (!entries.some((name) => args.deniedNames.has(name))) {
    return args.rootPath;
  }
  const key = createHash("sha256")
    .update(args.rootPath)
    .update("\0")
    .update([...args.deniedNames].sort().join("\0"))
    .digest("hex")
    .slice(0, 16);
  const target = join(args.cacheDir, `vk-skills-${key}`);
  if (existsSync(target)) return target;
  mkdirSync(args.cacheDir, { recursive: true });
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  for (const name of entries) {
    if (args.deniedNames.has(name)) continue;
    symlinkSync(join(args.rootPath, name), join(staging, name));
  }
  try {
    renameSync(staging, target);
  } catch (error) {
    // A concurrent thread built the same twin first; theirs is identical.
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(target)) throw error;
  }
  return target;
}

/** The skill directory names directly under a skills root. */
function listSkillDirs(rootPath: string): string[] {
  let names: string[];
  try {
    names = readdirSync(rootPath);
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return statSync(join(rootPath, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
