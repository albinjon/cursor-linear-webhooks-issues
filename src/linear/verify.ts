import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearWebhookPayloadParsed } from "./webhookEnvelope";

/**
 * Verifies `Linear-Signature` (hex HMAC-SHA256 of raw body) per
 * https://linear.app/developers/webhooks#securing-webhooks
 */
export function verifyLinearSignature(
	rawBody: string | Uint8Array,
	headerSignature: string | null,
	secret: string,
): boolean {
	if (typeof headerSignature !== "string" || !headerSignature.length) {
		return false;
	}
	let headerBuf: Buffer;
	try {
		headerBuf = Buffer.from(headerSignature, "hex");
	} catch {
		return false;
	}
	const computed = createHmac("sha256", secret)
		.update(
			typeof rawBody === "string" ? rawBody : Buffer.from(rawBody),
		)
		.digest();
	if (headerBuf.length !== computed.length) {
		return false;
	}
	return timingSafeEqual(headerBuf, computed);
}

/**
 * Rejects replays when |now - webhookTimestamp| > windowMs.
 * Returns true if valid or if timestamp missing and allowMissing is true.
 */
export function verifyWebhookTimestampFreshness(
	payload: LinearWebhookPayloadParsed,
	nowMs: number,
	windowMs: number,
	allowMissing = false,
): boolean {
	const ts = payload.webhookTimestamp;
	if (ts === undefined) {
		return allowMissing;
	}
	return Math.abs(nowMs - ts) <= windowMs;
}
