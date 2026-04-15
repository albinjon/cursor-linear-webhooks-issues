import { dispatchToCursorWebhooks, type DispatchResult } from "../cursor/dispatch";
import { ROUTING_RULES } from "../routing/rules";
import { matchRoutes } from "../routing/match";
import type { MatchedRoute } from "../routing/types";
import { enrichNormalizedEventsWithLinearProjects } from "./enrichProjectFromApi";
import { normalizeLinearPayload, type NormalizedEvent } from "./normalize";
import type { LinearWebhookPayloadParsed } from "./webhookEnvelope";

export interface LinearWebhookRequestHeaders {
	linearDelivery: string | null;
	linearEvent: string | null;
}

/**
 * Normalizes the payload, enriches project identifiers, matches routing rules, and dispatches to Cursor webhooks.
 */
export async function processLinearWebhook(
	payload: LinearWebhookPayloadParsed,
	env: Env,
	headers: LinearWebhookRequestHeaders,
): Promise<{
	events: NormalizedEvent[];
	matches: MatchedRoute[];
	dispatchResults: DispatchResult[];
}> {
	let events = normalizeLinearPayload(payload);
	events = await enrichNormalizedEventsWithLinearProjects(
		events,
		ROUTING_RULES,
		env,
	);

	const matches = matchRoutes(
		events,
		ROUTING_RULES,
		env as unknown as Record<string, string | undefined>,
	);

	const { linearDelivery, linearEvent } = headers;

	const routes = matches.map((m) => ({
		ruleId: m.rule.id,
		targetUrl: m.targetUrl,
		authToken: m.authToken,
		body: {
			source: "linear-router" as const,
			ruleId: m.rule.id,
			linearDelivery,
			linearEvent,
			normalizedEvents: m.events,
			linearPayload: payload,
		},
	}));

	const dispatchResults =
		routes.length > 0 ? await dispatchToCursorWebhooks(routes) : [];

	return { events, matches, dispatchResults };
}
