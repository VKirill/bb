import type {
  JsonObject,
  PromptInput,
  ThreadOriginKind,
  ThreadVisibility,
} from "@bb/domain";
import type {
  CreateThreadEnvironmentArgs,
  CreateThreadRequest,
  EnvironmentArgs,
  ProviderEnvironmentArgs,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
} from "@bb/server-contract";

export interface ThreadCreateServiceRequestInput {
  environment: CreateThreadEnvironmentArgs;
  executionInputSources?: CreateThreadRequest["executionInputSources"];
  /**
   * Epoch ms the first message should dispatch at. Present ⇒ the thread is
   * created `pending` with no turn and the first message is queued as a row
   * waiting on the clock.
   */
  sendAt?: CreateThreadRequest["sendAt"];
  input: PromptInput[];
  pluginMetadata?: CreateThreadRequest["pluginMetadata"];
  sectionId?: CreateThreadRequest["sectionId"];
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  originPluginId?: CreateThreadRequest["originPluginId"];
  originKind?: ThreadOriginKind | null;
  parentThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  sourceSeqEnd?: CreateThreadRequest["sourceSeqEnd"];
  sourceThreadId?: string;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  title?: string;
  visibility?: ThreadVisibility;
  isolatedSkillDelivery?: CreateThreadRequest["isolatedSkillDelivery"];
  skillIds?: CreateThreadRequest["skillIds"];
  isolatedSkillHostId?: string;
  dynamicToolNames?: CreateThreadRequest["dynamicToolNames"];
  instructionPluginIds?: CreateThreadRequest["instructionPluginIds"];
  includeDataDirInstructions?: CreateThreadRequest["includeDataDirInstructions"];
  includeWorkspaceInstructions?: CreateThreadRequest["includeWorkspaceInstructions"];
  allowBridgeToolProxy?: CreateThreadRequest["allowBridgeToolProxy"];
  experimental_callerLaunchId?: CreateThreadRequest["experimental_callerLaunchId"];
  experimental_callerAttemptId?: CreateThreadRequest["experimental_callerAttemptId"];
  experimental_callerJobId?: CreateThreadRequest["experimental_callerJobId"];
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "environment" | "pluginMetadata" | "providerId"
> {
  environment: EnvironmentArgs | ProviderEnvironmentArgs;
  pluginMetadata: { pluginId: string; metadata: JsonObject } | null;
  providerId: string;
  titleFallback: string | null;
  visibility: ThreadVisibility;
}
