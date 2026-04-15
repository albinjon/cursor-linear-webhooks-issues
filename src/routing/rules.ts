import type { RoutingRule } from "./types";

/**
 * Cursor webhook URLs are **per-automation**. Keys below match your Cursor automation names.
 *
 * Status names must match your Linear workflow state **titles** exactly (case-sensitive).
 *
 * Optional **`matchingProjects`**: string array; when non-empty, the rule only runs if the
 * normalized event’s **project** identifiers (from the webhook and/or Linear GraphQL enrichment)
 * include one of these strings (exact match). If no identifiers are available, the filter is
 * skipped (fail-open). Omit or leave empty to apply the rule to all projects.
 *
 * Set secret **`LINEAR_API_KEY`** so the Worker can resolve `Issue.project` when webhooks do not
 * include project fields (see README).
 */

/** **Review Gate** — no Linear route in this worker; set in the dashboard only if you use this URL outside this router. */
export const CURSOR_WEBHOOK_REVIEW_GATE_ENV_KEY =
	"CURSOR_WEBHOOK_REVIEW_GATE" as const;


const defaultProjects = ["v1", "FrontEnd", "Backend (Förbättringar)"];

export const ROUTING_RULES: RoutingRule[] = [
	{
		id: "refine-issues",
		when: { type: "statusChangedTo", statusName: "Backlog" },
		matchingProjects: defaultProjects,
		targetEnvKey: "CURSOR_WEBHOOK_REFINE_ISSUES",
		authTokenEnvKey: "CURSOR_WEBHOOK_REFINE_ISSUES_AUTH_TOKEN",
	},
	{
		id: "implement-pr",
		when: { type: "statusChangedTo", statusName: "Todo" },
		matchingProjects: defaultProjects,
		targetEnvKey: "CURSOR_WEBHOOK_IMPLEMENT_PR",
		authTokenEnvKey: "CURSOR_WEBHOOK_IMPLEMENT_PR_AUTH_TOKEN",
	},
	{
		id: "review-fixer",
		when: { type: "statusChangedTo", statusName: "Review fixes" },
		matchingProjects: defaultProjects,
		targetEnvKey: "CURSOR_WEBHOOK_REVIEW_FIXER",
		authTokenEnvKey: "CURSOR_WEBHOOK_REVIEW_FIXER_AUTH_TOKEN",
	},
	{
		id: "issue-created",
		when: { type: "issueCreated" },
		matchingProjects: defaultProjects,
		targetEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_ISSUE_CREATED",
		authTokenEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_ISSUE_CREATED_AUTH_TOKEN",
	},
	{
		id: "reaction-robot-face",
		when: { type: "reactionWithEmoji", emoji: "🤖" },
		targetEnvKey: "CURSOR_WEBHOOK_BOT_ROUTING",
		authTokenEnvKey: "CURSOR_WEBHOOK_BOT_ROUTING_AUTH_TOKEN",
	},
	{
		id: "status-changed-to-done",
		when: { type: "statusChangedTo", statusName: "Done" },
		targetEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_DONE",
		authTokenEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_DONE_AUTH_TOKEN",
	},
	{
		id: "label-removed-blocked",
		when: { type: "labelRemoved", labelName: "Blocked" },
		targetEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_LABEL_BLOCKED_REMOVED",
		authTokenEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_LABEL_BLOCKED_REMOVED_AUTH_TOKEN",
	},
	{
		id: "comment-added",
		when: { type: "commentAdded" },
		targetEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_COMMENT",
		authTokenEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_COMMENT_AUTH_TOKEN",
	},
	{
		id: "reaction-thumbs-up",
		when: { type: "reactionWithEmoji", emoji: "👍" },
		targetEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_REACTION_THUMBSUP",
		authTokenEnvKey: "CURSOR_WEBHOOK_PLACEHOLDER_REACTION_THUMBSUP_AUTH_TOKEN",
	},
];
