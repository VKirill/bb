# VK experimental patches

Branch `vk/experimental` on top of an upstream `desktop-v*` tag. Everything
here is marked `VK EXPERIMENTAL` in code, uses the `vk` prefix in names, and
is absent from upstream bb. A guide to the functions for plugin authors (in
Russian) is in [VK_FUNCTIONS.md](VK_FUNCTIONS.md). Rebase this branch on each new upstream tag; a
conflict can only happen at the hook points listed below.

## Session policy (`session-policy`, v1)

A plugin narrows what one agent session loads: BB plugins (instructions,
agent tools, skills), skills by name, provider-native MCP servers and
provider-native CLI plugins.

Plugin API: `bb.agents.experimental_vkSessionPolicy(resolver)` — optional,
feature-test with `typeof bb.agents.experimental_vkSessionPolicy === "function"`.
The resolver gets the `configure` context and returns a `VkSessionPolicy` or
null. First non-null answer in plugin id order wins; throw, invalid shape or
more than 2 s → logged, treated as null (fail open).

Core applies the BB side (plugins' tools and instructions, `<dataDir>/AGENTS.md`)
and sends the rest to the bridge as provider option `vkSessionPolicy`
(`VkRuntimeSessionPolicy`: exact denied BB skill names plus native filters).
The environment's shared skill catalog is not changed: bridges swap it for a
filtered twin per session, so threads with different policies in one
environment do not thrash the runtime.

| Provider | BB skills | Native skills | MCP servers | CLI plugins |
| --- | --- | --- | --- | --- |
| Claude Code | filtered plugin dir | SDK `skills` allow list / `skillOverrides` + `Skill()` deny | `strictMcpConfig` + copied configs / `deniedMcpServers` | `enabledPlugins: false` |
| Codex | filtered extra roots | `-c skills.config=[{path,enabled=false}]` | `-c mcp_servers.<n>.enabled=false` | `-c plugins.<id>.enabled=false` |
| OpenCode (ACP) | instruction list filtered | `OPENCODE_CONFIG_CONTENT` `permission.skill` | `OPENCODE_CONFIG_CONTENT` `mcp.<n>.enabled=false` | — |
| Cursor (ACP) | instruction list filtered | — | per-policy `CURSOR_DATA_DIR` overlay: real project folder linked, own `mcp-disabled.json` | — |

## Cursor bridge MCP (`cursor-bridge-mcp`)

Cursor ACP (`cursor-agent`) does not put `session/new` MCP tools into Grok's
native function list. Grok discovers MCP through `GetDynamicTools` from
`~/.cursor/mcp.json`. This function intercepts Cursor launch: it starts
`bb-bridge` **before** spawning the agent, writes that server into the user
(and overlay) `mcp.json`, adds `--approve-mcps`, and tells the model to call
plugin tools via `CallDynamicTool` namespace `bb-bridge`. On session stop it
restores the previous `bb-bridge` key if this thread still owns it.

No plugin API. No host-daemon protocol change. Covers every
`bb.agents.registerTool` (Image Studio, Env Catalog, File Gateway, …).

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/provider-bridge-acp/src/bridge/bridge.ts` | write `bb-bridge` before spawn; `--approve-mcps`; Cursor tool instructions; restore on stop |
| `packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts` | `tools/list`: force `inputSchema.type=object` (Cursor drops the whole server otherwise) |

New files: `packages/provider-bridge-acp/src/vk-cursor-bridge-mcp.ts`,
`vk-cursor-mcp-schema.ts`, and tests.

Switches: `projectInstructions: false` drops the workspace `.bb/AGENTS.md` in core,
and in the CLI — Claude `claudeMdExcludes` (folder, parents, subfolders; the
user's `~/.claude` stays), Codex `-c project_doc_max_bytes=0`, OpenCode
`OPENCODE_DISABLE_PROJECT_CONFIG=1`; Cursor has no switch. `claudeAiSync: false`
sets Claude `syncClaudeAiSkills` / `syncClaudeAiPlugins` to false.

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/domain/src/index.ts`, `package.json` | export `vk-session-policy` |
| `packages/plugin-sdk/src/backend-contract.ts` | `PluginAgents.experimental_vkSessionPolicy?`, type re-exports |
| `packages/plugin-sdk/src/provider-bridge.ts` | re-export vk helpers for bridges |
| `packages/provider-bridge-protocol/src/bridge-kit/index.ts` | export `vkFilterSkillRoot` |
| `apps/server/src/services/plugins/plugin-api.ts` | store the resolver on the plugin handle |
| `apps/server/src/services/plugins/plugin-service.ts` | `resolveVkSessionPolicy` |
| `apps/server/src/services/plugins/plugin-agent-contributions.ts` | `resolvePluginVkSessionPolicy` |
| `apps/server/src/services/threads/thread-runtime-config.ts` | resolve + filter tools/instructions, `vkSessionPolicy` in result |
| `apps/server/src/services/threads/thread-commands.ts` | merge `vkSessionPolicy` into provider options |
| `plugins/provider-claude-code/src/**` | params schema, session options, SDK options (`vkDisallowedTools` → SDK `disallowedTools`; 0.45 dropped the generic field), filtered skill plugins |
| `plugins/provider-codex/src/bridge/bridge.ts` | launch `-c` args, per-session skill roots, construction signature |
| `packages/provider-bridge-acp/src/bridge/bridge.ts` | OpenCode env, Cursor data dir, filtered skill list, same env on every turn |
| `packages/provider-bridge-acp/src/bridge/cursor-mcp-approval.ts` | export `cursorProjectSlug`, `cursorDataDirectory` |
| `plugins/bb-guide/skills/bb-plugin-authoring/references/*-api-index.md` | docs for new exports |
| `apps/server/src/routes/plugins.ts` | `GET /plugins/vk-excluded-plugins` |
| `apps/server/src/services/threads/dispatch-hooks.ts` | skip excluded plugins' hooks and submission |
| `apps/app/src/components/plugin/composer-slot-hooks.ts` | hide excluded plugins' composer UI |
| `apps/app/src/components/plugin/plugin-composer-host.tsx` | optional `vkPlace` on the host |
| `apps/app/src/components/promptbox/NewThreadComposer.tsx` | new thread's place (host, environment, section path) |

New files (no conflicts): `packages/domain/src/vk-session-policy.ts`,
`packages/provider-bridge-protocol/src/bridge-kit/vk-skill-roots.ts`,
`apps/server/src/services/threads/vk-session-policy.ts`,
`plugins/provider-claude-code/src/bridge/vk-session-policy.ts`,
`plugins/provider-codex/src/bridge/vk-session-policy.ts`,
`packages/provider-bridge-acp/src/vk-session-policy.ts`, and their tests.

Required items: `VK_REQUIRED_PLUGIN_IDS` (`environment-project-checkout`) are
never left out by any policy — `vkPluginAllowed` always passes them, so their
tools, instructions, env, skills, composer UI and dispatch hooks stay — and
`bb-bridge` is removed from MCP deny lists and added to allow lists before a
bridge sees the policy. Context contributions carry `required: true` for them.

`bb.agents.experimental_vkContextContributions()` lists what each running plugin
adds to agent sessions (instructions, configure, tools, skills) for the editor.

A plugin the policy leaves out is absent at that place, not only from the
session: `GET /api/v1/plugins/vk-excluded-plugins` (thread, or project + host +
environment/path) lists them; the composer hides their customizations
(`composer-slot-hooks.ts`), and `message.dispatch` skips their hooks and drops
their composer submission (`dispatch-hooks.ts`). The policy owner is never
excluded.

Consumer: plugin `project-folders` (VKirill/bb-plugin-project-folders), tab
«Контекст сессии», shown only when the API above exists.

## Server settings

Managed config keys in `<dataDir>/env.json`:

- `BB_INFERENCE_SERVICE_TIER` (`fast` | `default`): helper inference (titles,
  metadata) on the Codex Fast tier, `service_tier=priority`.
- `BB_THREAD_TITLE_LANGUAGE` (e.g. `Russian`): language of generated thread
  titles; unset, the task's own language.

Hook points: `packages/config/src/bb-app-managed-config.ts`,
`apps/server/src/services/system/bb-app-managed-config.ts`,
`apps/server/src/types.ts`, `apps/server/src/start-server.ts`,
`plugins/provider-codex/src/ai/chatgpt-client.ts`,
`plugins/provider-codex/src/ai/host-contract.ts`,
`apps/server/src/services/threads/title-generation.ts`,
`packages/templates/src/templates/generate-thread-metadata.md`.

## Composer dispatch (`composer-dispatch`)

A plugin attaches opaque JSON to the next ordinary new-thread Send without
changing the draft text or inserting a mention. Plugin API:
`useComposer().experimental_vkSetDispatchData(data | null)`. Feature-test:
`typeof composer.experimental_vkSetDispatchData === "function"`. Absent
upstream. Data is per mounted composer, retained on failed send, cleared on
success, scope change, or plugin unmount.

Consumer: plugin `lane-pilot` (Enable for this chat).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/app/src/components/plugin/plugin-composer-host.tsx` | optional `vkSetDispatchData` |
| `apps/app/src/components/promptbox/NewThreadComposer.tsx` | pending data on ordinary Send |
| `apps/app/src/lib/plugin-sdk-hooks.ts` | clear the slot's data on unmount |
| `packages/plugin-sdk/src/internal/composer-handle.ts` | `vkSetDispatchData` on the handle target, `experimental_vkSetDispatchData` on the handle (0.45 shared composer handle) |
| `apps/app/src/lib/plugin-composer-handle.ts` | pass the host's `vkSetDispatchData` to the target |
| `packages/plugin-sdk/src/app-contract.ts` | `PluginComposerApi` member |
| `packages/plugin-sdk/src/testing/app.tsx` | harness records `dispatchData` |
| `plugins/plugin-api-docs/src/surfaces.ts` | docs symbol |
| `docs/api_to_audit.md` | experimental audit note |

New files (no conflicts): `apps/app/src/components/plugin/vk-composer-dispatch.ts`
and its test.

## Plugin lifecycle (`plugin-lifecycle`)

A plugin exports `experimental_vkLifecycle(ctx)` beside its server factory; core
calls it on enable, disable and removal with plugin-scoped `kv`, `signal` and an
authenticated `callHost`, before the plugin is disposed. Capability:
`bb.server.experimental_vkPluginLifecycle === true`. No migrations and no
host-daemon wire changes. Details: `docs/vk-experimental.md`.

Consumer: plugin `lane-pilot` (native CLI install/repair on registered hosts only).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/plugin-runtime.ts` | `createVkPluginLifecycleRunner` beside safe-mode helpers (imports the built server entry, cjs or esm, as 0.45 loads plugins); `runLifecycle`, `lifecyclePluginIds` in the runtime |
| `apps/server/src/services/plugins/plugin-service.ts` | run the transition before disposal |
| `apps/server/src/services/plugins/plugin-api.ts` | advertise `experimental_vkPluginLifecycle` |
| `packages/plugin-sdk/src/backend-contract.ts`, `index.ts` | capability and type export |
| `plugins/plugin-api-docs/src/surfaces.ts`, `docs/api_to_audit.md` | docs |

New files: `apps/server/src/services/plugins/vk-plugin-lifecycle.ts`,
`packages/plugin-sdk/src/vk-plugin-lifecycle.ts`, their tests, `docs/vk-experimental.md`.

## Required session policy and compiled MAIN agent (`required-session-policy`)

A plugin fixes, at spawn, what a helper thread may load and with which main
agent profile it runs; the snapshot cannot be widened later, and a child, fork
or lifecycle-owned thread inherits the parent's ceiling.

Plugin API:
- `bb.agents.experimental_vkRequiredSessionPolicy()` — capability matrix
  (`version`, `persist`, `requiredMarker`, `snapshotDigest`, `parentCeiling`,
  `bridgeHandshakeVersion`, `markerStorage: "thread-plugin-metadata"`, provider
  groups, instruction switches, mandatory BB plugins and MCP servers).
- `threads.spawn({ experimental_vkRequiredSessionPolicy: { version: 1, policy } })`.
- `bb.agents.experimental_vkCompiledMainAgent()` and
  `threads.spawn({ experimental_vkCompiledMainAgent: profile })` (Claude Code).

Storage: the snapshot and a required marker (its digest) are reserved rows of
thread plugin metadata (`__vk.required-session-policy`,
`__vk.required-session-policy.marker`, `__vk.compiled-main-agent`,
`__vk.compiled-main-agent.marker`); every `__vk.` id is core-owned and refused
to plugins. A missing or corrupt marker or snapshot fails closed. No table, no
migration and no host-daemon protocol change: bridges, which the server ships
to machines, report support with optional handshake fields
`experimental_vkRequiredSessionPolicy` / `experimental_vkCompiledMainAgent`,
and core refuses a required thread on a bridge without them.

Ported 2026-10-02 from `vk-archive/required-session-policy` (protocol 216 with
two migrations), with the marker tables moved into thread plugin metadata.

Consumer: plugin `lane-pilot` (helper context «selected» / «none», PM profile).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/plugin-api.ts` | the two capability functions |
| `apps/server/src/services/threads/thread-create*.ts` | spawn fields, parent ceiling, snapshot insert |
| `apps/server/src/services/threads/thread-runtime-config.ts`, `thread-commands.ts` | snapshot into provider options |
| `apps/server/src/routes/threads/data.ts`, `packages/server-contract/src/api/threads.ts` | request schema |
| `apps/cli/src/commands/thread/spawn.ts` | `bb thread spawn` flags |
| `packages/db/src/data/thread-plugin-metadata.ts`, `threads.ts` | reserved rows, refusal of `__vk.` ids |
| `packages/agent-runtime/src/bridge-protocol-adapter.ts` | handshake check |
| `packages/provider-bridge-protocol/src/handshake.ts` | optional handshake fields |
| `plugins/provider-claude-code`, `plugins/provider-codex`, `packages/provider-bridge-acp` | enforcement and handshake |

Own files: `packages/db/src/data/vk-thread-marker.ts`, `thread-required-session-policy.ts`, `packages/domain/src/vk-compiled-main-agent.ts`.

## Mention recency (`mention-recency`)

The @-mention picker keeps only the first 200 thread candidates. Sidebar
navigation lists threads project by project, so the plain slice dropped every
thread of later projects even when they were the most recently active. The
candidates are now sorted by `updatedAt` (newest first) before the slice. Same
limit, same data already in memory, no extra requests.

Consumer: core composer (no plugin API).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/app/src/hooks/queries/thread-queries.ts` | import + sort in `buildThreadMentionCandidates` before `.slice(0, limit)` |

New files (no conflicts): `apps/app/src/hooks/queries/vk-mention-recency.ts`
and its test.

## README

`README.md` is replaced by the fork's install guide and FAQ. On a rebase
conflict keep the fork's version.

## Favorite models (`favorite-models`)

Star a model in the native picker. Starred models for that provider sit in a
**Favorite models** block above **All models**. Stored in the browser
`localStorage` key `bb.vk.favorite-models` (no DB, no plugin). Same picker
as the composer and `experimental_ProviderModelPicker`.

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/app/src/components/pickers/ModelReasoningPicker.tsx` | favorite/section/group rows, group state, keyboard skips sections |
| `apps/app/src/components/pickers/ModelReasoningMenu.tsx` | `vk` prop: star, section labels, group rows, list `h-52` (0.45 moved the menu here) |
| `apps/app/src/components/pickers/model-picker-menu.ts` | fixed `w-80` |

New files: `apps/app/src/components/pickers/vk-favorite-models.ts`, `vk-model-groups.ts` and tests.

When model labels look like `Provider/Model` and there are at least two providers, the catalog is an accordion: click a provider row to expand its models.

## Quiet child threads (`quiet-child`)

A plugin that watches its own helper threads marks them `experimental_vkQuietChild: true` in the `pluginMetadata`
it passes to `threads.spawn`. When such a child finishes, fails or is interrupted, core does not queue the
`child-completed` / `child-failed` / `child-interrupted` system message into the parent, so the parent agent is not
woken. «Needs attention» notices still go through. Consumer: Lane Pilot (writers, critiques, readers, memory, docs,
project life — not errands or specialists, which the PM waits for). No schema, no migration, no SDK change: the flag
is a key in the plugin's own metadata row; core without this patch stores it and ignores it.

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/threads/child-thread-notifications.ts` | import + early return in `queueChildThreadTurnNotificationBestEffort` |
| `packages/db/src/data/index.ts` | export `isVkQuietChildThread`, `VK_QUIET_CHILD_KEY` |

New files: `packages/db/src/data/vk-quiet-child.ts` and `packages/db/test/data/vk-quiet-child.test.ts`.

## Thread keys (`thread-keys`)

Idempotent spawn and own-metadata lookup on `bb.sdk.threads`, so a plugin that lost the answer to a spawn finds its
thread without paging through the list (Lane Pilot hit `page_cap` / `holder_ambiguous` in a project with 1000+
threads). New methods on the plugin-bound SDK (`PluginBbSdk`), all optional, feature-tested with
`typeof bb.sdk.threads.experimental_vkSpawnKeyed === "function"`:

- `experimental_vkSpawnKeyed({ ...spawn args, key })` -> `{ thread, reused }`
- `experimental_vkFindByKey(key)` -> thread or `null`
- `experimental_vkFindByPluginMetadata({ match, projectId?, includeArchived?, limit? })` -> threads

The key is the reserved field `__vk.key` in the spawning plugin's own `thread_plugin_metadata` row; the uniqueness
check and the insert run in the same immediate transaction as the thread row. A deleted thread frees its key; an
archived one still holds it. No table, no migration, no protocol change. The public thread-create request accepts the
extra optional field `experimental_vkKey` (only with `origin: "plugin"`); ordinary `threads.spawn`, `threads.list`
and the HTTP routes are unchanged. Consumer: Lane Pilot (writers, holders, critics, stage children, reconcile).

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/db/src/data/threads.ts` | `vkKey` on `CreateThreadInput`; `assertVkThreadKeyFree` at the start of the `createThread` transaction; the plugin-metadata insert goes through `vkThreadMetadataRows` (identical to the old insert when no key) |
| `packages/db/src/data/thread-plugin-metadata.ts` | `patchThreadPluginMetadata` refuses to change or drop `__vk.key` (re-sending it unchanged is fine) |
| `packages/db/src/data/index.ts` | exports |
| `packages/server-contract/src/api/threads.ts` | optional `experimental_vkKey` on `createThreadRequestSchema` + origin check |
| `apps/server/src/services/threads/thread-create-request.ts`, `thread-create-helpers.ts` | carry the field; `VkThreadKeyConflictError` becomes `409 vk_thread_key_conflict` with `details.threadId` |
| `apps/server/src/services/plugins/plugin-api.ts` | `wrapSdkForPlugin` takes `db` and spreads `createVkThreadKeyMethods` into `threads` |
| `packages/plugin-sdk/src/backend-contract.ts`, `index.ts` | `PluginBbSdk.threads` gains `ExperimentalVkThreadKeys`; type export |
| `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md`, `docs/api_to_audit.md` | docs |

New files: `packages/db/src/data/vk-thread-keys.ts`, `apps/server/src/services/plugins/vk-thread-keys.ts`,
`packages/plugin-sdk/src/vk-thread-keys.ts`, tests `packages/db/test/data/vk-thread-keys.test.ts` and
`apps/server/test/threads/vk-thread-keys.test.ts`.

## Schedule options (`schedule-options`)

`sweepDueSchedules` ran the due schedules of every plugin one after another and awaited each, so one long
schedule held the others back (a 50-minute Lane Pilot run blocked its own self-repair and other plugins'
schedules). A schedule marked `isolated` is now started without awaiting it. At most one run per
(plugin, schedule); a due tick while the previous run still goes is skipped (`next_run_at` moves on, `last_run_at` and
`last_status` stay those of the running one); at most 8 isolated runs at once, a tick beyond that is skipped
the same way and logged; a run is aborted after `timeoutMs` (default 15 min, at most 6 h, larger values are clamped
with a warning) and recorded as `last_status = "error"`, `last_error = "timeout after <N>ms"` (the status enum in
`plugin-state-snapshot.ts` and the server contract stays `running | ok | error`, so `bb plugin list` and the UI need no
change). The slot is held until the function really settles, so a function that ignores its signal is not started a
second time on top of itself. Disposing, reloading or disabling the plugin aborts its runs
(`last_error = "aborted: plugin stopped or reloaded"`) and frees their slots. Schedules without the option keep the
stock sequential, awaited run.

Plugin API: `bb.background.experimental_vkSchedule(name, cron, fn, { isolated, timeoutMs?, overlap? })`, `fn` gets
`{ signal }`; feature-test `typeof bb.background.experimental_vkSchedule === "function"`. Or, without code, the
package.json top-level `vk.schedules.<name>: { isolated?, timeoutMs?, overlap?: "skip" }` for a schedule registered
with plain `bb.background.schedule(name, ...)` (the function then also receives `{ signal }`). API options win over the
manifest, field by field. The manifest is read leniently: an invalid or unknown value is ignored with a logged warning
at load, never an error. Only `vk.schedules` is read from the `vk` key.

Consumer: Lane Pilot (long schedules: stage sweeps, self-repair). No schema, no migration, no host-daemon change.

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/plugin-sdk/src/backend-contract.ts`, `index.ts` | `PluginBackground.experimental_vkSchedule?`, type export |
| `apps/server/src/services/plugins/plugin-api.ts` | `experimental_vkSchedule` on `background`, `vkOptions?` on the schedule record |
| `apps/server/src/services/plugins/manifest.ts` | `vkSchedules?` on `PluginManifest`, one spread line in `readPluginManifest` |
| `apps/server/src/services/plugins/plugin-runtime.ts` | create the runner beside `invokeWrapped`, log manifest warnings at load, `abortPlugin` in `disposePluginInstance`, return it |
| `apps/server/src/services/plugins/plugin-service.ts` | `sweepDueSchedules`: isolated schedules go to the runner and the loop continues |
| `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-api-index.md`, `plugins/plugin-api-docs/src/surfaces.ts`, `docs/api_to_audit.md` | docs |

New files: `apps/server/src/services/plugins/vk-schedule-options.ts`,
`packages/plugin-sdk/src/vk-schedule-options.ts`, `apps/server/test/services/plugins/plugin-vk-schedule-options.test.ts`.

## Plugin lifecycle drain (`lifecycle-drain`)

Extends `experimental_vkLifecycle` with the actions `reload` and `shutdown`, for a plugin that declares
`"vk": { "lifecycle": { "drain": { "timeoutMs": N } } }` at the top level of its package.json (beside `bb`;
1000 to 600000, default 30000). Without the field reload and shutdown behave as in stock BB.

For such a plugin, when a reload has loaded the new candidate and is about to dispose the previous instance
(and, on server stop, before the plugin is disposed): the gate for the plugin closes, the previous module's
`experimental_vkLifecycle({ action, deadline, signal, kv, callHost })` runs with the deadline (abort and a log
line when it is exceeded or throws; the reload goes on), then the previous instance is disposed and the new one
is activated and the gate opens. While the gate is closed, new `message.dispatch` hooks, `contributeEnv`,
mention resolves and tool calls for the plugin wait for the new instance, until the drain ends and not longer than
its declared `timeoutMs` plus 30 s for the swap (a `message.dispatch` hold is taken before the decision box and the
dispatch lock, so it neither eats the 10 s box nor blocks other chats; a hold that runs out fails the dispatch and, for
a plugin with `vk.hookPolicy.messageDispatch`, fires the hook-timeout event)
and run in it, and due schedules are skipped by the sweep and stay due. The new instance gets
`bb.vk.startReason` (`boot` | `enable` | `reload`) and `bb.vk.afterDrain` (previous drain finished in time), and
its factory gets a clear error if it calls the host (a drain plugin must call the host from a background service
or handler). In-memory only; no migrations, no host-daemon wire changes. Consumer: Lane Pilot (`deploy-drain`).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/plugin-runtime.ts` | `vkDrainGate`, `vkRunDrain`; `loadOne(row, options?)` runs the drain before `disposePluginInstance`, keeps `vkModule`, opens the gate after activation; `listPluginHooks` late-binds the handler of a drain plugin; schedules held by a drain stay due; `disposeAll` runs the shutdown drains of all declaring plugins in parallel (`vkDrainAllForShutdown`, cap = longest declared timeout + 5 s, at most 600 s) |
| `apps/server/src/services/plugins/plugin-service.ts`, `plugin-hook-registry.ts`, `threads/dispatch-hooks.ts`, `vk-hook-policy.ts` | gate checks in `sweepDueSchedules`, `resolveProviderEnv`, `resolveMention`, `invokeAgentTool` (`gate.waitForEnd`); `hooks.vkAwaitDrain` and its call before the dispatch lock; `noteVkHookFailure` reports an expired hold; `setEnabled` passes `startReason: "enable"` |
| `apps/server/src/services/plugins/vk-plugin-lifecycle.ts` | `deadline` and a drain timeout for `runVkPluginLifecycle` / `runLifecycle`; a missing export is a no-op for `reload`/`shutdown` |
| `apps/server/src/services/plugins/plugin-api.ts` | `bb.vk` (`startReason`, `afterDrain`), clearer host-call error, `vkSetAfterDrain` on the handle |
| `apps/server/src/services/plugins/manifest.ts`, `plugin-service-internal.ts` | `vkLifecycleDrain` on the manifest, `vkModule` on `LoadedPlugin` |
| `packages/plugin-sdk/src/vk-plugin-lifecycle.ts`, `backend-contract.ts` | actions, `deadline`, `ExperimentalVkLifecycleInfo`, `BbPluginApi.vk` |
| `plugins/bb-guide/.../backend-api-index.md`, `docs/api_to_audit.md`, `docs/vk-experimental.md` | docs; the two `plugin-authoring-docs` / `public-types` key lists gain `vk` |

New files: `apps/server/src/services/plugins/vk-plugin-drain.ts`, test
`apps/server/test/services/plugins/vk-lifecycle-drain.test.ts`.

## Hook policy (`hook-policy`)

A plugin raises the time limit of its own hooks and sees when one times out. The top-level `vk.hookPolicy` key of
its package.json (beside `bb`; the `bb` object is strict) declares `messageDispatch` (≤ 30000 ms, stock 10000),
`contributeEnv` (≤ 15000 ms, stock 5000, optional `required`) and `mentionResolve` (≤ 30000 ms, stock 10000);
values are clamped to 1000..max and invalid entries are ignored with a warning, never failing plugin load.
`bb.vk.experimental_vkOnHookTimeout(cb)` (feature-test `typeof bb.vk?.experimental_vkOnHookTimeout === "function"`)
reports a timeout of a declared hook. For a declared plugin a timeout, and only a timeout, appends a `system/error`
row (code `vk_hook_timeout`) to the thread timeline when the thread is known and calls the plugin's callbacks.
`contributeEnv.required: true` makes a resolver timeout or error throw `ApiError` 503 `vk_required_env_unavailable`
(retryable) from provider env resolution, so the turn does not start (first start: provisioning failure with Retry;
live send: 503 to the composer; queued row: failure reason and retry); a plugin the session policy drops is not
held to `required`. A plugin without the key keeps stock limits and the stock silent behaviour. No schema, no
migration, no protocol change. Details: `VK_FUNCTIONS.md` section 9.

Consumer: plugin `lane-pilot` (its provider env variables no longer vanish silently).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/manifest.ts` | `vk?` field on `PluginManifest` and one spread line in `readPluginManifest` |
| `apps/server/src/services/plugins/plugin-api.ts` | `vk` namespace on the plugin API, built from `createVkHookPolicyApi` |
| `apps/server/src/services/plugins/plugin-hook-registry.ts` | optional `vkHookPolicy(pluginId)` on `PluginHookProvider` |
| `apps/server/src/services/plugins/plugin-service.ts` | `hooks.vkHookPolicy`; own limit and failure handling in `resolveProviderEnv` and `resolveMention`; `vkPluginAllowed` argument |
| `apps/server/src/services/plugins/plugin-agent-contributions.ts` | pass `vkPluginAllowed` through `resolvePluginProviderEnv` |
| `apps/server/src/services/threads/thread-runtime-config.ts` | pass `vkPluginAllowed` from the session policy |
| `apps/server/src/services/threads/dispatch-hooks.ts` | per-plugin decision box and timeout report in `runMessageDispatchHookPass` |
| `apps/server/src/server.ts` | `installVkHookPolicy(deps)` (timeline row and logger) |
| `packages/plugin-sdk/src/backend-contract.ts`, `index.ts` | optional `BbPluginApi.vk`, type export |
| `plugins/plugin-api-docs/src/surfaces.ts`, `docs/api_to_audit.md`, `plugins/bb-guide/.../backend-api-index.md` | docs |
| `packages/plugin-sdk/src/__tests__/public-types.test.ts`, `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` | `vk` added to the `BbPluginApi` key lists |

New files: `apps/server/src/services/plugins/vk-hook-policy.ts`, `packages/plugin-sdk/src/vk-hook-policy.ts`,
`apps/server/test/services/plugins/vk-hook-policy.test.ts`, `apps/server/test/threads/vk-hook-policy-dispatch.test.ts`.
