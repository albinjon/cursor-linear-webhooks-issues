import { dispatchToCursorWebhooks, type DispatchPayload } from "../cursor/dispatch";
import { enrichNormalizedEventsWithLinearProjects } from "./enrichProjectFromApi";
import { normalizeLinearPayload } from "./normalize";
import { ROUTING_RULES } from "../routing/rules";
import { matchRoutes } from "../routing/match";
import type { LinearWebhookPayloadBase } from "./verify";
import { verifyLinearSignature, verifyWebhookTimestampFreshness } from "./verify";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

export async function handleLinearWebhookPost(
	request: Request,
	env: Env,
): Promise<Response> {
	const secret = env.LINEAR_WEBHOOK_SECRET;
	if (!secret || !secret.trim()) {
		return jsonResponse({ error: "LINEAR_WEBHOOK_SECRET is not configured" }, 503);
	}

	const rawBody = await request.text();
	const sig = request.headers.get("linear-signature");
	if (!verifyLinearSignature(rawBody, sig, secret)) {
		return jsonResponse({ error: "invalid signature" }, 401);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return jsonResponse({ error: "invalid json" }, 400);
	}

	const windowMs = Number.parseInt(
		env.LINEAR_REPLAY_WINDOW_MS ?? "60000",
		10,
	);
	const replayWindow = Number.isFinite(windowMs) ? windowMs : 60_000;
	if (
		!verifyWebhookTimestampFreshness(
			parsed as LinearWebhookPayloadBase,
			Date.now(),
			replayWindow,
			false,
		)
	) {
		return jsonResponse({ error: "webhook timestamp outside allowed window" }, 401);
	}

	const linearDelivery = request.headers.get("linear-delivery");
	const linearEvent = request.headers.get("linear-event");

	console.log(
		JSON.stringify({
			msg: "linear_webhook_payload",
			linearDelivery,
			linearEvent,
			linearPayload: parsed,
		}),
	);

	let events = normalizeLinearPayload(parsed);
	events = await enrichNormalizedEventsWithLinearProjects(
		events,
		ROUTING_RULES,
		env,
	);
	if (events.length === 0) {
		const top =
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		console.warn(
			JSON.stringify({
				msg: "linear_webhook_normalization_empty",
				linearDelivery,
				linearEvent,
				payloadType: top?.type,
				payloadAction: top?.action,
				linearPayload: parsed,
			}),
		);
	}

	const matches = matchRoutes(
		events,
		ROUTING_RULES,
		env as unknown as Record<string, string | undefined>,
	);

	const routes = matches.map((m) => {
		const body: DispatchPayload = {
			source: "linear-router",
			ruleId: m.rule.id,
			linearDelivery,
			linearEvent,
			normalizedEvents: m.events,
			linearPayload: parsed,
		};
		return {
			ruleId: m.rule.id,
			targetUrl: m.targetUrl,
			authToken: m.authToken,
			body,
		};
	});

	const dispatchResults =
		routes.length > 0 ? await dispatchToCursorWebhooks(routes) : [];

	console.log(
		JSON.stringify({
			msg: "linear_webhook_processed",
			linearDelivery,
			linearEvent,
			normalizedCount: events.length,
			matchedRules: matches.map((m) => m.rule.id),
			dispatchResults,
		}),
	);

	return jsonResponse({
		ok: true,
		normalizedEvents: events.length,
		matchedRules: matches.map((m) => m.rule.id),
		dispatchResults,
	});
}
