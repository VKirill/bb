# VK experimental patches

Branch `vk/experimental` on top of an upstream `desktop-v*` tag. Everything
here is marked `VK EXPERIMENTAL` in code, uses the `vk` prefix in names, and
is absent from upstream bb. Rebase this branch on each new upstream tag; a
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
| Cursor (ACP) | instruction list filtered | — | — | — |

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
| `packages/provider-bridge-acp/src/bridge/bridge.ts` | OpenCode env, filtered skill list |
| `plugins/bb-guide/skills/bb-plugin-authoring/references/*-api-index.md` | docs for new exports |
| `apps/server/test/services/plugins/plugin-agent-tools.test.ts` | `bb.agents` key list |

New files (no conflicts): `packages/domain/src/vk-session-policy.ts`,
`packages/provider-bridge-protocol/src/bridge-kit/vk-skill-roots.ts`,
`apps/server/src/services/threads/vk-session-policy.ts`,
`plugins/provider-claude-code/src/bridge/vk-session-policy.ts`,
`plugins/provider-codex/src/bridge/vk-session-policy.ts`,
`packages/provider-bridge-acp/src/vk-session-policy.ts`, and their tests.

Consumer: plugin `project-folders` (VKirill/bb-plugin-project-folders), tab
«Контекст сессии», shown only when the API above exists.
