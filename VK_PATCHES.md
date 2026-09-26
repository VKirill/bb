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
`apps/server/src/services/ai/inference.ts`,
`packages/plugin-sdk/src/ai-services.ts`,
`plugins/provider-codex/src/ai/chatgpt-client.ts`,
`apps/server/src/services/threads/title-generation.ts`,
`packages/templates/src/templates/generate-thread-metadata.md`.

## README

`README.md` is replaced by the fork's install guide and FAQ. On a rebase
conflict keep the fork's version.
