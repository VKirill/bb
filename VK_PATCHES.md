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

Env of the thread's origin plugin (`threads.origin_plugin_id`, the plugin that
started the thread and wrote its policy) is kept even when the policy leaves
that plugin out (`vkEnvPluginAllowed`): Lane Pilot helpers with a required
policy keep `LANE_PILOT_ROLE` and the guard PATH, while its skills, tools and
instructions stay out.

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

OpenCode v2 (`opencode2`, a provider plugin core does not ship; our fork
`VKirill/bb-plugin-opencode2` >= `v1.1.0-vk.3`): the bridge enforces `skills` and
`mcpServers` itself through OpenCode's native session permission rules (`skill`
deny/allow rules hide skills from the model request; `<server>_*` denies hide
OpenCode's own MCP servers and refuse their calls through Code Mode) and
declares `experimental_vkRequiredSessionPolicy: 1` in `initialize`. The
handshake is therefore required for it like for every other bridge
(`bridge-protocol-adapter.ts`; a bridge older than vk.3 fails closed with
`vk_required_session_policy_bridge_unsupported`). Core still drops denied BB
skills from the injected list (`vkFilterCoreEnforcedSkillSources`,
`thread-runtime-config.ts`) and `assertVkRequiredPolicyProvider` refuses
`nativePlugins` and `projectInstructions: false`: OpenCode loads native plugins
and the project's AGENTS.md inside one shared service with no per-session
switch. Advertised: groups `bbPlugins`, `skills`, `mcpServers`; switch
`userInstructions`. `acp-opencode` stays as it was.

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
| `apps/app/src/hooks/queries/thread-queries.ts` | import + sort in `getThreadMentionCandidatePlaceholder` before `.slice(0, limit)` (since 0.46.1 upstream #5476 no longer slices the fetched list, only the cached placeholder) |

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

A second level for `Provider/Vendor/Model` labels: when one provider's models name at least two vendors, the provider row opens into vendor rows (opencode2 sends OpenRouter as `OpenRouter/Anthropic/…`, free models as `OpenRouter/🎁 Бесплатные/…`). Models without a vendor go into a closing «Другие» row; the selected model's provider and vendor start open.

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
`last_status` stay those of the running one); at most 8 isolated runs at once, a tick beyond that is deferred a
minute (`next_run_at` = now + 60 s or the next cron time, whichever is sooner; before 2026-10-24 it waited for the next
cron time, so a daily schedule lost the day) and logged; a run is aborted after `timeoutMs` (default 15 min, at most 6 h, larger values are clamped
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
`bb.vk.startReason` (`boot` | `enable` | `reload`), `bb.vk.afterDrain` (previous drain finished in time) and
`bb.vk.instanceId` (unique per instance; the drain handler of the instance being replaced gets the same value as
`ctx.instanceId`, which is how a plugin tells the old instance from the new one when the module is shared), and
its factory gets a clear error if it calls the host (a drain plugin must call the host from a background service
or handler). In-memory only; no migrations, no host-daemon wire changes. Consumer: Lane Pilot (`deploy-drain`).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/plugin-runtime.ts` | `vkDrainGate`, `vkRunDrain`; `loadOne(row, options?)` runs the drain before `disposePluginInstance`, keeps `vkModule`, opens the gate after activation; `listPluginHooks` late-binds the handler of a drain plugin; schedules held by a drain stay due; `disposeAll` runs the shutdown drains of all declaring plugins in parallel (`vkDrainAllForShutdown`, cap = longest declared timeout + 5 s, at most 600 s) |
| `apps/server/src/services/plugins/plugin-service.ts`, `plugin-hook-registry.ts`, `threads/dispatch-hooks.ts`, `vk-hook-policy.ts` | gate checks in `sweepDueSchedules`, `resolveProviderEnv`, `resolveMention`, `invokeAgentTool` (`gate.waitForEnd`); `hooks.vkAwaitDrain` and its call before the dispatch lock; `noteVkHookFailure` reports an expired hold; `setEnabled` passes `startReason: "enable"` |
| `apps/server/src/services/plugins/vk-plugin-lifecycle.ts` | `deadline` and a drain timeout for `runVkPluginLifecycle` / `runLifecycle`; a missing export is a no-op for `reload`/`shutdown` |
| `apps/server/src/services/plugins/plugin-api.ts` | `bb.vk` (`startReason`, `afterDrain`, `instanceId`), clearer host-call error, `vkSetAfterDrain` and `vkInstanceId` on the handle |
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

## Image editor (`image-editor`)

A plugin supplies an image editor that opens inside BB's image preview. Plugin API:
`app.slots.experimental_vkImageEditor({ id, title, component })`; the component gets
`PluginVkImageEditorProps` (`src`, `name`, `target: "draft" | "message"`, `done(file)`, `cancel()`).
Feature-test `typeof app.slots.experimental_vkImageEditor === "function"`. The first enabled
registration wins (plugins sorted by id). Core shows an Edit button (aria-label = `title`) next to
Close in `ImageLightbox` when the preview passes `vkEdit` and an editor is registered, and the
image is same-origin (`blob:` or the BB origin). Clicking it swaps the preview for the plugin
component, rendered through `PluginSlotMount` (CSS scope, error boundary, portal scope); a crash
falls back to the preview and hides the button. While the editor is open the lightbox's Escape,
arrows, backdrop/image click and navigation are off.

- `target: "draft"`: `done(file)` uploads like a paste (`sdk.projects.attachments.upload` +
  `registerLocalAttachmentPreview`), swaps the new attachment in at the old one's index in the
  composer draft (`host.setDraft`), drops the old local preview, then closes the preview.
- `target: "message"`: `done(file)` goes to the main message box of the thread whose timeline shows
  the image (a mounted thread-scope composer that is not the sent-message editor) through the
  composer's own attach path (`onAttachFiles`: pending thumbnail, errors), then focuses it.
- Failure: `done` rejects with a user-safe `Error`; the editor stays open.

Also `useComposer().experimental_vkAttachFiles(files: File[]): Promise<void>`: upload files and add
them to this composer's draft as attachments, focus the composer. Thread scope: the thread draft;
new-thread scope: the new-thread draft; queued-message scope, or a composer not on screen:
rejects with a clear message. Feature-test `typeof composer.experimental_vkAttachFiles === "function"`.
Both are one mechanism: `ComposerEditorBridge.vkAttachFiles`, published by `ComposerBox` (since 0.47 the
prompt box itself is the bundled `plugins/composer` plugin; the bridge is built in core).

No schema, no migration, no protocol change.

Consumer: plugin `office-viewer` (image editor; "To chat" button).

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/plugin-sdk/src/app-contract.ts` | `PluginVkImageEditorProps`, `PluginVkImageEditorRegistration`, `PluginAppSlots.experimental_vkImageEditor`, `PluginComposerApi.experimental_vkAttachFiles`, `ExperimentalImageLightboxProps.experimental_vkDraftAttachment` |
| `packages/plugin-sdk/src/internal/plugin-app-registration-collector.ts` | `vkImageEditors` collection and `experimental_vkImageEditor` slot method |
| `packages/plugin-sdk/src/internal/composer-handle.ts` | `ComposerHandleTarget.vkAttachFiles`, handle method `experimental_vkAttachFiles` |
| `packages/plugin-sdk/src/testing/app.tsx` | harness: `vkImageEditors` capture, composer `vkAttachFiles` recorded in `composer.attachedFiles` |
| `apps/app/src/lib/plugin-slots.ts` | `vkImageEditors` slot kind (registration set, snapshot, sorted by plugin id) |
| `apps/app/src/lib/composer-editor-registry.ts` | optional `vkAttachFiles` on `ComposerEditorBridge` |
| `apps/app/src/lib/plugin-composer-handle.ts` | `vkAttachFiles` on the handle target |
| `apps/app/src/components/promptbox/ComposerBox.tsx` | `vkAttachFiles: createVkAttachFiles(host, …)` in the bridge built by `registerEditor` |
| `apps/app/src/components/ui/image-lightbox.tsx` | `vkEdit` prop, Edit button, editor view, key/Escape/click guards |
| `plugins/composer/src/AttachmentPreview.tsx` | passes `experimental_vkDraftAttachment` to `experimental_ImageLightbox` (draft) |
| `apps/app/src/lib/plugin-sdk-app-impl.tsx` | `experimental_ImageLightbox` is `VkSdkImageLightbox` (`vkEdit` from `useVkDraftImageEdit`) |
| `apps/app/src/components/thread/timeline/ConversationAttachments.tsx`, `TimelineImageGallery.tsx` | `vkEdit` from `useVkMessageImageEdit` (message) |
| `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx` | `VkMessageImageThreadProvider` around the gallery |
| `plugins/plugin-api-docs/src/surfaces.ts`, `plugins/bb-guide/.../frontend-api-index.md`, `frontend-core-slots.md`, `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` | docs; `experimental_vkImageEditor` added to the slot lists |

New files: `apps/app/src/lib/vk-image-editor.ts`, `apps/app/src/components/ui/vk-image-editor.tsx`,
`apps/app/src/components/ui/vk-sdk-image-lightbox.tsx`, tests
`apps/app/src/lib/vk-image-editor.test.ts`, `apps/app/src/components/ui/vk-image-editor.test.tsx`,
`packages/plugin-sdk/src/internal/vk-image-editor.test.ts`.

## Child told its parent (`child-told-parent`)

A child thread that has just told its parent its result itself (`bb thread tell`: a turn request in the parent whose
`senderThreadId` is the child, in the last two minutes of the child's turn) gets no «[bb system] … completed» notice on top:
the parent was woken twice for one result (12 of 80 completion notices on the hub, 2026-10-21..23). A progress note earlier in the
turn does not count, and a failed or interrupted turn is always told. Read failures never swallow a notice.

No schema, no migration, no protocol change.

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/threads/child-thread-notifications.ts` | `queueChildThreadTurnNotificationBestEffort` skips a completed turn when `vkChildJustToldParent` |
| `packages/db/src/data/index.ts` | exports `vkChildJustToldParent` |

New files: `packages/db/src/data/vk-child-told-parent.ts`, `packages/db/test/data/vk-child-told-parent.test.ts`.

## Thread info section (`thread-info-section`)

A plugin adds a section to a thread's info panel (project, environment, branch, commits, uncommitted
files), below the uncommitted changes. Plugin API: `app.slots.experimental_vkThreadInfoSection({ id,
title, component })`; the component gets `PluginVkThreadInfoSectionProps` (`threadId`, `projectId`) and
renders for every thread whose info panel is open (return null to show nothing). Feature-test
`typeof app.slots.experimental_vkThreadInfoSection === "function"`.

Since 0.47 bb has its own Info section slot (`experimental_threadInfoSection`, #6117). The VK slot is an
alias of it: the collector registers the section among `threadInfoSections` with group `changes` and
order 30 (after bb's commits 10 and uncommitted changes 20, before storage), wrapped in the labelled group
(`role="group"`, `aria-label` = title) it always had. Rendering, per-pane mounts, ordering and crash
isolation are bb's. Ids share bb's Info section namespace. New plugin code should use
`experimental_threadInfoSection` when present; drop this alias once Lane Pilot does.

No schema, no migration, no protocol change.

Consumer: plugin `lane-pilot` (what Lane Pilot runs for this chat: tasks, current stage, step by step).

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/plugin-sdk/src/app-contract.ts` | `PluginVkThreadInfoSectionProps`, `PluginVkThreadInfoSectionRegistration`, `PluginAppSlots.experimental_vkThreadInfoSection` |
| `packages/plugin-sdk/src/internal/plugin-app-registration-collector.ts` | the slot method: alias into `threadInfoSections` (`vkTitledInfoSection`, `VK_THREAD_INFO_SECTION_ORDER`) |
| `apps/server/test/services/plugins/plugin-authoring-docs.test.ts`, `plugins/bb-guide/.../frontend-api-index.md`, `frontend-core-slots.md` | docs |

New files: `packages/plugin-sdk/src/internal/vk-thread-info-section.test.ts`. No app-side hook points since 0.47.

## Claude bridge tool presentation (`claude-bridge-tool-presentation`)

A plugin registers `presentation` (label, glyph, `suppress`) with `bb.agents.registerTool`. The server resolves it
(`resolveAgentToolPresentation`) and sends it in `dynamicTools`; the Codex and ACP bridges read it from there. The
Claude Code provider rebuilt the tool list for its bridge process as `{name, description, inputSchema}` and dropped
`presentation`, so every `mcp__bb-bridge__<plugin tool>` call read "Running <name>" with the generic Toolbox glyph.
The rebuilt list now keeps `presentation` when the tool has one. A tool without a registered presentation produces the
same object as before. Upstream bug fix, not a new function: no SDK symbol, so no `vk-requires.json` entry. If
upstream fixes it, drop this patch.

No schema, no migration, no protocol change (`dynamicToolSchema` already carries `presentation`).

Consumer: plugin `lane-pilot` (H7 labels of its `lane_pilot_*` tools).

### Hook points in upstream files

| File | What |
| --- | --- |
| `plugins/provider-claude-code/src/session-params.ts` | `buildInternalSessionParams` keeps `presentation` on each dynamic tool |

Tests: `plugins/provider-claude-code/src/session-params.test.ts` ("dynamic tool presentation": kept, absent when not registered, bridge row label).

## Delivered result label (`delivered-label`)

A long tool call the model detached comes back as a system message titled «Delivered <tool_name> result», and the plugin's
`presentation.label` (which already titles the tool's own row) was dropped on the way. The tool-call subject now carries the
completed label, and the app titles the delivered result with it («Владелец ответил» for `lane_pilot_ask_owner`). A tool
without a label reads as before. No SDK symbol, so no `vk-requires.json` entry.

No migration: the subject is JSON inside the existing system-message column; `label` is optional, old rows parse unchanged.

Consumer: plugin `lane-pilot` (`lane_pilot_ask_owner` and its other detached tools).

### Hook points in upstream files

| File | What |
| --- | --- |
| `packages/domain/src/system-message.ts` | optional `label` on the `tool-call` subject |
| `apps/server/src/services/plugins/detached-tool-result-delivery.ts` | `buildDetachedToolResultSubject` copies `presentation.label.completed` |
| `apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx` | the `tool-result-delivered` title uses `subject.label` when present |

Tests: `apps/server/src/services/plugins/vk-delivered-label.test.ts`, `apps/app/src/components/thread/timeline/GeneratedConversationMessage.test.ts` ("titles a detached result with the plugin's label").

## RPC caller identity (`rpc-caller`)

BB's HTTP API has no login: anything that reaches `$BB_SERVER_URL` can post to `/api/v1/plugins/<id>/rpc/<method>`
(and `/plugins/<id>/cli`), so a plugin cannot tell the owner's app from an agent's `curl`. A plugin that declares the
top-level `vk.rpcCallerPolicy: true` key of its package.json (beside `bb`) gets `experimental_vkCaller` in the second
argument of its rpc handlers (next to the stock `experimental_caller`) and in the `ctx` of its CLI `run(argv, ctx)`:
`{ kind, threadId?, pluginId?, evidence }`. A plugin without the key sees exactly the stock context (witness test
`vk-rpc-caller.test.ts`). On a core without the function the field is simply absent (`=== undefined`).

| kind | how the server decides | strength |
| --- | --- | --- |
| `agent-thread` | header `x-bb-vk-thread-token` = `vkt1.<threadId>.<HMAC>`; while any running plugin declares the policy, core adds the token to every thread's env as `BB_VK_THREAD_TOKEN` (a masked `machine-environment` contributed-env entry; with no declaring plugin the env is the stock one) and the `bb` CLI sends it. Also: CLI header `x-bb-vk-client: cli-in-thread` (CLI saw `BB_THREAD_ID` but no token, e.g. a session started before the deploy), then no `threadId` | token verified by the server; the token only lowers standing and is checked before any browser mark |
| `plugin` | existing per-load plugin caller token | verified |
| `owner-ui` | owner login not enforced: `Origin` accepted by the browser guard plus `Sec-Fetch-Site: same-origin\|same-site` (`evidence: browser-headers`, a claim, so the owner's app keeps working); enforced: only a valid `vk_owner` session cookie (plus the same headers; `evidence: owner-session`) | claim before, verified when enforced |
| `owner-cli` | only with owner login enforced: a valid `x-bb-vk-owner-sig` (ed25519 over method, path+query, body hash, timestamp, nonce) by a paired owner key (`evidence: owner-signature`). The bare `x-bb-vk-client: cli` header never gives it | verified |
| `unverified-owner` | owner login not enforced and no `Origin`, `x-bb-vk-client: cli` (`evidence: cli-header`) | client-asserted: any script sends this header (audit round 4); a plugin must not treat it as the owner for secrets or irreversible actions |
| `unknown` | everything else: curl, python, node fetch, a forged token; with login enforced also every request with browser/CLI marks but no proof | n/a |

> [!WARNING]
> Without owner login the marks are claims. Until 7728fe846 a forged `x-bb-vk-client: cli` passed as `owner-cli` (live
> repro, audit round 4); it is now the distinct kind `unverified-owner`. `owner-ui` from browser headers alone remains a
> claim (`evidence: browser-headers`) that only the host-daemon proxy's refusal of `Origin` keeps off agent machines;
> plugins that guard secrets should require `evidence: owner-session` once login is on. The thread-token signing key
> (`<dataDir>/vk-rpc-caller.key`, 0600) is readable by processes of the same OS user, which is fine because the token
> only ever lowers standing.

Data: `<dataDir>/vk-rpc-caller.key` (random, created on first use). No schema, no migration, no host-daemon protocol
change (the token rides the existing contributed-env entries).

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/manifest.ts` | `vkRpcCallerPolicy` on `PluginManifest` and one spread line (`readVkRpcCallerManifest`) |
| `apps/server/src/services/plugins/plugin-service.ts` | `invokeRpcHandler` takes `vkCaller` and passes `experimental_vkCaller` only to a declared plugin; `runCliCommand` strips/forwards it the same way |
| `apps/server/src/routes/plugins.ts` | `classifyVkRpcCaller` in the rpc route and in `POST /plugins/:id/cli` |
| `apps/server/src/services/threads/thread-runtime-config.ts` | `BB_VK_THREAD_TOKEN` appended to `contributedEnv` while `vkRpcCallerPolicyAny()` |
| `apps/server/src/services/plugins/plugin-hook-registry.ts`, `plugin-service.ts` | optional `vkRpcCallerPolicyAny()` on the hook provider |
| `apps/server/src/server.ts` | `installVkRpcCaller(deps)` (data dir of the key) |
| `apps/cli/src/client.ts` | `cliFetch` adds `x-bb-vk-thread-token` / `x-bb-vk-client` |
| `packages/plugin-sdk/src/rpc-contract.ts`, `backend-contract.ts`, `index.ts` | optional `experimental_vkCaller` on the rpc context and `PluginCliContext`, type export |
| `plugins/plugin-api-docs/src/surfaces.ts`, `docs/api_to_audit.md`, `plugins/bb-guide/.../backend-api-index.md` | docs |

New files: `apps/server/src/services/plugins/vk-rpc-caller.ts`, `packages/plugin-sdk/src/vk-rpc-caller.ts`,
`apps/server/test/services/plugins/vk-rpc-caller.test.ts`, `apps/server/test/threads/vk-rpc-caller-env.test.ts`,
`apps/cli/src/__tests__/vk-cli-caller-headers.test.ts`.

Consumers: plugins `env-catalog` (secret methods owner-only) and `lane-pilot` (mutating methods owner-only or the owner form).


## Owner login (`owner-auth`, opt-in `BB_VK_OWNER_AUTH=1`, default off)

Why: BB's HTTP API has no login, so "the owner" cannot be told from an agent running as the same OS user. With the flag on,
the hub trusts an owner only through a secret the agent's environment does not hold.

- **Trust root:** an ed25519 public key paired on the hub, `<dataDir>/vk-owner.json` (0600; keys, `epoch`, `enforceFrom`).
  The private key exists only on the owner's machines: macOS login Keychain item `bb-vk-owner` created with an empty
  trusted-application list (`-T ""`, so every read, even by `security`, prompts for the keychain password; headless SSH or
  launchd agents cannot answer), or on other OS a `0600` file in a `0700` dir (`~/.config/bb-owner/owner.key`). Never an env var.
- **Pairing:** `bb owner pairing-code` on the hub (hub-local, writes a hash to `<dataDir>/vk-owner-pairing.json`, 10 min,
  5 tries, single use) then `bb owner pair --code` on the owner's machine (`POST /api/v1/vk/owner/pair`).
- **Web session:** `bb owner login` signs a one-minute single-use ticket; the browser opens
  `/api/v1/vk/owner/session?ticket=` and gets the `vk_owner` cookie (HttpOnly, SameSite=Strict, Secure on https, 90 days,
  HMAC with the existing core key, bound to the paired key id and the `epoch`).
- **CLI:** `cliFetch` adds `x-bb-vk-owner-sig` to owner-relevant non-GET requests (plugins, plugin-catalog, marketplaces,
  files, thread interactions) unless it runs inside an agent session (`BB_THREAD_ID` / `BB_VK_THREAD_TOKEN`).
- **Classifier:** agent thread token wins over everything (an agent never becomes the owner); then a verified proof gives
  `owner-cli` / `owner-ui`; headers alone give `unknown` once enforced; before that the browser marks stay `owner-ui` (claim) and the bare CLI header is `unverified-owner`.
- **Enforcement and no lock-out:** the flag is inert until the first key is paired; `enforceFrom` = first pairing + 30 min
  (set once, kept by `revoke`). Until then everything behaves as with the flag off. `bb owner pair` opens the browser signed
  in, so the open tab is upgraded at once.
- **Core routes gated** (`createVkOwnerGate`, one `publicApi.use` line): `POST /plugins/install`, `/plugin-catalog/install`,
  `/marketplaces` (+ `DELETE /marketplaces/:name`), `POST /plugins/:id/update`, `PUT /plugins/:id/settings`,
  `POST /plugins/:id/token`, `DELETE /plugins/:id`, `POST /threads/:id/interactions/:iid/respond|resolve|cancel`,
  `POST /files/write|mkdir|move|remove`. Enforced: owner proof only (403 `vk_owner_required`); a verified parent thread may still answer the interactions of the sub-agents it started (`bb thread interactions`), never its own. Not enforced: callers marked
  as an agent (token header, even forged, or `x-bb-vk-client: cli-in-thread`) get 403 `vk_agent_caller_refused` and a
  warn log on the owner's forms (interactions) only; plugin install/update/settings and host file writes stay open to them
  (a Lane Pilot PM ships its own plugin, guards are installed with `bb file write`; owner 2026-10-12, no gates against
  agents); unmarked callers pass as before (a speed bump, not a boundary). A verified plugin caller token passes (the plugin sdk now carries it on `files.write|mkdir|move|remove`). Every refusal names what the owner should do.
  Deliberately NOT gated: `plugins/reload`, `enable`, `disable` (the Lane Pilot deploy script runs them from agent sessions),
  host add / join codes (`/hosts`), `thread spawn --host`, plugin HTTP routes.
- **Recovery:** hub shell: `bb owner pairing-code` and pair a new device (needs no owner proof); `bb owner remove-key <id>`
  for one lost device; `bb owner revoke` for all (enforcement stays); emergency off: remove `BB_VK_OWNER_AUTH` and restart.
- **Residual risk:** a process of the same OS user on an owner machine can read a `0600` key file (Linux) and, on macOS,
  must still beat the keychain prompt; the browser cookie lives in the owner's browser profile (an agent with
  computer-use access to that profile can take it); anyone with a hub shell (the `oracle_bb` ssh key) can mint a pairing
  code. Pair only machines where no agent runs as the same user, and keep the hub ssh key out of agent reach.

No schema, no migration, no host-daemon protocol change: two files in the data dir.

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/server.ts` | `createVkOwnerGate` + `registerVkOwnerRoutes` on `publicApi`, after the browser guard |
| `apps/server/src/services/plugins/plugin-api.ts` | `wrapSdkForPlugin`: `files.write\|mkdir\|move\|remove` go through the plugin's caller-token sdk |
| `apps/server/src/routes/plugins.ts` | `vkOwnerAuthFor(context)` before the body is read, passed as `ownerAuth` to `classifyVkRpcCaller` (rpc and cli routes) |
| `apps/server/src/services/plugins/vk-rpc-caller.ts` | `unverified-owner`, `ownerAuth` argument, `vkSignLabel` |
| `apps/cli/src/client.ts`, `apps/cli/src/command-groups.ts` | `cliFetch` signs; command group `owner` |
| `packages/domain/src/plugin-cli.ts`, `plugins/bb-guide/skills/bb-cli/references/command-index.md` | `owner` is a reserved command and listed |
| `packages/config/package.json` | export `./vk-owner-auth` |
| `packages/plugin-sdk/src/vk-rpc-caller.ts` | kind `unverified-owner`, evidences `owner-session`, `owner-signature` |

New files: `packages/config/src/vk-owner-auth.ts`, `apps/server/src/services/plugins/vk-owner-auth.ts`,
`apps/cli/src/vk-owner-key.ts`, `apps/cli/src/commands/owner.ts`, tests `apps/server/test/services/plugins/vk-owner-auth.test.ts`,
`apps/cli/src/__tests__/vk-owner-key.test.ts`.

## Worktree dependencies (`worktree-deps`, off with `BB_VK_WORKTREE_DEPS=0`)

A new git worktree environment gets the source checkout's installed packages as links, so the agent does not run
`npm ci` in every worktree chat (1.9 GB per SelfyStudio worktree, 18 GB on one machine, 2026-10-23). Each package in the
checkout's `node_modules` (root, declared workspaces, nested packages with their own install up to 3 folders deep) becomes
a link to the checkout's copy; a link back into the repository (a workspace package) points at the worktree's own copy;
`.bin` and `.package-lock.json` are copied, generated clients (`.prisma`, `@prisma/client`) are copied, tool caches
(`.vite`, `.vitest`, `.cache`) get empty folders of their own. A worktree that already has `node_modules` is left alone; any
failure leaves the worktree as before (the agent installs as it used to). The same mirror Lane Pilot gives its writers.

No schema, no migration, no protocol change.

### Hook points in upstream files

| File | What |
| --- | --- |
| `plugins/environment-git-worktree/host/worktree.ts` | `finishWorktreeSetup`: `vkLinkWorktreeDependencies` after the included files, a progress line naming the linked folders |

New files: `plugins/environment-git-worktree/host/vk-worktree-deps.ts`, `plugins/environment-git-worktree/host/vk-worktree-deps.test.ts`.

## Skill tree cache capacity

The host daemon keeps up to 512 immutable skill trees in memory and on disk. With a 333-skill catalog,
upstream's 256-entry memory LRU evicted the next turn's entries while reading them; the 64-tree disk
store then forced 269 repeated server fetches per turn. This adds seconds before `turn/started`,
including for ACP providers such as ZCode. The bounded cache now holds the current catalog without
that eviction cycle. No wire, schema or migration changes.

| File | What |
| --- | --- |
| `apps/host-daemon/src/injected-skills.ts` | Both cache capacities use `vkSkillTreeCacheLimit` |

New file: `apps/host-daemon/src/vk-skill-cache.ts`. Regression: a 333-skill catalog stays warm after
its disk copies are evicted; no second server fetch. Existing store-cap tests retain LRU eviction.
