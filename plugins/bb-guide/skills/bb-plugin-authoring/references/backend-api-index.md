# Backend API symbol index

Use this index to check backend, host, AI-service, and test imports.
Read the detailed backend references for behavior, fields, and examples.
Read the installed declarations for exact current signatures.

## `@get-bb/plugin-sdk`

- `PLUGIN_CLI_OUTPUT_MAX_BYTES`
- `defineRpcContract`
- `experimental_defineHostEntry`
- `defineCli`
- `cliCommand`
- `PluginCliError`
- `BbContext`
- `BbNavigate`
- `BbPluginApi`
- `CodeOverflowMode`
- `ComposerCustomization`
- `ComposerPlusMenuItem`
- `ComposerSendMenuItem`
- `ComposerRichTextSpec`
- `ComposerDraft`
- `ComposerMention`
- `ComposerInsertPart`
- `ComposerInsertOptions`
- `DiffProps`
- `DiffViewMode`
- `ExperimentalAppPanel`
- `ExperimentalAppPanelSurface`
- `ExperimentalDesktopBrowserAcquireInput`
- `ExperimentalDesktopBrowserCreateInput`
- `ExperimentalDesktopBrowserLease`
- `ExperimentalDesktopBrowserScope`
- `ExperimentalDesktopBrowsersArea`
- `ExperimentalDiffFileContent`
- `ExperimentalDiffFullFileContents`
- `ExperimentalFileLinkProps`
- `ExperimentalFileLocation`
- `ExperimentalFileOpenOptions`
- `ExperimentalFixedTabTargetContract`
- `ExperimentalFixedTabTargetState`
- `ExperimentalHostCallOptions`
- `ExperimentalHostClient`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignalEvent`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalLiveFileTarget`
- `ExperimentalOpenFixedTabOptions`
- `ExperimentalPermissionModePickerProps`
- `ExperimentalPluginFixedTabReference`
- `ExperimentalPluginRpcCaller`
- `ExperimentalPluginRpcHandlerContext`
- `ExperimentalPluginRpcHandlersWithContext`
- `ExperimentalPluginWebSocket`
- `ExperimentalPluginWebSocketContext`
- `ExperimentalPluginWebSocketHandler`
- `ExperimentalPluginWebSocketHandlers`
- `ExperimentalProviderModelPickerProps`
- `ExperimentalProviderModelPickerRouting`
- `ExperimentalProviderModelPickerValue`
- `JsonValue`
- `ReadonlyJsonValue` — deep-readonly JSON, e.g. `context.pluginMetadata` values
- `MarkdownProps`
- `NewThreadComposerProps`
- `NewThreadRequest`
- `MessageDispatchHookContext`
- `MessageDispatchHookDecision`
- `PluginDispatchAttemptKind`
- `PluginDispatchEnvironmentIntent`
- `PluginDispatchExecution`
- `PluginDispatchExecutionSources`
- `PluginEnvironments` — `bb.experimental_environments`: `register` +
  `recheck` (see backend-events.md, environment providers)
- `PluginServerAccess` — `bb.experimental_serverAccess.register`
- `ServerAccessProviderDeclaration`
- `ServerAccessGrant`
- `PluginMachineProviderResource` — non-null JSON persisted by machine checkpoints and lifecycle results
- `PluginMachines` — `bb.experimental_machines.register` and bootstrap helper (see backend-machines.md)
- `MachineExecutorRequest` — argv, timeout, signal, optional private stdin
- `MachineExecutor` — transport exec
- `MachineBootstrapRequest` — durable key, optional executor and access selection, report, signal
- `MachineBootstrapApi` — bootstrap
- `PluginMachineProviderDeclaration`
- `PluginMachineValidateDecision`
- `PluginEnvironmentProviderDeclaration`
- `PluginEnvironmentProviderRequirements` — `requires`, e.g.
  `{ gitCheckout: true }`; also `projectCheckout`, `gitRemote` and `projectless`.
  Anything else comes through the declaration's `inputs` validator
- `PluginEnvironmentValidateDecision` — `{ action: "accept" }` or
  `{ action: "refuse", message }`, the message being the caller's error
- `PluginDispatchInput`
- `PluginHookHandler`
- `PluginHookName`
- `PluginHookSignatures`
- `PluginHooks`
- `PluginTurnFailedEvent`
- `ComposerSubmitOptions`
- `ComposerSelection`
- `PluginAgentConfiguration`
- `PluginAgentConfigurationContext`
- `PluginAgentToolContentPart`
- `PluginAgentToolContext`
- `PluginAgentToolRegistrationBase`
- `PluginAgentToolResult`
- `PluginAgentToolSelection`
- `PluginAgents`
- `PluginAiCompleteOptions`
- `PluginAiServiceDeclaration`
- `PluginAiServiceStatus`
- `PluginAiServices`
- `PluginAiTranscribeOptions`
- `PluginAppBuilder`
- `PluginAppComposer`
- `PluginAppContentScripts`
- `PluginAppDefinition`
- `PluginAppSetup`
- `PluginAppSlots`
- `PluginBackground`
- `PluginBbSdk` — `bb.sdk`; thread plugin metadata calls default `pluginId`
  (see backend-sdk.md)
- `PluginCli`
- `PluginCliBooleanOption`
- `PluginCliCommand`
- `PluginCliCommandInfo`
- `PluginCliConstraint`
- `PluginCliContext`
- `PluginCliDurationOption`
- `PluginCliDurationUnit`
- `PluginCliEnumOption`
- `PluginCliErrorCode`
- `PluginCliExecutionResult`
- `PluginCliIntegerOption`
- `PluginCliOption`
- `PluginCliOptionValues`
- `PluginCliOutputLimitError`
- `PluginCliPositional`
- `PluginCliPositionalValues`
- `PluginCliRegistration`
- `PluginCliResult`
- `PluginCliRunInput`
- `PluginCliSpec`
- `PluginCliStringOption`
- `PluginCodeThemeData`
- `PluginCodeThemeState`
- `PluginCodeThemeTokenRule`
- `PluginAppCommands`
- `PluginCommandContext`
- `PluginCommandShortcut`
- `PluginCommandRegistration`
- `ExperimentalComposerCommandRegistration`
- `PluginComposerApi`
- `PluginComposerMention`
- `PluginComposerScope`
- `PluginComposerTextEffect`
- `PluginComposerThreadRowStatus`
- `PluginContentScriptContext`
- `PluginContentScriptDisposer`
- `PluginContentScriptRegistration`
- `PluginDiffRendererProps`
- `PluginDiffRendererRegistration`
- `PluginEvents`
- `PluginFileOpenerProps`
- `PluginFileOpenerRegistration`
- `PluginFileOpenerSource`
- `PluginFixedTabDeclaration`
- `PluginFixedTabRegistration`
- `PluginHomepageSectionProps`
- `PluginHomepageSectionRegistration`
- `PluginHosts`
- `PluginHttp`
- `PluginHttpAuthMode`
- `PluginHttpHandler`
- `PluginInteractionCancelReason`
- `PluginInteractionDescription`
- `PluginInteractionRequest`
- `PluginInteractionResult`
- `PluginKvStorage`
- `PluginLogger`
- `PluginMentionItem`
- `ExperimentalPluginMentionImage`
- `PluginMentionProviderRegistration`
- `PluginMentionSearchContext`
- `PluginMentionTrigger`
- `PluginMessageActionContext`
- `PluginMessageActionRegistration`
- `PluginMessageDirectiveMessage`
- `PluginMessageDirectiveOpenWorkspaceFile`
- `PluginMessageDirectiveProps`
- `PluginMessageDirectiveRegistration`
- `PluginNavPanelProps`
- `PluginNavPanelRegistration`
- `PluginNewThreadPanelActionContext`
- `PluginNewThreadPanelActionRegistration`
- `PluginNewThreadPanelProps`
- `PluginPanelActionOpenOptions`
- `PluginPendingInteractionProps`
- `PluginPendingInteractionRegistration`
- `PluginPendingInteractionView`
- `PluginProviderCapabilities`
- `PluginProviderCompletedTurnDisplay`
- `PluginProviderComposerAction`
- `PluginProviderDeclaration`
- `ExperimentalPluginProviderEnvContext`
- `ExperimentalPluginProviderEnvEntry`
- `ExperimentalPluginProviderEnvHealthContext`
- `ExperimentalPluginProviderEnvHealth`
- `PluginProviderExtensionKindDeclaration`
- `PluginProviderFallbackModel`
- `PluginProviderIconRegistration`
- `PluginProviderMaintenance`
- `PluginProviderModelCatalogScope`
- `PluginProviderNativeRootEntry`
- `PluginProviderNativeRoots`
- `PluginProviderOptionDescriptor`
- `PluginProviderOptionsContext`
- `PluginProviderPermissionMode`
- `PluginProviderReasoningLevel`
- `PluginProviderStrings`
- `PluginProviders`
- `PluginProvidersState`
- `PluginRealtime`
- `PluginRealtimeConnectionState`
- `PluginRowLabels`
- `PluginRowPresentation`
- `PluginRpc`
- `PluginRpcCallArgs`
- `PluginRpcClient`
- `PluginRpcContract`
- `PluginRpcError`
- `PluginRpcErrorCode`
- `PluginRpcHandlers`
- `PluginRpcIssuePathSegment`
- `PluginRpcMethodContract`
- `PluginRpcResult`
- `PluginRpcValidationIssue`
- `PluginSdkApp`
- `PluginServerApi`
- `PluginSettingDescriptor`
- `PluginSettingDescriptors`
- `PluginSettingValue`
- `PluginSettings`
- `PluginSettingsHandle`
- `PluginSettingsSectionProps`
- `PluginSettingsSectionRegistration`
- `PluginSettingsState`
- `PluginSettingsValues`
- `PluginSharedPortTunnelIdentity`
- `PluginSidebarFooterActionContext`
- `PluginSidebarFooterActionProps`
- `PluginSidebarFooterActionRegistration`
- `PluginSidebarProject`
- `PluginSidebarPullRequest`
- `PluginSidebarSplitPane`
- `PluginSidebarThread`
- `PluginSidebarThreadActions`
- `PluginSidebarThreadActivity`
- `PluginSidebarThreadIndicator`
- `PluginSidebarThreadPullRequestState`
- `PluginSidebarThreadSplit`
- `PluginSidebarThreadsState`
- `PluginSourceCodeRendererProps`
- `PluginSourceCodeRendererRegistration`
- `PluginStatusApi`
- `PluginStorage`
- `PluginTargetedPanelActionOpenOptions`
- `PluginThreadEventHandler`
- `PluginThreadEventName`
- `PluginThreadEventPayloads`
- `PluginThreadHeaderActionProps`
- `PluginThreadHeaderActionRegistration`
- `PluginThreadListProps`
- `PluginThreadListRegistration`
- `PluginThreadPanelActionContext`
- `PluginThreadPanelActionRegistration`
- `PluginThreadPanelProps`
- `PluginTimelineRendererProps`
- `PluginTimelineRendererRegistration`
- `PluginTimelineRendererRow`
- `PluginTimelineRowPresentation`
- `PluginTimelineRowStatus`
- `PluginUi`
- `SourceCodeLineRange`
- `SourceCodeProps`
- `StandardSchemaV1`
- `StandardSchemaV1InferInput`
- `StandardSchemaV1InferOutput`
- `StandardSchemaV1Issue`
- `StandardSchemaV1Result`
- `ThreadChatMessageAction`
- `ThreadChatMessageReference`
- `ThreadChatProps`
- `UrlLinkProps`

## `@get-bb/plugin-sdk/environment-provider`

- `PluginEnvironmentProviderAvailabilityContext` and
  `PluginEnvironmentProviderAvailability` — context and result for a
  declaration's optional `availability` method
- `PluginEnvironmentProviderDefinition` — idempotent long-running `create`
  and `remove`, plus optional `validate`, `availability`,
  `restore`, `inputs` and policy
- `PluginEnvironmentProviderInputsSchema` — the `inputs` type parameter:
  a Standard Schema v1 validator (a zod schema is one), or `undefined` for
  `inputs: null` in `create`
- `PluginEnvironmentProviderPolicy` — `retireGraceMs`, `pathKeys`
- `PluginEnvironmentProviderValidateContext` — the `validate` context
  typed from `requires` and `inputs`, like the create context
- `PluginEnvironmentProviderCreateContext` — facts for a fresh environment,
  including the `suggestedBranchName` core would use
- `PluginEnvironmentProviderRestoreContext` — `restore`'s
  context: the creation inputs plus `previous.environment` and its private
  `previous.resource`
- `PluginEnvironmentProviderCreateResult` — `created` names the path and may
  carry the private, 16 KiB-capped JSON `resource`; the selected machine owns
  the host identity
- `PluginEnvironmentProviderProgress` — durable `step` and `log` updates
- `PluginEnvironmentProviderRemoveContext` — includes the private
  `resource` returned by the launch that made the environment
- `PluginEnvironmentProviderRemoveResult`

## `@get-bb/plugin-sdk/machine-provider`

- `PluginMachineProviderDefinition` — id, display, description, icon, inputs,
  availability, validation, create, optional paired suspend/resume,
  `ephemeral` automatic retirement policy, and remove
- `PluginMachineProviderInputsSchema`
- `PluginMachineProviderAvailability`
- `PluginMachineProviderValidateContext`
- `PluginMachineProviderCreateContext` — async `checkpoint(resource)` after
  preparing enrollment and allocating, before bootstrap; never bundle credentials
- `PluginMachineProviderCreateResult`
- `PluginMachineProviderLifecycleContext` — shared create, suspend and resume
  context with a durable `checkpoint` resource callback
- `PluginMachineProviderProgress`
- `PluginMachineProviderResourceResult`
- `PluginMachineProviderRemoveResult`

## `@get-bb/plugin-sdk/host`

- `experimental_defineHostEntry`
- `experimental_filterResolvedNativeRoots`
- `experimental_killProcessesWithCwdUnder` — reap processes whose cwd is under a
  workspace a provider is tearing down, before removing the directory
- `experimental_nativeRootsHostContract`
- `experimental_nativeRootsResolveInputSchema`
- `experimental_nativeRootsResolveOutputSchema`
- `experimental_resolveClaudePluginRoots`
- `experimental_resolveVendorPluginRoots`
- `experimental_sanitizeInheritedChildProcessEnv`
- `experimental_spawnPortableOutputProcess`
- `ExperimentalClaudePluginRoots`
- `ExperimentalClaudePluginRootsArgs`
- `ExperimentalDroppedNativeRoot`
- `ExperimentalFilteredNativeRoots`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalNativeRootsHostContract`
- `ExperimentalNativeRootsResolveAnswer`
- `ExperimentalNativeRootsResolveInput`
- `ExperimentalNativeRootsResolveOutput`
- `ExperimentalQuestionFormHost`
- `ExperimentalQuestionShortcut`
- `ExperimentalSanitizeInheritedChildProcessEnvArgs`
- `ExperimentalVendorPlugin`
- `ExperimentalVendorPluginRoots`
- `ExperimentalVendorPluginRootsArgs`

## `@get-bb/plugin-sdk/testing`

- `ExperimentalFakeWebSocketRouteRecord`
- `ExperimentalFakeWebSocketSession`
- `PluginContextStaleError`
- `createFakePluginHost`
- `createFakeSdk`
- `experimental_scanPublicSdkOnly`
- `makeHostResponse`
- `makeMessageDispatchHookContext`
- `makePluginAgentConfigurationContext`
- `makeQueueEntry`
- `makeThreadResponse`
- `makeTurnFailedEvent`
- `CreateFakePluginHostOptions`
- `FakeAgentToolRecord`
- `FakeCliRecord`
- `FakeHttpRouteRecord`
- `FakeLogEntry`
- `FakeLogLevel`
- `FakeMentionProviderRecord`
- `FakePluginBehaviorDrivers`
- `ExperimentalFakeHostRpcCall`
- `FakePluginHarness`
- `FakePluginHost`
- `FakePluginInspectionState`
- `FakePluginLifecycleControls`
- `FakePluginRegistrations`
- `FakeRealtimeSignal`
- `FakeScheduleRecord`
- `FakeSdkCall`
- `FakeSdkHarness`
- `FakeSdkOverrides`
- `FakeServiceRecord`
- `PublicSdkOnlyScan`
- `PublicSdkOnlyScanOptions`
- `PublicSdkOnlyViolation`

## `@get-bb/plugin-sdk/testing/host`

- `experimental_createHostEntryHarness`
- `ExperimentalCreateHostEntryHarnessOptions`
- `ExperimentalHostEntryHarness`
- `ExperimentalHostHarnessSignal`

## VK experimental (not in upstream bb)

- `bb.agents.experimental_vkSessionPolicy(resolver)` — optional; present only in VK builds. The resolver gets the `configure` context and returns a `VkSessionPolicy` or null. Feature-test with `typeof bb.agents.experimental_vkSessionPolicy === "function"`.
- `experimental_vkLifecycle(ctx)` — optional named export beside the server factory; VK builds only. Core calls it on enable, disable and removal before disposal; `bb.server.experimental_vkPluginLifecycle === true` advertises support. Types: `ExperimentalVkPluginLifecycleHandler`, `ExperimentalVkPluginLifecycleContext` (`action`, `deadline`, plugin-scoped `kv`, `signal`, authenticated `callHost`), `ExperimentalVkPluginLifecycleAction` (`enable` | `disable` | `remove` | `reload` | `shutdown`).
- Drain on reload and shutdown (VK builds only, opt-in): declare `"vk": { "lifecycle": { "drain": { "timeoutMs": 30000 } } }` at the top level of package.json (beside `bb`; 1000 to 600000, default 30000). Then `experimental_vkLifecycle` also runs with `action: "reload"` or `"shutdown"` in the instance being replaced or stopped, with `ctx.deadline` (epoch ms) and an aborting `ctx.signal`; a throw or the deadline is logged and the reload goes on. While it runs, new message.dispatch, contributeEnv, mention-resolve and tool-call work for the plugin waits (up to its own timeout) for the new instance, and due schedules are held for the next sweep. `bb.vk.startReason` (`"boot"` | `"enable"` | `"reload"`) and `bb.vk.afterDrain` (true when the previous instance's reload drain finished; read it from a service, not the factory) tell the new instance how it started. A plugin that declares the drain gets a clear error when it calls the host from its factory. Feature-test `bb.vk?.startReason`. Types: `ExperimentalVkLifecycleInfo`, `ExperimentalVkLifecycleStartReason`, `ExperimentalVkLifecycleDrainManifest`.
- `bb.background.experimental_vkSchedule(name, cron, fn, options)` — optional, VK builds only: a cron schedule that the sweep starts without awaiting (isolated), so a slow run does not hold other schedules. `fn` receives `{ signal }`. Package.json top-level `vk.schedules.<name>` takes the same options for a plain `bb.background.schedule`; the API options win. Feature-test with `typeof bb.background.experimental_vkSchedule === "function"`. Types: `ExperimentalVkScheduleOptions` (`isolated`, `timeoutMs` default 15 min and at most 6 h, `overlap: "skip"`), `ExperimentalVkScheduleContext` (`signal`), `ExperimentalVkScheduleHandler`. One run per schedule, at most 8 isolated runs at once, a timeout is recorded as `error` with `timeout after <N>ms`
- `VkSessionPolicy` — `bbPlugins`, `skills`, `mcpServers`, `nativePlugins` (each a `VkPolicyFilter`) plus user/project instruction and Claude.ai sync switches
- `bb.agents.experimental_vkRequiredSessionPolicy()` — static source capability matrix for required spawn snapshots; feature-test it and verify the requested provider groups before spawning selected or empty policy
- `VkRequiredSessionPolicy` — `{ version: 1, policy }`; pass through `threads.spawn` as `experimental_vkRequiredSessionPolicy`, never plugin metadata; empty allow lists retain only mandatory core resources. Parent ceilings carry across child/fork/lifecycle-owner relationships
- `VkPolicyFilter` — `{ mode: "allow" | "deny", names }`; a trailing `*` matches a prefix
- `bb.sdk.threads.experimental_vkSpawnKeyed` (the `threads.spawn` arguments plus `key`) — optional, VK builds only: idempotent spawn; `key` is 1 to 200 characters, unique within the plugin; returns `{ thread, reused }`, and a repeat with a live thread holding the key creates no second thread. `experimental_vkFindByKey(key)` returns the thread or `null`; `experimental_vkFindByPluginMetadata({ match, projectId?, includeArchived?, limit? })` searches only this plugin's own metadata row (limit at most 100, newest first). The key lives in the reserved metadata field `__vk.key`; a deleted thread frees it. Feature-test with `typeof bb.sdk.threads.experimental_vkSpawnKeyed === "function"`. Types: `ExperimentalVkThreadKeys`, `ExperimentalVkSpawnKeyedArgs`, `ExperimentalVkSpawnKeyedResult`, `ExperimentalVkFindByPluginMetadataArgs`, `ExperimentalVkThreadMetadataMatch`
- `bb.agents.experimental_vkContextContributions()` — optional, VK builds only: what each running plugin adds to agent sessions
- `VkContextContribution` — `{ pluginId, instructions, configure, tools, skills }`
