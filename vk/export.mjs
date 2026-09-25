import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
const base = "e865697f5";
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || existsSync(output))
  throw new Error("Pass a new absolute output directory");
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (git("status", "--porcelain").trim())
  throw new Error("Commit changes before exporting");
mkdirSync(join(output, "patches"), { recursive: true });
const head = git("rev-parse", "HEAD").trim();
const upstream = git("rev-parse", base).trim();
const additions = git(
  "diff",
  "--no-renames",
  "--diff-filter=A",
  "--name-only",
  upstream,
  head,
)
  .trim()
  .split("\n")
  .filter(Boolean);
const glue = git(
  "diff",
  "--no-renames",
  "--diff-filter=MD",
  "--name-only",
  upstream,
  head,
)
  .trim()
  .split("\n")
  .filter(Boolean);
for (const file of additions) {
  const destination = join(output, "modules", file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
}
writeFileSync(
  join(output, "integration.patch"),
  git(
    "diff",
    "--binary",
    "--full-index",
    "--no-renames",
    upstream,
    head,
    "--",
    ...glue,
  ),
);
git(
  "format-patch",
  "--binary",
  "--full-index",
  "--output-directory",
  join(output, "patches"),
  `${upstream}..${head}`,
);
git("bundle", "create", join(output, "vk-core.bundle"), `${upstream}..${head}`);
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      upstream,
      head,
      protocol: 215,
      modules: additions,
      connectionFiles: glue,
      optional216: "Not included: vk/required-session-policy",
    },
    null,
    2,
  ),
);
copyFileSync("docs/vk-experimental.md", join(output, "README.md"));
console.log(
  JSON.stringify({
    output,
    head,
    modules: additions.length,
    connectionFiles: glue.length,
  }),
);
