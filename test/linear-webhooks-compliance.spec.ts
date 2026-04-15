/**
 * Contract checks against https://linear.app/developers/webhooks
 * (Securing Webhooks + Webhook Payload).
 */
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
	verifyLinearSignature,
	verifyWebhookTimestampFreshness,
} from "../src/linear/verify";

function linearSignatureHex(secret: string, rawBody: string): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("Linear docs: Securing Webhooks", () => {
	it("accepts HMAC-SHA256 hex of raw body (same construction as Linear)", () => {
		const secret = "whsec_test";
		const rawBody = JSON.stringify({
			action: "create",
			type: "Comment",
			webhookTimestamp: Date.now(),
		});
		const sig = linearSignatureHex(secret, rawBody);
		expect(verifyLinearSignature(rawBody, sig, secret)).toBe(true);
	});

	it("rejects wrong secret", () => {
		const rawBody = '{"type":"Issue"}';
		const sig = linearSignatureHex("a", rawBody);
		expect(verifyLinearSignature(rawBody, sig, "b")).toBe(false);
	});

	it("rejects tampered body", () => {
		const secret = "whsec_test";
		const rawBody = '{"type":"Issue"}';
		const sig = linearSignatureHex(secret, rawBody);
		expect(verifyLinearSignature(rawBody + " ", sig, secret)).toBe(false);
	});

	it("rejects invalid hex in header", () => {
		expect(verifyLinearSignature("{}", "not-hex", "secret")).toBe(false);
	});
});

describe("Linear docs: webhookTimestamp replay window", () => {
	it("recommends within ~60s; default window accepts fresh timestamps", () => {
		const now = 1_700_000_000_000;
		const payload = { webhookTimestamp: now };
		expect(
			verifyWebhookTimestampFreshness(payload, now, 60_000, false),
		).toBe(true);
	});

	it("rejects timestamps older than window", () => {
		const now = 1_700_000_000_000;
		const payload = { webhookTimestamp: now - 120_000 };
		expect(
			verifyWebhookTimestampFreshness(payload, now, 60_000, false),
		).toBe(false);
	});

	it("rejects missing timestamp when strict (our handler path)", () => {
		expect(
			verifyWebhookTimestampFreshness({}, Date.now(), 60_000, false),
		).toBe(false);
	});
});
