# bb — VK experimental fork

> [!IMPORTANT]
> This is **not** the official bb. It is a personal fork of
> [get-bb/bb](https://github.com/get-bb/bb) with a set of experimental core
> functions on top of an upstream release tag. For bb itself (desktop app,
> docs, Discord) go to the [official repository](https://github.com/get-bb/bb).
> Nothing here is supported by the bb team.

| | |
|---|---|
| Branch | [`vk/experimental`](https://github.com/VKirill/bb/tree/vk/experimental) — the only branch of this fork; old feature branches live on as `vk-archive/*` tags |
| Based on | `desktop-v0.50.1` ([full diff](https://github.com/get-bb/bb/compare/desktop-v0.50.1...VKirill:bb:vk/experimental)) |
| Package version | `0.50.1`, same as upstream on purpose (see [FAQ](#faq)) |
| Functions | 35, all listed below and in the app under **Settings → «Функции VK»** |
| Status | Runs daily on the author's own bb server with ~60 plugins, Claude Code, Codex, OpenCode, Cursor and Antigravity |
| Upstream discussion | [get-bb/bb#4233](https://github.com/get-bb/bb/issues/4233) (supersedes #3843 and #4043) |

Every change is marked `VK EXPERIMENTAL` in code, new names use a `vk` prefix,
and logic lives in separate `vk-*` files. Upstream files are only touched at
hook points, all listed in [VK_PATCHES.md](VK_PATCHES.md). The fork adds **no
database migrations or schema changes and no host-daemon protocol changes**:
data lives in reserved rows of existing tables (`__vk.*` thread plugin
metadata, `system_experiments`). That keeps a rebase onto each new upstream tag
small and predictable.

## Contents

- [What the fork adds](#what-the-fork-adds)
  - [Agent session context](#agent-session-context)
  - [Threads and notifications](#threads-and-notifications)
  - [Plugin runtime](#plugin-runtime)
  - [Interface](#interface)
  - [Server and machines](#server-and-machines)
  - [Settings → «Функции VK»](#settings--функции-vk)
  - [Session context policy in detail](#session-context-policy-in-detail)
- [Plugins that use it](#plugins-that-use-it)
- [Install](#install)
- [Update to a new upstream release](#update-to-a-new-upstream-release)
- [Roll back to official bb](#roll-back-to-official-bb)
- [FAQ](#faq)
- [Limitations](#limitations)
- [For plugin authors](#for-plugin-authors)

## What the fork adds

Kind: **switch** — on by default, the owner can turn it off in Settings →
«Функции VK»; **env** — controlled by an environment variable; **API** —
a plugin API or core behaviour that plugins depend on, always on. Plugin APIs
are `undefined` on official bb: plugins feature-test them
(`typeof … === "function"`) and degrade. Details and hook points per function:
[VK_PATCHES.md](VK_PATCHES.md); a Russian guide for plugin authors:
[VK_FUNCTIONS.md](VK_FUNCTIONS.md).

### Agent session context

| Function | Kind | Entry point | What it does |
|---|---|---|---|
| Session policy | API | `bb.agents.experimental_vkSessionPolicy(resolver)` | A plugin decides per session which BB plugins (instructions, tools, skills, env), provider-native skills, MCP servers, CLI plugins and instruction files load. [Details](#session-context-policy) |
| Context contributions | API | `bb.agents.experimental_vkContextContributions()` | Lists what every plugin adds to sessions, for a policy editor |
| Excluded plugins | API | `GET /api/v1/plugins/vk-excluded-plugins` | A plugin a policy excludes from a place also loses its composer UI and dispatch hooks there |
| Required session policy and compiled main agent | API | `threads.spawn({ experimental_vkRequiredSessionPolicy, experimental_vkCompiledMainAgent })`, `bb.agents.experimental_vkRequiredSessionPolicy()` | A policy snapshot stored with the thread, applied on every turn, can only narrow; children and forks inherit it as a ceiling. A prebuilt main-agent profile for Claude Code threads |
| Required policy inspection | API | `bb.sdk.threads.experimental_vkInspectRequiredSessionPolicies({ threadIds })` | Read the stored required policy of up to 200 threads |
| Launch tuning | API | `experimental_vkLaunchTuning` in the spawning plugin's thread metadata | Narrows how one helper is launched: ACP mode `ask`/`plan`, Claude Code disallowed tools |
| **Thread instructions** | switch `vkThreadInstructions` | `bb.sdk.threads.experimental_vkThreadInstructions(threadId)` | Core stores the exact instructions it sent to the agent (on `thread.start`, and on a turn whose text changed) so a plugin can show them for debugging |
| Cursor bridge MCP | API | Cursor ACP bridge | Writes `bb-bridge` into Cursor's `mcp.json` before launch, so Cursor's model sees every BB plugin tool |
| Claude bridge tool presentation | API | `presentation` of `bb.agents.registerTool` | Plugin tools in Claude Code threads keep the label and glyph the plugin set |

### Threads and notifications

| Function | Kind | Entry point | What it does |
|---|---|---|---|
| Thread keys | API | `bb.sdk.threads.experimental_vkSpawnKeyed`, `experimental_vkFindByKey`, `experimental_vkFindByPluginMetadata` | Idempotent spawn by a plugin's own key; find own threads by metadata without listing everything |
| Quiet child threads | switch `vkQuietChild` | `experimental_vkQuietChild: true` in spawn metadata | Marked helpers do not wake their parent with completed/failed/interrupted notices |
| Child told its parent | switch `vkChildToldParent` | core | A child that already sent its result with `bb thread tell` gets no second «completed» notice in the parent |
| Plugin notice as a system message | API | `bb.sdk.threads.experimental_vkSystemNotice({ threadId, text, label?, mode? })` | A plugin's note arrives as bb's own system message, not as the owner's words |
| Detached tool call | API | `bb.agents.experimental_vkDetachToolCall(text?)` | A long plugin tool answers the model at once; its result arrives later as a system message |
| Delivered result label | switch `vkDeliveredLabel` | `presentation.label.completed` | The delivered result is titled with the plugin's label instead of «Delivered … result» |
| Last turn in `thread.idle` | API | `experimental_vkLastTurn` on the event | The idle event carries the newest completed turn and whether it was a sub-agent's |
| Tool context plugin metadata | API | `ctx.experimental_vkPluginMetadata` | A plugin tool gets its own thread metadata in the call context, no extra request |
| Directory move checkpoint | API | `bb.vk.experimental_vkDirectoryMove`, `vk.directoryMove` in package.json | The owning plugin prepares, commits or aborts a change of a thread's working directory |
| Thread start retry | env `BB_VK_THREAD_START_RETRY` (default 1, `0` off, max 3) | host daemon | An agent that times out on `thread/start` is started again on a fresh session |

### Plugin runtime

| Function | Kind | Entry point | What it does |
|---|---|---|---|
| Plugin lifecycle and drain | API | `experimental_vkLifecycle` export, `vk.lifecycle.drain`, `bb.vk.startReason`, `bb.vk.afterDrain` | Enable/disable/remove hooks; on reload and shutdown a plugin finishes current work before core stops it |
| Isolated schedules | API | `bb.background.experimental_vkSchedule(name, cron, fn, options)`, `vk.schedules` | A long scheduled run does not hold the plugin's other schedules |
| Hook policy | API | `vk.hookPolicy`, `bb.vk.experimental_vkOnHookTimeout(cb)` | Per-plugin hook time limits and visible timeouts instead of silently lost env |
| RPC caller identity | API | `vk.rpcCallerPolicy`, `experimental_vkCaller` | A plugin learns who called its RPC or CLI: the owner's app, another plugin or an agent in a thread |
| Owner login | env `BB_VK_OWNER_AUTH=1` (default off) | server | Optional owner login; unverified callers get their own kind and owner-only routes |
| Composer dispatch | API | `useComposer().experimental_vkSetDispatchData(data)`, `vkPlace` | A plugin attaches hidden JSON to the next send; the composer knows the place of a new thread |

### Interface

| Function | Kind | Entry point | What it does |
|---|---|---|---|
| Favorite models | switch `vkFavoriteModels` | native model picker | Star a model; starred ones sit in a «Favorite models» block (`localStorage`) |
| One model picker look | API | native model picker | Every provider tab looks the same; reasoning levels sorted weakest first |
| Mention recency | switch `vkMentionRecency` | @-mention picker | Thread candidates sorted by last activity before the 200 limit, so recent threads of later projects are not dropped |
| Image editor | API | `app.slots.experimental_vkImageEditor`, `useComposer().experimental_vkAttachFiles` | A plugin editor inside bb's image preview; attach files to the composer draft |
| Thread info section | API | `app.slots.experimental_vkThreadInfoSection` | Alias of bb's own Info section slot for plugins written before 0.47 |
| «Функции VK» settings | — | Settings | The list below, rendered from one home: `packages/domain/src/vk-features.ts` |

### Server and machines

| Function | Kind | Entry point | What it does |
|---|---|---|---|
| Server settings | env, in `<dataDir>/env.json` | `BB_INFERENCE_SERVICE_TIER` = `fast`/`default`, `BB_THREAD_TITLE_LANGUAGE` (e.g. `Russian`) | Helper inference (titles, metadata) on the Codex Fast tier; language of generated thread titles |
| Worktree dependencies | env `BB_VK_WORKTREE_DEPS=0` turns off | git worktree environments | A new worktree links the source checkout's installed packages instead of reinstalling them |
| Skill tree cache | API | host daemon | The daemon keeps up to 512 skill trees, so a large skill catalog is not refetched every turn |

```jsonc
// <dataDir>/env.json (usually ~/.bb/env.json), then restart the server
{ "BB_INFERENCE_SERVICE_TIER": "fast", "BB_THREAD_TITLE_LANGUAGE": "Russian" }
```

### Settings → «Функции VK»

A settings section right below Experiments lists every function above with a
Russian name and description. The six **switch** functions have real switches,
on by default (also for early adopters), stored as experiment keys `vk<Name>`
in the existing `system_experiments` table; turning one off stops that function
at once. **env** functions show their default and the variable that changes
it. **API** functions show «Всегда включено»: turning them off would break the
plugins below.

### Session context policy in detail

#### Session context policy

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

```jsonc
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

#### Context contributions

```ts
bb.agents.experimental_vkContextContributions();
// -> [{ pluginId, required, instructions, configure, tools: string[], skills: string[] }]
```

Lists what each running plugin adds to agent sessions, so a policy editor can
label its switches ("adds instructions, 5 tools, 3 skills") and lock the
`required` ones.

#### Excluded plugins disappear from the place

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

## Plugins that use it

Each plugin declares the functions it calls in `vk-requires.json` (`required`
or `optional`) and feature-tests the optional ones, so it still loads on
official bb.

| Plugin | Uses |
|---|---|
| [Lane Pilot](https://github.com/VKirill/bb-plugin-lane-pilot) | composer dispatch, plugin lifecycle (required); session and required policy, compiled main agent, quiet child, thread keys, drain, schedules, hook policy, tool ctx metadata, last turn, launch tuning, policy inspection, directory move, system notice, detached tool call, thread info section |
| [Projects & Sections](https://github.com/VKirill/bb-plugin-project-folders) | session policy, context contributions — tab «Session context» for the whole bb, a project and a section. The reference consumer |
| [Agency](https://github.com/VKirill/bb-plugin-agency) *(alpha)* | session policy, context contributions — each employee's context frozen per launch |
| Content Factory *(private)* | session policy, context contributions (optional) |
| [Office Viewer](https://github.com/VKirill/bb-plugin-office-viewer) | image editor, attach files (optional) |
| [Thread Instructions](https://github.com/VKirill/bb-plugin-thread-instructions) | thread instructions (optional) — a collapsible section on the thread Info tab with the exact text bb sent to the agent |
| My Posts | required policy, compiled main agent (optional) |

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
npm pack --pack-destination /tmp          # -> /tmp/bb-app-0.50.1.tgz
```

### 3. Install into its own runtime folder

One folder per build, so rollback is switching a path:

```sh
R=~/.local/share/bb-runtime-0.50.1-vk
mkdir -p "$R" && cd "$R"
echo '{"name":"bb-runtime","private":true}' > package.json
npm i --omit=dev /tmp/bb-app-0.50.1.tgz
# npm 12+: npm i --omit=dev --allow-scripts=better-sqlite3,node-pty,@parcel/watcher /tmp/bb-app-0.50.1.tgz
```

### 4. Run

Foreground, same as `npx bb-app`:

```sh
node ~/.local/share/bb-runtime-0.50.1-vk/node_modules/bb-app/dist/bb-app.js
```

Open `http://localhost:38886`.

As a server (Linux, systemd) — point the existing unit at the fork's server
entry with a drop-in instead of editing the unit:

```ini
# /etc/systemd/system/bb-server.service.d/runtime.conf
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/<you>/.local/share/bb-runtime-0.50.1-vk/node_modules/bb-app/dist/bb-server.js
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
2. Start the official build of the **same** version: `npx bb-app@0.50.1`, the
   desktop app of that version, or point the systemd drop-in back to the
   official runtime.
3. Nothing else: no database rollback is needed. Plugins that use the API hide
   their fork-only UI; stored policies are simply not applied.

## FAQ

<details>
<summary><b>Is it safe to run against my existing data directory?</b></summary>

The fork adds no tables, columns or migrations. Its own data sits in reserved
rows of existing tables (`__vk.*` thread plugin metadata, `vk*` experiment
keys); policies are stored by the plugins that define them. The risk is the usual one of running a
custom build: back up `~/.bb` first, and keep the fork on the same upstream
version as the official build you may roll back to.
</details>

<details>
<summary><b>Why is the package version 0.50.1 and not something like 0.50.1-vk?</b></summary>

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

- The list of functions with Russian names and descriptions (one home for the
  Settings section): [`packages/domain/src/vk-features.ts`](packages/domain/src/vk-features.ts).
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
