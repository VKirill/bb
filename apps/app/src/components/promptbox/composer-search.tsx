import {
  createContext,
  memo,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type {
  ExperimentalComposerCommandSearch,
  ExperimentalComposerCommandTrigger,
  ExperimentalComposerMentionSearch,
  ExperimentalComposerSearchQuery,
  PluginMentionTrigger,
} from "@get-bb/plugin-sdk";
import {
  composerMentionGroupsFromOrdered,
  groupCommandSuggestions,
  orderCommandSuggestions,
} from "@bb/client-core";
// VK EXPERIMENTAL: `/` offers only the skills the place's session policy loads.
import { vkPlaceOf } from "@/components/plugin/composer-slot-hooks";
import { usePluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { useVkPlaceView } from "@/hooks/queries/vk-excluded-plugins-queries";
import { vkVisibleCommandSuggestions } from "@/hooks/vk-command-skills";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import type { TypeaheadConfig } from "./ComposerBox";

interface ComposerSearches {
  mention: ExperimentalComposerMentionSearch;
  command: ExperimentalComposerCommandSearch;
}

const ComposerSearchContext = createContext<ComposerSearches | null>(null);

function sameQuery<Trigger extends string>(
  current: ExperimentalComposerSearchQuery<Trigger> | null,
  next: ExperimentalComposerSearchQuery<Trigger> | null,
): boolean {
  return (
    current === next ||
    (current !== null &&
      next !== null &&
      current.text === next.text &&
      current.trigger === next.trigger)
  );
}

export const ComposerSearchProvider = memo(function ComposerSearchProvider({
  typeahead,
  children,
}: {
  typeahead: TypeaheadConfig;
  children: ReactNode;
}) {
  const [mentionQuery, setMentionQuery] =
    useState<ExperimentalComposerSearchQuery<PluginMentionTrigger> | null>(
      null,
    );
  const [commandQuery, setCommandQuery] =
    useState<ExperimentalComposerSearchQuery<ExperimentalComposerCommandTrigger> | null>(
      null,
    );
  const mention = usePromptMentions(typeahead.mention.source, mentionQuery);
  const command = useCommandSuggestions({
    ...typeahead.command.source,
    activeTrigger: commandQuery?.trigger ?? null,
    query: commandQuery?.text ?? null,
  });
  const vkView = useVkPlaceView(vkPlaceOf(usePluginComposerHost())); // VK EXPERIMENTAL
  const searches: ComposerSearches = {
    mention: {
      status:
        mentionQuery === null
          ? "idle"
          : mention.isLoading
            ? "loading"
            : mention.isError
              ? "error"
              : "ready",
      refreshing: mentionQuery !== null && mention.isRefreshing,
      groups:
        mentionQuery === null
          ? []
          : composerMentionGroupsFromOrdered(mention.results),
      search: (query) =>
        setMentionQuery((current) =>
          sameQuery(current, query) ? current : query,
        ),
    },
    command: {
      status:
        commandQuery === null
          ? "idle"
          : command.isLoading
            ? "loading"
            : command.isError
              ? "error"
              : "ready",
      refreshing: commandQuery !== null && command.isRefreshing,
      groups:
        commandQuery === null
          ? []
          : groupCommandSuggestions(
              orderCommandSuggestions(
                vkVisibleCommandSuggestions(command.suggestions, vkView), // VK EXPERIMENTAL
                commandQuery.text,
              ),
            ),
      search: (query) =>
        setCommandQuery((current) =>
          sameQuery(current, query) ? current : query,
        ),
    },
  };
  return (
    <ComposerSearchContext.Provider value={searches}>
      {children}
    </ComposerSearchContext.Provider>
  );
});

function useComposerSearches(hookName: string): ComposerSearches {
  const searches = useContext(ComposerSearchContext);
  if (searches === null) {
    throw new Error(
      `${hookName}() is only available inside an experimental_composer component.`,
    );
  }
  return searches;
}

export function useComposerMentionSearch(): ExperimentalComposerMentionSearch {
  return useComposerSearches("experimental_useComposerMentionSearch").mention;
}

export function useComposerCommandSearch(): ExperimentalComposerCommandSearch {
  return useComposerSearches("experimental_useComposerCommandSearch").command;
}
