import type { NormalizedEvent } from "../linear/normalize";
import type { MatchedRoute, RoutingRule } from "./types";

function eventMatchesProjectFilter(
	ev: NormalizedEvent,
	rule: RoutingRule,
): boolean {
	const want = rule.matchingProjects
		?.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (!want?.length) return true;
	const got = ev.projectIdents;
	// Fail-open: webhooks often omit project; GraphQL enrichment may also return nothing.
	if (!got?.length) return true;
	return want.some((w) => got.includes(w));
}

function eventMatchesCondition(
	ev: NormalizedEvent,
	rule: RoutingRule,
): boolean {
	const w = rule.when;
	switch (w.type) {
		case "statusChangedTo":
			return (
				ev.kind === "statusChanged" &&
				ev.newStatusName === w.statusName
			);
		case "issueCreated":
			return ev.kind === "issueCreated";
		case "labelRemoved":
			return (
				ev.kind === "labelRemoved" &&
				ev.removedLabelNames.includes(w.labelName)
			);
		case "commentAdded":
			return ev.kind === "commentAdded";
		case "reactionWithEmoji": {
			if (ev.kind !== "reaction") return false;
			if (ev.emoji !== w.emoji) return false;
			const wantAction = w.reactionAction ?? "create";
			return ev.reactionAction === wantAction;
		}
		default:
			return false;
	}
}

/**
 * Evaluates rules against normalized events. Each rule fires at most once if any event matches.
 * Resolves target URL from env[targetEnvKey]; skips rules with missing/empty URLs.
 */
export function matchRoutes(
	events: NormalizedEvent[],
	rules: RoutingRule[],
	env: Record<string, string | undefined>,
): MatchedRoute[] {
	const matched: MatchedRoute[] = [];
	for (const rule of rules) {
		const matching = events.filter(
			(ev) =>
				eventMatchesProjectFilter(ev, rule) &&
				eventMatchesCondition(ev, rule),
		);
		if (!matching.length) continue;
		const targetUrl = env[rule.targetEnvKey]?.trim();
		if (!targetUrl) continue;
		const authToken = rule.authTokenEnvKey
			? env[rule.authTokenEnvKey]?.trim()
			: undefined;
		if (rule.authTokenEnvKey && !authToken) {
			console.warn(
				JSON.stringify({
					msg: "cursor_route_auth_token_missing",
					ruleId: rule.id,
					authTokenEnvKey: rule.authTokenEnvKey,
				}),
			);
		}
		matched.push({ rule, targetUrl, authToken, events: matching });
	}
	return matched;
}
