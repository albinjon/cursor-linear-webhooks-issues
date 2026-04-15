/** Keep under Linear's 5s webhook response budget (with margin). */
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_RETRIES = 1;

export interface DispatchPayload {
	source: "linear-router";
	ruleId: string;
	linearDelivery: string | null;
	linearEvent: string | null;
	normalizedEvents: unknown[];
	linearPayload: unknown;
}

export interface DispatchResult {
	targetUrl: string;
	ruleId: string;
	ok: boolean;
	status?: number;
	error?: string;
}

function buildBody(p: DispatchPayload): string {
	return JSON.stringify(p);
}

async function postOnce(
	url: string,
	body: string,
	authToken: string | undefined,
	signal: AbortSignal,
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json; charset=utf-8",
	};
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}
	return fetch(url, {
		method: "POST",
		headers,
		body,
		signal,
	});
}

/**
 * POSTs to each Cursor webhook with bounded timeout and one retry on failure.
 */
export async function dispatchToCursorWebhooks(
	routes: Array<{
		ruleId: string;
		targetUrl: string;
		authToken?: string;
		body: DispatchPayload;
	}>,
): Promise<DispatchResult[]> {
	const results: DispatchResult[] = [];
	for (const r of routes) {
		const body = buildBody(r.body);
		let lastError: string | undefined;
		let ok = false;
		let status: number | undefined;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const controller = new AbortController();
			const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
			try {
				const res = await postOnce(
					r.targetUrl,
					body,
					r.authToken,
					controller.signal,
				);
				status = res.status;
				if (res.ok) {
					ok = true;
					break;
				}
				lastError = `HTTP ${res.status}`;
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
			} finally {
				clearTimeout(t);
			}
		}
		results.push({
			targetUrl: r.targetUrl,
			ruleId: r.ruleId,
			ok,
			status,
			error: ok ? undefined : lastError,
		});
	}
	return results;
}
