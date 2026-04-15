import { createHmac } from "node:crypto";

/** Must match `env.test.vars.LINEAR_WEBHOOK_SECRET` in wrangler.jsonc */
export const TEST_LINEAR_SECRET = "test-secret";

export function signLinearRawBody(rawBody: string): string {
	return createHmac("sha256", TEST_LINEAR_SECRET).update(rawBody).digest("hex");
}

export function buildLinearWebhookRequest(
	url: string,
	payload: Record<string, unknown>,
	headers?: Record<string, string>,
): Request {
	const raw = JSON.stringify(payload);
	const sig = signLinearRawBody(raw);
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Linear-Signature": sig,
			"Linear-Delivery": "00000000-0000-4000-8000-000000000001",
			"Linear-Event": headers?.["Linear-Event"] ?? "Issue",
			...headers,
		},
		body: raw,
	});
}
