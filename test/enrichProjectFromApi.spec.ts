import { describe, it, expect, vi } from "vitest";
import {
	enrichNormalizedEventsWithLinearProjects,
	rulesNeedProjectResolution,
} from "../src/linear/enrichProjectFromApi";
import { normalizeLinearPayload } from "../src/linear/normalize";
import type { RoutingRule } from "../src/routing/types";

describe("enrichProjectFromApi", () => {
	it("rulesNeedProjectResolution is false when no matchingProjects", () => {
		const rules: RoutingRule[] = [
			{
				id: "a",
				when: { type: "commentAdded" },
				targetEnvKey: "X",
			},
		];
		expect(rulesNeedProjectResolution(rules)).toBe(false);
	});

	it("rulesNeedProjectResolution is true when any rule has matchingProjects", () => {
		const rules: RoutingRule[] = [
			{
				id: "a",
				when: { type: "commentAdded" },
				matchingProjects: ["p1"],
				targetEnvKey: "X",
			},
		];
		expect(rulesNeedProjectResolution(rules)).toBe(true);
	});

	it("returns events unchanged when LINEAR_API_KEY is missing", async () => {
		const rules: RoutingRule[] = [
			{
				id: "a",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["v1"],
				targetEnvKey: "X",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: { state: { name: "Todo" }, labelIds: [] },
		});
		const fetchMock = vi.fn();
		const out = await enrichNormalizedEventsWithLinearProjects(
			events,
			rules,
			{},
			fetchMock,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out).toEqual(events);
	});

	it("merges project idents from GraphQL into events", async () => {
		const rules: RoutingRule[] = [
			{
				id: "a",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["v1"],
				targetEnvKey: "X",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: { state: { name: "Todo" }, labelIds: [] },
		});
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: {
						issue: {
							id: "issue-1",
							project: { id: "v1", name: "P", slugId: "v1" },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const out = await enrichNormalizedEventsWithLinearProjects(
			events,
			rules,
			{ LINEAR_API_KEY: "key" },
			fetchMock,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.linear.app/graphql",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "key" }),
			}),
		);
		expect(out[0]?.projectIdents).toContain("v1");
	});

	it("logs when Linear GraphQL returns a non-OK status", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const rules: RoutingRule[] = [
			{
				id: "a",
				when: { type: "statusChangedTo", statusName: "Done" },
				matchingProjects: ["v1"],
				targetEnvKey: "X",
			},
		];
		const events = normalizeLinearPayload({
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				state: { name: "Done" },
				labelIds: [],
				labels: [],
			},
			updatedFrom: { state: { name: "Todo" }, labelIds: [] },
		});
		const fetchMock = vi.fn(async () => {
			return new Response("Unauthorized", {
				status: 401,
				statusText: "Unauthorized",
			});
		});

		await enrichNormalizedEventsWithLinearProjects(
			events,
			rules,
			{ LINEAR_API_KEY: "key" },
			fetchMock,
		);

		expect(warnSpy).toHaveBeenCalled();
		const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
		expect(payload.msg).toBe("linear_graphql_issue_project_failed");
		expect(payload.phase).toBe("http_error");
		expect(payload.issueId).toBe("issue-1");
		expect(payload.status).toBe(401);
		expect(payload.bodyPreview).toBe("Unauthorized");

		warnSpy.mockRestore();
	});
});
