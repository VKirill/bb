# bb — VK experimental fork

> [!IMPORTANT]
> This is **not** the official bb. It is a personal fork of
> [get-bb/bb](https://github.com/get-bb/bb) with a small set of experimental core
> functions on top of an upstream release tag. For bb itself (desktop app,
> docs, Discord) go to the [official repository](https://github.com/get-bb/bb).
> Nothing here is supported by the bb team.

| | |
|---|---|
| Branch | [`vk/experimental`](https://github.com/VKirill/bb/tree/vk/experimental) |
| Based on | `desktop-v0.43.3` ([full diff](https://github.com/get-bb/bb/compare/desktop-v0.43.3...VKirill:bb:vk/experimental)) |
| Package version | `0.43.3`, same as upstream on purpose (see [FAQ](#faq)) |
| Status | Runs daily on the author's own bb server with ~60 plugins, Claude Code, Codex, OpenCode and Cursor |
| Upstream discussion | [get-bb/bb#4233](https://github.com/get-bb/bb/issues/4233) (supersedes #3843 and #4043) |

Every change is marked `VK EXPERIMENTAL` in code, new names use a `vk` prefix,
and logic lives in separate files. Upstream files are only touched at hook
points, all listed in [VK_PATCHES.md](VK_PATCHES.md). That keeps a rebase onto
each new upstream tag small and predictable.

## Contents

- [What the fork adds](#what-the-fork-adds)
  - [1. Session context policy](#1-session-context-policy)
  - [2. Context contributions](#2-context-contributions)
  - [3. Excluded plugins disappear from the place](#3-excluded-plugins-disappear-from-the-place)
  - [4. Fast tier for helper inference](#4-fast-tier-for-helper-inference)
  - [5. Language of generated thread titles](#5-language-of-generated-thread-titles)
- [Plugins that use it](#plugins-that-use-it)
- [Install](#install)
- [Update to a new upstream release](#update-to-a-new-upstream-release)
- [Roll back to official bb](#roll-back-to-official-bb)
- [FAQ](#faq)
- [Limitations](#limitations)
- [For plugin authors](#for-plugin-authors)

## What the fork adds

### 1. Session context policy

Out of the box, **everything** installed enters **every** agent session: every
BB plugin's instructions, tools, skills and env; every provider-native skill,
MCP server and CLI plugin (`~/.claude.json`, `~/.codex/config.toml`,
`~/.claude/plugins`, `~/.agents/skills`, …); the project's `CLAUDE.md` /
`AGENTS.md` chain and `<dataDir>/AGENTS.md`.

The fork adds one plugin API that narrows this per session:

```ts
bb.agents.experimental_vkSessionPolicy(resolver);
// resolver(ctx) -> VkSessionPolicy | null, same ctx as bb.agents.configure()
```

```ts
type VkFilter = { mode: "allow" | "deny"; names: string[] }; // "prefix*" allowed

type VkSessionPolicy = {
  bbPlugins?: VkFilter;          // BB plugins: instructions, tools, skills, env, composer UI, dispatch hooks
  skills?: VkFilter;             // skills by name, BB and provider-native
  mcpServers?: VkFilter;         // provider-native MCP servers
  nativePlugins?: VkFilter;      // CLI plugins (Claude `name@marketplace`, Codex plugin id)
  userInstructions?: boolean;    // false: drop <dataDir>/AGENTS.md
  projectInstructions?: boolean; // false: drop .bb/AGENTS.md and the CLI's CLAUDE.md/AGENTS.md chain
  claudeAiSync?: boolean;        // false: no claude.ai skill/plugin sync in Claude Code
};
```

Example — a copywriter session that sees one BB plugin, two skill families,
no MCP servers and no project instructions:

```json
{
  "bbPlugins": { "mode": "allow", "names": ["env-catalog"] },
  "skills": { "mode": "allow", "names": ["ru-text", "lane-stack:copy-*"] },
  "mcpServers": { "mode": "allow", "names": [] },
  "projectInstructions": false
}
```

How it is applied:

- **Core (BB side):** tools, static and dynamic instructions and provider env of
  excluded plugins are removed; BB skills are resolved against the catalog into
  an exact deny list.
- **Provider bridges (native side):** the rest goes to the bridge as provider
  option `vkSessionPolicy`. No separate `HOME`, `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` is created, so login and session resume keep working.
- The shared skill catalog of an environment is **not** changed. Each session
  gets a filtered twin of symlinks, so two threads with different policies in one
  environment do not disturb each other.
- The policy is resolved at `thread.start` and `turn.submit`, i.e. when the
  provider session starts and when it is resumed.

| Provider | BB skills | Native skills | MCP servers | CLI plugins | Project instructions |
|---|---|---|---|---|---|
| Claude Code | filtered skill plugin dir | SDK `skills` / `skillOverrides` + `Skill()` deny | `strictMcpConfig` + copied configs / `deniedMcpServers` | `enabledPlugins: false` | `claudeMdExcludes` |
| Codex | filtered extra roots | `-c skills.config=[…enabled=false]` | `-c mcp_servers.<n>.enabled=false` | `-c plugins.<id>.enabled=false` | `-c project_doc_max_bytes=0` |
| OpenCode (ACP) | filtered instruction list | `permission.skill` via `OPENCODE_CONFIG_CONTENT` | `mcp.<n>.enabled=false` | — | `OPENCODE_DISABLE_PROJECT_CONFIG=1` |
| Cursor (ACP) | filtered instruction list | — | per-policy `CURSOR_DATA_DIR` overlay with its own `mcp-disabled.json` | — | — |

Rules:

- `null` means "no opinion": the session is built exactly as in upstream bb.
- First non-null answer wins, in plugin id order. Policies are **not merged**.
- A throw, an invalid shape or more than 2 s is logged and treated as `null`
  (fail open).
- The plugin whose policy won is never excluded by it.
- Some things can't be excluded by any policy: `environment-project-checkout`
  (without it bb can't run or show threads) and `bb-bridge`, the MCP channel
  through which plugin tools reach the agent.

### 2. Context contributions

```ts
bb.agents.experimental_vkContextContributions();
// -> [{ pluginId, required, instructions, configure, tools: string[], skills: string[] }]
```

Lists what each running plugin adds to agent sessions, so a policy editor can
label its switches ("adds instructions, 5 tools, 3 skills") and lock the
`required` ones.

### 3. Excluded plugins disappear from the place

If a policy leaves a plugin out, bb behaves there as if the plugin were not
installed: its composer buttons, banners and chips are not rendered, and
`message.dispatch` skips its hooks and drops its composer submission.

```http
GET /api/v1/plugins/vk-excluded-plugins?threadId=thr_…
GET /api/v1/plugins/vk-excluded-plugins?projectId=…&hostId=…&environmentId=…&path=…
→ { "pluginIds": ["agency"] }
```

The second form serves a new thread that doesn't exist yet: the new-thread
composer passes its place (project, host, environment, section folder).

### 4. Fast tier for helper inference

`BB_INFERENCE_SERVICE_TIER` = `fast` | `default`. With `fast`, helper inference
(thread titles, metadata) goes through the Codex AI service with
`service_tier=priority`, the id Codex lists for Fast.

### 5. Language of generated thread titles

`BB_THREAD_TITLE_LANGUAGE`, e.g. `Russian`. Without it the title prompt names no
language and models often answer in English. With it titles are written in that
language; unset, they follow the task's own language.

Both settings are regular bb managed config keys: put them in
`<dataDir>/env.json` (usually `~/.bb/env.json`) and restart the server.

```json
{ "BB_INFERENCE_SERVICE_TIER": "fast", "BB_THREAD_TITLE_LANGUAGE": "Russian" }
```

## Plugins that use it

Both plugins feature-test the API and work on official bb without it; they only
hide the parts that need the fork.

- **[bb-plugin-project-folders](https://github.com/VKirill/bb-plugin-project-folders)** —
  tab «Session context»: policy for the whole bb, a project and a section
  (folder), inherited down the tree. The reference consumer.
- **[bb-plugin-agency](https://github.com/VKirill/bb-plugin-agency)** *(alpha,
  in active development)* — standing employees, departments, jobs, versioned
  results and acceptance. Each employee's context (skills, MCP servers, CLI
  plugins, BB plugins) is frozen in the launch snapshot and applied through the
  session policy, so a marketer, a developer and a reviewer get different tools,
  and a reused reviewer thread keeps its original policy on resume.

## Install

You build an npm tarball from the fork and run it as your bb server, side by
side with the official install. Your data directory, database and plugins stay
where they are.

> [!WARNING]
> Back up your data directory first (`~/.bb` by default, or `$BB_DATA_DIR`).
> Stop the running bb server before starting the fork against the same data
> directory. The fork has **no database migrations of its own**, but the
> upstream base does: only switch between the fork and an official build of the
> **same** upstream version (see [FAQ](#faq)).

Requirements: Node `22.19+` (or 24/26), pnpm 9, git, the provider CLIs you
already use.

### 1. Get the source

```sh
git clone https://github.com/get-bb/bb.git bb-source
cd bb-source
git remote add vk https://github.com/VKirill/bb.git
git fetch vk
git switch -c vk/experimental vk/vk/experimental
```

Cloning upstream first and adding the fork as a second remote makes later
updates a plain rebase onto the next upstream tag.

### 2. Build and pack

```sh
pnpm install
pnpm turbo run build --filter=bb-app...
cd packages/bb-app
npm pack --pack-destination /tmp          # -> /tmp/bb-app-0.43.3.tgz
```

### 3. Install into its own runtime folder

One folder per build, so rollback is switching a path:

```sh
R=~/.local/share/bb-runtime-0.43.3-vk
mkdir -p "$R" && cd "$R"
echo '{"name":"bb-runtime","private":true}' > package.json
npm i --omit=dev /tmp/bb-app-0.43.3.tgz
# npm 12+: npm i --omit=dev --allow-scripts=better-sqlite3,node-pty,@parcel/watcher /tmp/bb-app-0.43.3.tgz
```

### 4. Run

Foreground, same as `npx bb-app`:

```sh
node ~/.local/share/bb-runtime-0.43.3-vk/node_modules/bb-app/dist/bb-app.js
```

Open `http://localhost:38886`.

As a server (Linux, systemd) — point the existing unit at the fork's server
entry with a drop-in instead of editing the unit:

```ini
# /etc/systemd/system/bb-server.service.d/runtime.conf
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/<you>/.local/share/bb-runtime-0.43.3-vk/node_modules/bb-app/dist/bb-server.js
```

```sh
sudo systemctl daemon-reload && sudo systemctl restart bb-server
```

### 5. Check

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:38886   # 200
bb plugin list                                                      # all plugins running
```

With bb-plugin-project-folders installed, its «Session context» tab appears
only on the fork — that is the quickest sign the API is live. To check a policy
for real, start a thread in a restricted place and ask the agent which skills,
MCP servers and tools it has, or look at the CLI process arguments.

## Update to a new upstream release

```sh
cd bb-source
git fetch origin --tags && git fetch vk
git switch vk/experimental
git rebase desktop-v<new>          # conflicts only at hook points from VK_PATCHES.md
pnpm install
pnpm --filter @bb/domain test
pnpm --filter @bb/server test -- test/threads test/services/plugins
pnpm turbo run build --filter=bb-app...
```

Then pack and install into a **new** runtime folder (`bb-runtime-<new>-vk`),
switch the path, restart, check. Keep the previous folder until the new one has
run for a while.

> [!TIP]
> If you don't want to rebase yourself, wait until `vk/experimental` on this
> fork is moved to the new tag (the base tag is in the table at the top), then
> `git fetch vk && git reset --hard vk/vk/experimental` and rebuild.

When a rebase conflicts, [VK_PATCHES.md](VK_PATCHES.md) lists every upstream
file the fork touches and why. `README.md` is replaced by this file: on a
conflict, keep the fork's version.

## Roll back to official bb

1. Stop the fork's server.
2. Start the official build of the **same** version: `npx bb-app@0.43.3`, the
   desktop app of that version, or point the systemd drop-in back to the
   official runtime.
3. Nothing else: no database rollback is needed. Plugins that use the API hide
   their fork-only UI; stored policies are simply not applied.

## FAQ

<details>
<summary><b>Is it safe to run against my existing data directory?</b></summary>

The fork adds no tables, columns or migrations. Policies are stored by the
plugins that define them, not by core. The risk is the usual one of running a
custom build: back up `~/.bb` first, and keep the fork on the same upstream
version as the official build you may roll back to.
</details>

<details>
<summary><b>Why is the package version 0.43.3 and not something like 0.43.3-vk?</b></summary>

`bb-host-daemon` on your machines compares its version with the server. A
different version string breaks that handshake. Tell builds apart by the runtime
folder name and by `VK_PATCHES.md` in the source.
</details>

<details>
<summary><b>Can I use the desktop app?</b></summary>

The desktop app bundles its own official server. The fork is used as a server
(`bb-app.js` / `bb-server.js`) that you open in a browser, or that your machines
connect to as a remote bb server.
</details>

<details>
<summary><b>What happens on official bb to a plugin that uses these APIs?</b></summary>

`bb.agents.experimental_vkSessionPolicy` is `undefined` there. Plugins must check
`typeof bb.agents.experimental_vkSessionPolicy === "function"` and hide the
feature. project-folders and Agency do exactly that.
</details>

<details>
<summary><b>Two plugins both return a policy. Which one wins?</b></summary>

The first non-null answer in plugin id order. Policies are not merged. So a
plugin should answer only for its own threads (e.g. `ctx.origin.pluginId` or
its thread metadata) and return `null` for the rest. Merging (intersect allow,
union deny) is a possible next step.
</details>

<details>
<summary><b>Allow-list or deny-list?</b></summary>

Both, per category. `allow` keeps only the listed names, `deny` removes the
listed ones. A trailing `*` is a prefix match. An empty `allow` list removes the
whole category (e.g. no MCP servers at all).
</details>

<details>
<summary><b>Does the policy survive a resume or a restart?</b></summary>

It is resolved again on every `thread.start` and `turn.submit`, so it applies on
resume as long as the plugin still returns it. Agency freezes a policy per
launch for that reason. Changing a policy in the middle of a live provider
session is not guaranteed to reach it; open a new thread after changing rules.
</details>

<details>
<summary><b>Can a denied plugin still reach the agent some other way?</b></summary>

Its tools, instructions, skills and provider env are removed, its composer UI
is hidden and its dispatch hooks are skipped. `bb-bridge` and
`environment-project-checkout` always stay, because bb doesn't work without them.
</details>

<details>
<summary><b>Will this be merged into bb?</b></summary>

That is up to the bb team; the proposal is
[#4233](https://github.com/get-bb/bb/issues/4233). The `vk` prefix only keeps the
patches apart during rebases; upstream names would drop it.
</details>

## Limitations

| What | Status |
|---|---|
| Cursor: native skills and project instructions | not filtered, Cursor has no such switches |
| Codex MCP | only servers defined in `config.toml` can be disabled |
| Codex built-in ChatGPT plugin servers (`cua_repl`) | not filtered |
| OpenCode, Cursor: CLI plugins | not filtered |
| Several plugins returning policies | no merge, first non-null wins |
| Policy change inside a running provider session | apply by opening a new thread |

## For plugin authors

- Full guide (Russian): [VK_FUNCTIONS.md](VK_FUNCTIONS.md) — context fields,
  policy format, what core and each bridge do, how to scope a policy to your own
  threads, live checks.
- Upstream hook points and new files: [VK_PATCHES.md](VK_PATCHES.md).
- Policy format: [`packages/domain/src/vk-session-policy.ts`](packages/domain/src/vk-session-policy.ts).
- Plugin API contract: [`packages/plugin-sdk/src/backend-contract.ts`](packages/plugin-sdk/src/backend-contract.ts) (`PluginAgents`).
- The published `@get-bb/plugin-sdk` has no types for these APIs: declare them
  locally, as project-folders does.

Minimal resolver that answers only for its own threads:

```ts
type VkAgents = {
  experimental_vkSessionPolicy?: (
    resolver: (ctx: any) => VkSessionPolicy | null | Promise<VkSessionPolicy | null>,
  ) => void;
};

const agents = bb.agents as unknown as VkAgents;
if (typeof agents.experimental_vkSessionPolicy === "function") {
  agents.experimental_vkSessionPolicy((ctx) => {
    if (ctx.origin.pluginId !== "my-plugin") return null; // not our thread
    return policyForRole(ctx.pluginMetadata.role);        // metadata written at spawn
  });
}
```

## License

Same as upstream bb; see [LICENSE](LICENSE).
