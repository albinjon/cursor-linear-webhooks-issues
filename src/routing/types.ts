import type { NormalizedEvent } from "../linear/normalize";

export type RuleCondition =
	| { type: "statusChangedTo"; statusName: string }
	| { type: "issueCreated" }
	| { type: "labelRemoved"; labelName: string }
	| { type: "commentAdded" }
	| {
			type: "reactionWithEmoji";
			emoji: string;
			/** Defaults to `"create"` (new reaction). Set to `"remove"` to match reaction removed. */
			reactionAction?: "create" | "remove";
	  };

export interface RoutingRule {
	id: string;
	when: RuleCondition;
	/**
	 * When set (non-empty), the rule only matches if the event’s project matches one of
	 * these strings exactly (against project id, name, slug, or key).
	 * Webhooks often omit project; the Worker may fill `projectIdents` via Linear GraphQL
	 * (`LINEAR_API_KEY`). If identifiers are still empty, the project filter is skipped (fail-open).
	 * Omitted or empty = no project filter.
	 */
	matchingProjects?: string[];
	/** Env var name whose value is the target HTTPS URL for this Cursor webhook. */
	targetEnvKey: string;
	/** Optional env var name whose value is the auth token used for this target webhook. */
	authTokenEnvKey?: string;
}

export interface MatchedRoute {
	rule: RoutingRule;
	targetUrl: string;
	authToken?: string;
	events: NormalizedEvent[];
}
