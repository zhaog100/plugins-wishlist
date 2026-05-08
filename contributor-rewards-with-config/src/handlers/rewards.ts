import { PluginSettings, EventRewardType, RewardEntryType, ContributorClass, TargetRole } from "../types/plugin-input";

/**
 * Determine the contributor class of a user relative to an issue/pull.
 * @param userLogin - The GitHub login of the user to classify
 * @param issueAuthor - The GitHub login of the issue author
 * @param assignees - Array of users assigned to the issue/PR
 * @param isOrgMember - Whether the user is an organization member
 * @returns The contributor class: ISSUER, ASSIGNEE, COLLABORATOR, or CONTRIBUTOR
 */
export function getContributorClass(
  userLogin: string,
  issueAuthor: string | undefined,
  assignees: Array<{ login: string }> | undefined,
  isOrgMember: boolean
): ContributorClass {
  if (userLogin === issueAuthor) {
    return ContributorClass.ISSUER;
  }
  if (assignees?.some((a) => a.login === userLogin)) {
    return ContributorClass.ASSIGNEE;
  }
  if (isOrgMember) {
    return ContributorClass.COLLABORATOR;
  }
  return ContributorClass.CONTRIBUTOR;
}

/**
 * Check if a user matches a target role based on their contributor class and activity.
 * @param targetRole - The target role to match against
 * @param contributorClass - The user's contributor class
 * @param userLogin - The GitHub login of the user
 * @param reviewers - Optional array of PR reviewers
 * @param commenters - Optional array of issue/PR commenters
 * @param committers - Optional array of PR committers
 * @returns True if the user matches the target role, false otherwise
 */
export function matchesTarget(
  targetRole: TargetRole,
  contributorClass: ContributorClass,
  userLogin: string,
  reviewers?: string[],
  commenters?: string[],
  committers?: string[]
): boolean {
  switch (targetRole) {
    case TargetRole.ISSUER:
      return contributorClass === ContributorClass.ISSUER;
    case TargetRole.ASSIGNEE:
      return contributorClass === ContributorClass.ASSIGNEE;
    case TargetRole.COLLABORATOR:
      return contributorClass === ContributorClass.COLLABORATOR;
    case TargetRole.CONTRIBUTOR:
      return contributorClass === ContributorClass.CONTRIBUTOR;
    case TargetRole.REVIEWERS:
      return reviewers?.includes(userLogin) ?? false;
    case TargetRole.COMMENTERS:
      return commenters?.includes(userLogin) ?? false;
    case TargetRole.COMMITTERS:
      return committers?.includes(userLogin) ?? false;
  }
}

/**
 * Parse an event name into category and action components.
 * @param eventName - The event name string (e.g., "pull_request.opened")
 * @returns An object with category and action parts
 */
export function parseEventName(eventName: string): { category: string; action: string } {
  const dotIndex = eventName.indexOf(".");
  if (dotIndex === -1) {
    return { category: eventName, action: "" };
  }
  return {
    category: eventName.substring(0, dotIndex),
    action: eventName.substring(dotIndex + 1),
  };
}

/**
 * Get the reward configuration for a specific event type.
 * @param settings - The plugin settings containing reward configurations
 * @param eventName - The full event name (e.g., "pull_request.opened")
 * @returns The reward configuration for the event, or undefined if not found
 */
export function getEventRewardConfig(settings: PluginSettings, eventName: string): EventRewardType | undefined {
  const { category, action } = parseEventName(eventName);
  const categoryConfig = settings[category as keyof PluginSettings];
  if (!categoryConfig || typeof categoryConfig !== "object") {
    return undefined;
  }
  return (categoryConfig as Record<string, EventRewardType | undefined>)[action];
}

/**
 * Calculate the reward value for a contributor based on event configuration.
 * @param rewardConfig - The reward configuration for the event
 * @param contextType - Whether this is a "pull" or "issue" context
 * @param contributorClass - The contributor's class
 * @param userLogin - The GitHub login of the user
 * @param options - Optional arrays of reviewers, commenters, and committers
 * @returns The reward value, or 0 if no reward applies
 */
export function calculateReward(
  rewardConfig: EventRewardType | undefined,
  contextType: "pull" | "issue",
  contributorClass: ContributorClass,
  userLogin: string,
  options?: {
    reviewers?: string[];
    commenters?: string[];
    committers?: string[];
  }
): number {
  if (!rewardConfig) {
    return 0;
  }

  const entry: RewardEntryType | undefined = rewardConfig[contextType] as RewardEntryType | undefined;
  if (!entry) {
    return 0;
  }

  const isTarget = entry.targets.some((target) =>
    matchesTarget(target, contributorClass, userLogin, options?.reviewers, options?.commenters, options?.committers)
  );

  if (!isTarget) {
    return 0;
  }

  return entry.value;
}

/**
 * Apply label-based overrides to a base reward value.
 * @param baseReward - The base reward value before label overrides
 * @param labels - Array of labels on the issue/PR
 * @param labelOverrideConfig - Configuration mapping label names to reward overrides
 * @returns The reward value after applying all label overrides
 */
export function applyLabelOverrides(
  baseReward: number,
  labels: Array<{ name: string }>,
  labelOverrideConfig: Record<string, { value: number }> | undefined
): number {
  if (!labelOverrideConfig) {
    return baseReward;
  }

  let reward = baseReward;
  for (const label of labels) {
    const override = labelOverrideConfig[label.name];
    if (override !== undefined) {
      reward += override.value;
    }
  }
  return reward;
}

/**
 * Represents the reward result for a single contributor.
 */
export interface ContributorReward {
  login: string;
  class: ContributorClass;
  reward: number;
}

/**
 * Calculate rewards for all contributors involved in an event.
 * @param settings - The plugin settings with reward configurations
 * @param eventName - The full event name (e.g., "pull_request.opened")
 * @param contributors - Array of contributors to evaluate
 * @param contextType - Whether this is a "pull" or "issue" context
 * @param labels - Array of labels on the issue/PR
 * @param options - Optional arrays of reviewers, commenters, and committers
 * @returns Array of ContributorReward objects for contributors with non-zero rewards
 */
export function calculateRewards(
  settings: PluginSettings,
  eventName: string,
  contributors: Array<{
    login: string;
    issueAuthor?: string;
    assignees?: Array<{ login: string }>;
    isOrgMember: boolean;
  }>,
  contextType: "pull" | "issue",
  labels: Array<{ name: string }>,
  options?: {
    reviewers?: string[];
    commenters?: string[];
    committers?: string[];
  }
): ContributorReward[] {
  const rewardConfig = getEventRewardConfig(settings, eventName);
  const labelOverrideConfig = settings.labelOverrides;

  return contributors
    .map((contributor) => {
      const contributorClass = getContributorClass(contributor.login, contributor.issueAuthor, contributor.assignees, contributor.isOrgMember);

      const baseReward = calculateReward(rewardConfig, contextType, contributorClass, contributor.login, options);
      const finalReward = applyLabelOverrides(baseReward, labels, labelOverrideConfig);

      return {
        login: contributor.login,
        class: contributorClass,
        reward: finalReward,
      };
    })
    .filter((r) => r.reward !== 0);
}

/**
 * Aggregate rewards across multiple events for each contributor.
 * @param rewards - Array of ContributorReward objects from multiple events
 * @returns Map of login -> { total: aggregated reward sum, class: contributor class }
 */
export function aggregateRewards(rewards: ContributorReward[]): Map<string, { total: number; class: ContributorClass }> {
  const aggregated = new Map<string, { total: number; class: ContributorClass }>();

  for (const reward of rewards) {
    const existing = aggregated.get(reward.login);
    if (existing) {
      existing.total += reward.reward;
    } else {
      aggregated.set(reward.login, { total: reward.reward, class: reward.class });
    }
  }

  return aggregated;
}
