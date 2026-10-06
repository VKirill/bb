---
title: VK experimental core extensions
status: experimental
updated: 2026-09-25
tags: [vk, plugin-sdk, upgrade]
---

# Portable VK extensions

This series extends the protocol-215 baseline `c02ca4246f54a94d81a0440c9a43a856b2936ee2`. It does not include the separate required-session-policy/protocol-216 branch. Preserve earlier VK changes in that baseline when upgrading the server.

## Independent modules and connection points

| Extension | Implementation | Core connection points |
| --- | --- | --- |
| Plugin enable, disable and removal | `apps/server/src/services/plugins/vk-plugin-lifecycle.ts` | `plugin-runtime.ts` loads the export; `plugin-service.ts` invokes transitions before disposal; `plugin-api.ts` advertises support |
| Lifecycle SDK contract | `packages/plugin-sdk/src/vk-plugin-lifecycle.ts` | SDK index export and optional `PluginServerApi.experimental_vkPluginLifecycle` capability |
| Isolated schedules | `apps/server/src/services/plugins/vk-schedule-options.ts`, `packages/plugin-sdk/src/vk-schedule-options.ts` | `plugin-service.ts` `sweepDueSchedules` hands isolated schedules to the runner; `plugin-runtime.ts` creates it and aborts runs on dispose; `plugin-api.ts` registers `experimental_vkSchedule`; `manifest.ts` reads `vk.schedules` |
| Native new-thread selection | `apps/app/src/components/plugin/plugin-composer-host.tsx`, `apps/app/src/components/promptbox/composer-environment-provenance.ts` | Composer context, SDK hook adapter, `RootComposeView`, `NewThreadComposer`, SDK declarations |

The composer extension reads BB's existing selection and environment request. It does not implement a second session creator. Native environment provisioning and thread creation remain owned by BB. Its initial commits are `5daca630a40b58cef8b1369b302c623ebb229039` and `a204375c5`; they must precede consumers of the new hook.

> [!IMPORTANT]
> A patch series is portable source, not a promise of compatibility with every future BB release. If upstream changes a connection point, resolve that conflict and run the checks below. Do not replace an upstream checkout with this worktree or include protocol-216 commits accidentally.

## Lifecycle consumer

Export `experimental_vkLifecycle` beside a plugin's default server factory. The handler receives `action`, plugin-scoped `kv`, `signal`, and authenticated `callHost`. The default factory is not started just to remove a disabled plugin.

| Action | Timing | Plugin responsibility |
| --- | --- | --- |
| `enable` | Initial load, cold server start, re-enable | Idempotently reconcile owned integrations |
| `disable` | Before enabled state changes or workers stop | Disable owned integrations and persist progress |
| `remove` | Before registration, storage and workers are removed, including when disabled | Remove owned files and restore owned config changes |

Ordinary reload and server shutdown do not call disable/remove. A plugin that declares `vk.lifecycle.drain` in package.json additionally receives `reload` and `shutdown` (a non-destructive drain, see VK_PATCHES.md, "Plugin lifecycle drain"). A handler error prevents the requested disable/removal from completing. Completed work on one host is not rolled back if another host fails: store progress and retry idempotently. A missing export after registration is an error, not successful cleanup. Calls have an abort signal and a bounded deadline; handlers must honor cancellation.

The core does not decide which CLI files belong to Lane Pilot. The plugin must keep an ownership manifest, preserve pre-existing/user-modified files, and refuse installation on an older core if it relies on this cleanup contract.

## Export and apply

From the completed extension branch, export a reviewable series into an empty directory outside the checkout:

```sh
git format-patch --binary --full-index --output-directory /absolute/path/to/vk-patches c02ca4246f54a94d81a0440c9a43a856b2936ee2..HEAD
git bundle create /absolute/path/to/vk-core.bundle c02ca4246f54a94d81a0440c9a43a856b2936ee2..HEAD
```

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
