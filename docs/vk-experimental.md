---
title: VK experimental core extensions
status: experimental
updated: 2026-09-25
tags: [vk, plugin-sdk, upgrade]
---

# Portable VK extensions

This complete series starts at upstream BB `e865697f5` (bb-app 0.43.3), before the first VK session-policy change. It includes the existing protocol-215 context isolation, composer selection and plugin lifecycle extensions. The separate required-session-policy/protocol-216 branch is not included or installed.

## Independent modules and connection points

| Extension                              | Implementation                                                                                                                                                                                                                                          | Core connection points                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Plugin enable, disable and removal     | `apps/server/src/services/plugins/vk-plugin-lifecycle.ts`                                                                                                                                                                                               | `plugin-runtime.ts` loads the export; `plugin-service.ts` invokes transitions before disposal; `plugin-api.ts` advertises support |
| Lifecycle SDK contract                 | `packages/plugin-sdk/src/vk-plugin-lifecycle.ts`                                                                                                                                                                                                        | SDK index export and optional `PluginServerApi.experimental_vkPluginLifecycle` capability                                         |
| Session skills/MCP/plugin policy       | `packages/domain/src/vk-session-policy.ts`, `apps/server/src/services/threads/vk-session-policy.ts`, `apps/server/src/services/plugins/vk-session-policy-service.ts`                                                                                    | Domain exports, `plugin-service.ts` factory spread, thread runtime resolver                                                       |
| Provider enforcement                   | `plugins/provider-claude-code/src/bridge/vk-session-policy.ts`, `plugins/provider-codex/src/bridge/vk-session-policy.ts`, `packages/provider-bridge-acp/src/vk-session-policy.ts`, `packages/provider-bridge-protocol/src/bridge-kit/vk-skill-roots.ts` | Each bridge invokes its policy adapter; protocol remains 215                                                                      |
| Plugin exclusion                       | `apps/server/src/services/threads/vk-excluded-plugins.ts`, `apps/server/src/routes/vk-plugins.ts`, `apps/app/src/hooks/queries/vk-excluded-plugins-queries.ts`, `apps/app/src/components/plugin/vk-composer-registrations.ts`                           | Authenticated route registration, composer slot filter                                                                            |
| Composer snapshot construction         | `apps/app/src/components/promptbox/vk-composer-selection.ts`, `apps/app/src/components/promptbox/vk-composer-place.ts`                                                                                                                                  | Two calls from `NewThreadComposer.tsx`                                                                                            |
| Native dispatch environment inspection | `apps/server/src/services/threads/vk-dispatch-intent.ts`                                                                                                                                                                                                | One call from dispatch checkpoint                                                                                                 |
| Native new-thread selection            | `apps/app/src/components/plugin/plugin-composer-host.tsx`, `apps/app/src/components/promptbox/composer-environment-provenance.ts`                                                                                                                       | Composer context, SDK hook adapter, `RootComposeView`, `NewThreadComposer`, SDK declarations                                      |

The composer extension reads BB's existing selection and environment request. It does not implement a second session creator. Native environment provisioning and thread creation remain owned by BB. Its initial commits are `5daca630a40b58cef8b1369b302c623ebb229039` and `a204375c5`; they must precede consumers of the new hook.

> [!IMPORTANT]
> A patch series is portable source, not a promise of compatibility with every future BB release. If upstream changes a connection point, resolve that conflict and run the checks below. Do not replace an upstream checkout with this worktree or include protocol-216 commits accidentally.

## Lifecycle consumer

Export `experimental_vkLifecycle` beside a plugin's default server factory. The handler receives `action`, plugin-scoped `kv`, `signal`, and authenticated `callHost`. The default factory is not started just to remove a disabled plugin.

| Action    | Timing                                                                        | Plugin responsibility                               |
| --------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `enable`  | Initial load, cold server start, re-enable                                    | Idempotently reconcile owned integrations           |
| `disable` | Before enabled state changes or workers stop                                  | Disable owned integrations and persist progress     |
| `remove`  | Before registration, storage and workers are removed, including when disabled | Remove owned files and restore owned config changes |

Ordinary reload and server shutdown do not call disable/remove. A handler error prevents the requested disable/removal from completing. Completed work on one host is not rolled back if another host fails: store progress and retry idempotently. A missing export after registration is an error, not successful cleanup. Calls have an abort signal and a bounded deadline; handlers must honor cancellation.

The core does not decide which CLI files belong to Lane Pilot. The plugin must keep an ownership manifest, preserve pre-existing/user-modified files, and refuse installation on an older core if it relies on this cleanup contract.

## Export and apply

The tracked exporter is `vk/export.mjs`. From a clean committed checkout:

```sh
node vk/export.mjs /absolute/path/to/new-vk-kit
```

The resulting `modules/` directory contains all newly added files with their original paths. `integration.patch` contains only changes to upstream files. `manifest.json` lists both sets explicitly. `patches/` and `vk-core.bundle` preserve the full commit history. Use either the full patch series or modules plus integration patch, never both.

To apply the separated form on the exact upstream baseline:

```sh
git apply --check /absolute/path/to/new-vk-kit/integration.patch
cp -R /absolute/path/to/new-vk-kit/modules/. ./
git apply /absolute/path/to/new-vk-kit/integration.patch
```

Existing module paths must be reviewed before copying onto an already patched checkout. Public SDK type declarations and bridge connection points still require integration: a shared cross-provider feature cannot honestly be reduced to two changes in the server entrypoint.

Apply on a separate, clean upgrade branch derived from the intended BB version. Skip already-integrated commits after checking their content; do not duplicate them.

```sh
git switch -c vk/upgrade
git am --3way /absolute/path/to/vk-patches/*.patch
```

`git am --abort` cancels a conflicting application. Do not force a conflict through by copying whole core files from the old version.

## Required checks after a port

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck --filter=@bb/server --filter=@get-bb/plugin-sdk --filter=@bb/app --filter=@bb/plugin-api-map
pnpm exec turbo run test --filter=@bb/server -- test/services/plugins/plugin-service.test.ts test/services/plugins/vk-plugin-lifecycle.test.ts test/services/plugins/plugin-host-rpc.test.ts
pnpm exec turbo run build --filter=bb-app
pnpm --filter bb-app smoke:tarball
```

Also run composer selection and SDK harness regressions, then verify installed enable → disable → enable → remove and removal while disabled against a disposable plugin. Test a host failure and retry. Existing CLI programs and unrelated plugins must survive those transitions.

Record source commit, artifact SHA-256, installed runtime path and observed protocol. This series adds no migrations or host-daemon wire changes.
