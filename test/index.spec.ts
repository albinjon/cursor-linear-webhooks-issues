import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import {
	buildLinearWebhookRequest,
	signLinearRawBody,
} from "./helpers/linearWebhook";
import { normalizeLinearPayload } from "../src/linear/normalize";
import { matchRoutes } from "../src/routing/match";
import type { RoutingRule } from "../src/routing/types";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function urlOfFetchArg(u: RequestInfo | URL): string {
	if (typeof u === "string") return u;
	if (u instanceof URL) return u.href;
	return (u as Request).url;
}

/** First outbound call to a Cursor test webhook (skips Linear GraphQL enrichment calls). */
function firstCursorFetchCall(
	calls: unknown[][],
): [RequestInfo | URL, RequestInit | undefined] | undefined {
	const hit = calls.find(([input]) =>
		urlOfFetchArg(input as RequestInfo | URL).includes("cursor.test"),
	);
	return hit as [RequestInfo | URL, RequestInit | undefined] | undefined;
}

describe("Linear webhook router", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = urlOfFetchArg(input);
				if (url.includes("api.linear.app/graphql")) {
					let issueId = "";
					try {
						const body =
							init?.body && typeof init.body === "string"
								? (JSON.parse(init.body) as {
										variables?: { issueId?: string };
									})
								: {};
						issueId = body.variables?.issueId ?? "";
					} catch {
						issueId = "";
					}
					const project =
						issueId.includes("wrong-proj-issue") || issueId === "other-issue-uuid"
							? { id: "other-proj", name: "Beta", slugId: "beta" }
							: { id: "v1", name: "Test project", slugId: "v1" };
					return new Response(
						JSON.stringify({
							data: {
								issue: {
									id: issueId || "issue-uuid",
									project,
								},
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response("ok", { status: 200 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns 404 for unknown paths", async () => {
		const request = new IncomingRequest("https://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it("returns 405 for GET on /webhooks/linear", async () => {
		const request = new IncomingRequest("https://example.com/webhooks/linear");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it("returns 401 when Linear-Signature is invalid", async () => {
		const raw = JSON.stringify({
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: { id: "i1", state: { name: "Done" } },
			updatedFrom: { state: { name: "Todo" } },
		});
		const request = new IncomingRequest("https://example.com/webhooks/linear", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Linear-Signature": "deadbeef" },
			body: raw,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("dispatches to status webhook when status changes to Done", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: {
				state: { name: "In Progress" },
				labelIds: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			matchedRules: string[];
			dispatchResults: { ok: boolean; ruleId: string }[];
		};
		expect(body.matchedRules).toContain("status-changed-to-done");
		expect(body.dispatchResults).toHaveLength(1);
		expect(body.dispatchResults[0]?.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalled();
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		expect(cursorCall?.[0]).toBe("https://cursor.test/hooks/placeholder-done");
		const init = cursorCall?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token-done");
		const posted = JSON.parse(init.body as string) as {
			ruleId: string;
			normalizedEvents: { kind: string }[];
		};
		expect(posted.ruleId).toBe("status-changed-to-done");
		expect(posted.normalizedEvents.some((e) => e.kind === "statusChanged")).toBe(
			true,
		);
	});

	it("dispatches to backlog webhook when status changes to Backlog", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Backlog" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: {
				state: { name: "Todo" },
				labelIds: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("refine-issues");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.linear.app/graphql",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/refine-issues",
			expect.any(Object),
		);
	});

	it("routes Issue create with initial status through same statusChangedTo rules as transitions", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "create",
			data: {
				id: "new-issue-uuid",
				state: { name: "Backlog" },
				labelIds: [],
				labels: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("refine-issues");
		expect(body.matchedRules).not.toContain("issue-created");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/refine-issues",
			expect.any(Object),
		);
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const posted = JSON.parse(init.body as string) as {
			normalizedEvents: { kind: string }[];
		};
		expect(posted.normalizedEvents.some((e) => e.kind === "statusChanged")).toBe(true);
	});

	it("dispatches to issue-created webhook when Issue create has no resolvable state", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "create",
			data: {
				id: "new-issue-uuid",
				labelIds: [],
				labels: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("issue-created");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-issue-created",
			expect.any(Object),
		);
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const posted = JSON.parse(init.body as string) as {
			normalizedEvents: { kind: string; issueId: string }[];
		};
		expect(posted.normalizedEvents.some((e) => e.kind === "issueCreated")).toBe(true);
	});

	it("dispatches when label Blocked is removed from an issue", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "In Progress" },
				labelIds: [],
				labels: [{ id: "lbl-blocked", name: "Blocked" }],
			},
			updatedFrom: {
				state: { name: "In Progress" },
				labelIds: ["lbl-blocked"],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("label-removed-blocked");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-label",
			expect.any(Object),
		);
	});

	it("dispatches on Comment create", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Comment",
			action: "create",
			data: {
				id: "comment-uuid",
				issueId: "issue-uuid",
				body: "hello",
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Comment" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("comment-added");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-comment",
			expect.any(Object),
		);
	});

	it("dispatches on Reaction create when emoji matches a rule", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Reaction",
			action: "create",
			data: {
				id: "reaction-uuid",
				emoji: "thumbsup",
				commentId: "comment-uuid",
				issueId: "issue-uuid",
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Reaction" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("reaction-thumbs-up");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-reaction",
			expect.any(Object),
		);
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const posted = JSON.parse(init.body as string) as {
			normalizedEvents: { kind: string; emoji: string }[];
		};
		expect(posted.normalizedEvents.some((e) => e.kind === "reaction" && e.emoji === "thumbsup")).toBe(
			true,
		);
	});

	it("dispatches on Reaction create when emoji is robot face", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Reaction",
			action: "create",
			data: {
				id: "reaction-uuid",
				emoji: "robot_face",
				commentId: "comment-uuid",
				issueId: "issue-uuid",
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Reaction" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("reaction-robot-face");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-reaction-robot-face",
			expect.any(Object),
		);
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token-bot-routing");
		const posted = JSON.parse(init.body as string) as {
			normalizedEvents: { kind: string; emoji: string }[];
		};
		expect(posted.normalizedEvents.some((e) => e.kind === "reaction" && e.emoji === "robot_face")).toBe(
			true,
		);
	});

	it("normalizes and dispatches issue-only Reaction without commentId (Linear production shape)", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Reaction",
			action: "create",
			data: {
				id: "b059265c-9e28-43a5-ab6a-7f516320415c",
				emoji: "robot_face",
				issueId: "b9666aaa-996c-48bb-80f5-704ee21ef0a0",
				issue: {
					id: "b9666aaa-996c-48bb-80f5-704ee21ef0a0",
					title: "Kontosökning",
					teamId: "5ffbce43-55dc-4c73-b3ad-5e4fb5629aaa",
					team: {
						id: "5ffbce43-55dc-4c73-b3ad-5e4fb5629aaa",
						key: "LAV",
						name: "Lavora",
					},
					identifier: "LAV-142",
					url: "https://linear.app/myledger/issue/LAV-142/x",
				},
			},
		};
		const direct = normalizeLinearPayload(payload);
		expect(direct).toHaveLength(1);
		const nev = direct[0] as {
			kind: string;
			commentId?: string;
			issueId?: string;
			emoji: string;
		};
		expect(nev.kind).toBe("reaction");
		expect(nev.emoji).toBe("robot_face");
		expect(nev.commentId).toBeUndefined();
		expect(nev.issueId).toBe("b9666aaa-996c-48bb-80f5-704ee21ef0a0");

		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Reaction" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("reaction-robot-face");
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const posted = JSON.parse(init.body as string) as {
			normalizedEvents: Array<{
				kind: string;
				emoji: string;
				commentId?: string;
				issueId?: string;
			}>;
		};
		const postedEv = posted.normalizedEvents.find((e) => e.kind === "reaction");
		expect(postedEv?.emoji).toBe("robot_face");
		expect(postedEv?.commentId).toBeUndefined();
		expect(postedEv?.issueId).toBe("b9666aaa-996c-48bb-80f5-704ee21ef0a0");
	});

	it("dispatches without Authorization when per-rule token is missing (fail-open)", async () => {
		const envWithoutBotToken = {
			...env,
			CURSOR_WEBHOOK_BOT_ROUTING_AUTH_TOKEN: "",
		} as Env;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Reaction",
			action: "create",
			data: {
				id: "reaction-uuid",
				emoji: "robot_face",
				commentId: "comment-uuid",
				issueId: "issue-uuid",
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Reaction" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, envWithoutBotToken, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toContain("reaction-robot-face");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://cursor.test/hooks/placeholder-reaction-robot-face",
			expect.any(Object),
		);
		const cursorCall = firstCursorFetchCall(fetchMock.mock.calls);
		const init = cursorCall?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			JSON.stringify({
				msg: "cursor_route_auth_token_missing",
				ruleId: "reaction-robot-face",
				authTokenEnvKey: "CURSOR_WEBHOOK_BOT_ROUTING_AUTH_TOKEN",
			}),
		);
	});

	it("does not dispatch Reaction when emoji matches no rule", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Reaction",
			action: "create",
			data: {
				id: "reaction-uuid",
				emoji: "heart",
				commentId: "comment-uuid",
				issueId: "issue-uuid",
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Reaction" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { matchedRules: string[] };
		expect(body.matchedRules).toEqual([]);
		expect(firstCursorFetchCall(fetchMock.mock.calls)).toBeUndefined();
	});

	it("does not call Cursor when no rule matches", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Backlog" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: {
				state: { name: "Backlog" },
				labelIds: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			matchedRules: string[];
			dispatchResults: unknown[];
		};
		expect(body.matchedRules).toEqual([]);
		expect(body.dispatchResults).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not emit statusChanged for Issue update when updatedFrom omits state", () => {
		const withoutUpdatedFrom = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Todo" },
				labelIds: [],
				labels: [],
			},
		});
		expect(
			withoutUpdatedFrom.filter((e) => e.kind === "statusChanged"),
		).toEqual([]);

		const labelIdsOnly = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Backlog" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: { labelIds: [] },
		});
		expect(labelIdsOnly.filter((e) => e.kind === "statusChanged")).toEqual([]);
	});

	it("does not dispatch status webhooks for Issue update without updatedFrom.state", async () => {
		const payload = {
			webhookTimestamp: Date.now(),
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Todo" },
				labelIds: [],
				labels: [],
			},
		};
		const request = buildLinearWebhookRequest(
			"https://example.com/webhooks/linear",
			payload,
			{ "Linear-Event": "Issue" },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			matchedRules: string[];
			dispatchResults: unknown[];
		};
		expect(body.matchedRules).toEqual([]);
		expect(body.dispatchResults).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns 400 for invalid JSON body", async () => {
		const raw = "{ not json";
		const request = new IncomingRequest("https://example.com/webhooks/linear", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Linear-Signature": signLinearRawBody(raw),
			},
			body: raw,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});

describe("matchingProjects rule filter", () => {
	const envForMatch: Record<string, string | undefined> = {
		CURSOR_WEBHOOK_TEST_SCOPED: "https://cursor.test/hooks/scoped",
	};

	it("matches when scoped rule has no project in payload (fail-open project filter)", () => {
		const rules: RoutingRule[] = [
			{
				id: "scoped-done",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["proj-exclusive"],
				targetEnvKey: "CURSOR_WEBHOOK_TEST_SCOPED",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: {
				state: { name: "Todo" },
				labelIds: [],
			},
		});
		const matches = matchRoutes(events, rules, envForMatch);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.rule.id).toBe("scoped-done");
	});

	it("matches when project id is listed in matchingProjects", () => {
		const rules: RoutingRule[] = [
			{
				id: "scoped-done",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["proj-exclusive"],
				targetEnvKey: "CURSOR_WEBHOOK_TEST_SCOPED",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
				project: { id: "proj-exclusive", name: "Alpha" },
			},
			updatedFrom: {
				state: { name: "Todo" },
				labelIds: [],
			},
		});
		const matches = matchRoutes(events, rules, envForMatch);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.rule.id).toBe("scoped-done");
		expect(matches[0]?.events[0]?.projectIdents).toContain("proj-exclusive");
	});

	it("does not match when project differs from matchingProjects", () => {
		const rules: RoutingRule[] = [
			{
				id: "scoped-done",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["proj-exclusive"],
				targetEnvKey: "CURSOR_WEBHOOK_TEST_SCOPED",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-uuid",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
				project: { id: "other-proj", name: "Beta" },
			},
			updatedFrom: {
				state: { name: "Todo" },
				labelIds: [],
			},
		});
		expect(matchRoutes(events, rules, envForMatch)).toHaveLength(0);
	});

	it("matches commentAdded when nested issue.project matches", () => {
		const rules: RoutingRule[] = [
			{
				id: "scoped-comment",
				when: { type: "commentAdded" },
				matchingProjects: ["my-key"],
				targetEnvKey: "CURSOR_WEBHOOK_TEST_SCOPED",
			},
		];
		const events = normalizeLinearPayload({
			type: "Comment",
			action: "create",
			data: {
				id: "c1",
				issueId: "i1",
				body: "hi",
				issue: {
					id: "i1",
					project: { id: "p1", key: "my-key", name: "Proj" },
				},
			},
		});
		const matches = matchRoutes(events, rules, envForMatch);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.events[0]?.kind).toBe("commentAdded");
	});

	it("matches reaction when comment.issue.project matches", () => {
		const rules: RoutingRule[] = [
			{
				id: "scoped-emoji",
				when: { type: "reactionWithEmoji", emoji: "thumbsup" },
				matchingProjects: ["react-proj"],
				targetEnvKey: "CURSOR_WEBHOOK_TEST_SCOPED",
			},
		];
		const events = normalizeLinearPayload({
			type: "Reaction",
			action: "create",
			data: {
				id: "r1",
				emoji: "thumbsup",
				commentId: "c1",
				issueId: "i1",
				comment: {
					id: "c1",
					issueId: "i1",
					issue: {
						id: "i1",
						project: { id: "react-proj", name: "R" },
					},
				},
			},
		});
		const matches = matchRoutes(events, rules, envForMatch);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.events[0]?.kind).toBe("reaction");
	});
});
