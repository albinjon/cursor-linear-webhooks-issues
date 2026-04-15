/**
 * Fetches Issue.project from Linear GraphQL when webhooks omit project fields but
 * routing rules use matchingProjects. See README for LINEAR_API_KEY.
 */

import type { NormalizedEvent } from "./normalize";
import type { RoutingRule } from "../routing/types";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_PROJECT_QUERY = `query IssueProjectForRouting($issueId: String!) {
	issue(id: $issueId) {
		id
		project {
			id
			name
			slug
		}
	}
}`;

export function rulesNeedProjectResolution(rules: RoutingRule[]): boolean {
	return rules.some((r) =>
		(r.matchingProjects ?? []).some((s) => s.trim().length > 0),
	);
}

function projectIdentsFromGraphqlProject(
	project: {
		id?: string | null;
		name?: string | null;
		slug?: string | null;
		key?: string | null;
	} | null,
): string[] {
	if (!project) return [];
	const out: string[] = [];
	for (const v of [project.id, project.name, project.slug, project.key]) {
		if (typeof v === "string" && v.length > 0) out.push(v);
	}
	return [...new Set(out)];
}

function issueIdFromNormalizedEvent(ev: NormalizedEvent): string | undefined {
	if (ev.kind === "reaction") return ev.issueId;
	return ev.issueId;
}

function eventNeedsProjectIdents(ev: NormalizedEvent): boolean {
	const idents = ev.projectIdents;
	return !idents?.length;
}

type GraphQLResponse = {
	data?: {
		issue?: {
			id: string;
			project?: {
				id: string;
				name?: string | null;
				slug?: string | null;
			} | null;
		} | null;
	};
	errors?: { message: string }[];
};

async function fetchProjectIdentsForIssue(
	issueId: string,
	apiKey: string,
	fetchFn: typeof fetch,
): Promise<string[]> {
	const res = await fetchFn(LINEAR_GRAPHQL_URL, {
		method: "POST",
		headers: {
			Authorization: apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query: ISSUE_PROJECT_QUERY,
			variables: { issueId },
		}),
	});
	if (!res.ok) return [];
	let json: GraphQLResponse;
	try {
		json = (await res.json()) as GraphQLResponse;
	} catch {
		return [];
	}
	if (json.errors?.length) return [];
	const proj = json.data?.issue?.project;
	return projectIdentsFromGraphqlProject(proj ?? null);
}

function mergeIdents(
	existing: string[] | undefined,
	added: string[],
): string[] {
	return [...new Set([...(existing ?? []), ...added])];
}

/**
 * When rules use matchingProjects and events lack projectIdents (typical for webhooks),
 * loads each issue's project via Linear GraphQL and merges id, name, slug into projectIdents.
 * No-op if LINEAR_API_KEY is missing, no rules need projects, or all events already have idents.
 */
export async function enrichNormalizedEventsWithLinearProjects(
	events: NormalizedEvent[],
	rules: RoutingRule[],
	env: { LINEAR_API_KEY?: string },
	fetchFn: typeof fetch = fetch,
): Promise<NormalizedEvent[]> {
	const apiKey = env.LINEAR_API_KEY?.trim();
	if (!apiKey || !rulesNeedProjectResolution(rules)) {
		return events;
	}

	const needsFetch = events.some(
		(ev) => eventNeedsProjectIdents(ev) && issueIdFromNormalizedEvent(ev),
	);
	if (!needsFetch) return events;

	const issueIds = [
		...new Set(
			events
				.map(issueIdFromNormalizedEvent)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];

	const byIssue = new Map<string, string[]>();
	await Promise.all(
		issueIds.map(async (id) => {
			const idents = await fetchProjectIdentsForIssue(id, apiKey, fetchFn);
			byIssue.set(id, idents);
		}),
	);

	return events.map((ev) => {
		const iid = issueIdFromNormalizedEvent(ev);
		if (!iid || !eventNeedsProjectIdents(ev)) return ev;
		const fromApi = byIssue.get(iid);
		if (!fromApi?.length) return ev;
		return {
			...ev,
			projectIdents: mergeIdents(ev.projectIdents, fromApi),
		};
	});
}
