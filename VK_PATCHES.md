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
| `plugins/provider-claude-code/src/**` | params schema, session options, SDK options, filtered skill plugins |
| `plugins/provider-codex/src/bridge/bridge.ts` | launch `-c` args, per-session skill roots, construction signature |
| `packages/provider-bridge-acp/src/bridge/bridge.ts` | OpenCode env, Cursor data dir, filtered skill list, same env on every turn |
| `packages/provider-bridge-acp/src/bridge/cursor-mcp-approval.ts` | export `cursorProjectSlug`, `cursorDataDirectory` |
| `plugins/bb-guide/skills/bb-plugin-authoring/references/*-api-index.md` | docs for new exports |
| `apps/server/test/services/plugins/plugin-agent-tools.test.ts` | `bb.agents` key list |
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
| `apps/app/src/lib/plugin-sdk-hooks.ts` | `experimental_vkSetDispatchData` |
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
Not carried: the required-session-policy / compiled MAIN agent series
(protocol 216) — it adds its own DB migrations and host-daemon protocol changes.

### Hook points in upstream files

| File | What |
| --- | --- |
| `apps/server/src/services/plugins/plugin-runtime.ts` | `createVkPluginLifecycleRunner` beside safe-mode helpers; `runLifecycle`, `lifecyclePluginIds` in the runtime |
| `apps/server/src/services/plugins/plugin-service.ts` | run the transition before disposal |
| `apps/server/src/services/plugins/plugin-api.ts` | advertise `experimental_vkPluginLifecycle` |
| `packages/plugin-sdk/src/backend-contract.ts`, `index.ts` | capability and type export |
| `plugins/plugin-api-docs/src/surfaces.ts`, `docs/api_to_audit.md` | docs |

New files: `apps/server/src/services/plugins/vk-plugin-lifecycle.ts`,
`packages/plugin-sdk/src/vk-plugin-lifecycle.ts`, their tests, `docs/vk-experimental.md`.

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
| `apps/app/src/components/pickers/ModelReasoningPicker.tsx` | star, spoilers, fixed `w-80` / list `h-52` |

New files: `apps/app/src/components/pickers/vk-favorite-models.ts`, `vk-model-groups.ts` and tests.

When model labels look like `Provider/Model` and there are at least two providers, the catalog is an accordion: click a provider row to expand its models.
