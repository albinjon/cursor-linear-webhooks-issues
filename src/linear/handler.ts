import { processLinearWebhook } from "./pipeline";
import { linearWebhookPayloadSchema } from "./webhookEnvelope";
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

	const envelope = linearWebhookPayloadSchema.safeParse(parsed);
	if (!envelope.success) {
		return jsonResponse({ error: "invalid json body" }, 400);
	}
	const payload = envelope.data;

	const windowMs = Number.parseInt(
		env.LINEAR_REPLAY_WINDOW_MS ?? "60000",
		10,
	);
	const replayWindow = Number.isFinite(windowMs) ? windowMs : 60_000;
	if (
		!verifyWebhookTimestampFreshness(
			payload,
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
			linearPayload: payload,
		}),
	);

	const { events, matches, dispatchResults } = await processLinearWebhook(
		payload,
		env,
		{ linearDelivery, linearEvent },
	);

	if (events.length === 0) {
		const rec = payload as Record<string, unknown>;
		console.warn(
			JSON.stringify({
				msg: "linear_webhook_normalization_empty",
				linearDelivery,
				linearEvent,
				payloadType: rec.type,
				payloadAction: rec.action,
				linearPayload: payload,
			}),
		);
	}

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
