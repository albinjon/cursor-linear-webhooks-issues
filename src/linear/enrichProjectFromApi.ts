/**
 * Fetches Issue.project from Linear GraphQL when webhooks omit project fields but
 * routing rules use matchingProjects. See README for LINEAR_API_KEY.
 */

import { z } from "zod";
import type { NormalizedEvent } from "./normalize";
import type { RoutingRule } from "../routing/types";
import { projectLikeSchema } from "./schemas";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_PROJECT_QUERY = `query IssueProjectForRouting($issueId: String!) {
	issue(id: $issueId) {
		id
		project {
			id
			name
		}
	}
}`;

export function rulesNeedProjectResolution(rules: RoutingRule[]): boolean {
	return rules.some((r) =>
		(r.matchingProjects ?? []).some((s) => s.trim().length > 0),
	);
}

function projectIdentsFromGraphqlProject(
	project: z.infer<typeof projectLikeSchema> | null,
): string[] {
	if (!project) return [];
	const out: string[] = [];
	// Omit slugId: GraphQL often returns an opaque token; matchingProjects uses name (and id, slug, key).
	for (const v of [
		project.id,
		project.name,
		project.slug,
		project.key,
	]) {
		if (typeof v === "string" && v.length > 0) out.push(v);
	}
	return [...new Set(out)];
}

function issueIdFromNormalizedEvent(ev: NormalizedEvent): string | undefined {
	return ev.issueId;
}

function eventNeedsProjectIdents(ev: NormalizedEvent): boolean {
	const idents = ev.projectIdents;
	return !idents?.length;
}

const issueProjectGraphqlResponseSchema = z.object({
	data: z
		.object({
			issue: z
				.object({
					id: z.string(),
					project: projectLikeSchema.nullish().optional(),
				})
				.nullish(),
		})
		.optional(),
	errors: z.array(z.object({ message: z.string() })).optional(),
});

const BODY_PREVIEW_MAX = 200;

type GraphqlIssueProjectFailurePhase =
	| "http_error"
	| "json_parse"
	| "schema"
	| "graphql_errors";

function logGraphqlIssueProjectFailure(
	issueId: string,
	phase: GraphqlIssueProjectFailurePhase,
	extra: Record<string, unknown> = {},
): void {
	console.warn(
		JSON.stringify({
			msg: "linear_graphql_issue_project_failed",
			phase,
			issueId,
			...extra,
		}),
	);
}

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

	if (!res.ok) {
		let bodyPreview: string | undefined;
		try {
			const t = await res.text();
			bodyPreview =
				t.length > BODY_PREVIEW_MAX
					? `${t.slice(0, BODY_PREVIEW_MAX)}…`
					: t;
		} catch {
			bodyPreview = undefined;
		}
		logGraphqlIssueProjectFailure(issueId, "http_error", {
			status: res.status,
			statusText: res.statusText,
			...(bodyPreview !== undefined ? { bodyPreview } : {}),
		});
		return [];
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		logGraphqlIssueProjectFailure(issueId, "json_parse");
		return [];
	}

	const parsed = issueProjectGraphqlResponseSchema.safeParse(json);
	if (!parsed.success) {
		logGraphqlIssueProjectFailure(issueId, "schema", {
			zodIssues: parsed.error.issues.slice(0, 8),
		});
		return [];
	}

	const body = parsed.data;
	if (body.errors?.length) {
		logGraphqlIssueProjectFailure(issueId, "graphql_errors", {
			errors: body.errors,
		});
		return [];
	}

	const proj = body.data?.issue?.project;
	const projectIdents = projectIdentsFromGraphqlProject(proj ?? null);
	const graphqlProject = proj
		? {
				...(typeof proj.id === "string" && proj.id.length > 0
					? { id: proj.id }
					: {}),
				...(proj.name != null ? { name: proj.name } : {}),
			}
		: null;
	console.log(
		JSON.stringify({
			msg: "linear_graphql_issue_project_ok",
			issueId,
			graphqlProject,
			projectIdents,
		}),
	);
	return projectIdents;
}

function mergeIdents(
	existing: string[] | undefined,
	added: string[],
): string[] {
	return [...new Set([...(existing ?? []), ...added])];
}

/**
 * When rules use matchingProjects and events lack projectIdents (typical for webhooks),
 * loads each issue's project via Linear GraphQL and merges id, name (and legacy slug/key) into projectIdents.
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
