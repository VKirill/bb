// VK EXPERIMENTAL: mention-recency.
// Sidebar navigation lists threads project by project, so a plain slice to the
// mention candidate limit drops every thread of later projects. Order by recent
// activity first so the limit keeps the freshest threads instead.

interface VkRecencyThread {
  readonly updatedAt: number;
}

export function vkSortMentionCandidatesByRecency<T extends VkRecencyThread>(
  threads: readonly T[],
): T[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
}
