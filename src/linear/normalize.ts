/**
 * Normalized events for routing (names for status/labels; reaction emoji is Linear’s shortcode string, e.g. `thumbsup`, `robot_face`).
 * Reactions may be **comment-scoped** (`commentId`) and/or **issue-scoped** (`issueId`) depending on Linear’s payload.
 * Validation + branching via Zod union; domain rules live in small pure helpers.
 */

import { z } from "zod";
import { projectLikeSchema } from "./schemas";

export type NormalizedEvent =
	| {
			kind: "statusChanged";
			issueId: string;
			previousStatusName: string | null;
			newStatusName: string;
			/** Project id / name / slug / key from the webhook and/or GraphQL enrichment (for `matchingProjects`). */
			projectIdents?: string[];
	  }
	| {
			kind: "labelRemoved";
			issueId: string;
			removedLabelNames: string[];
			projectIdents?: string[];
	  }
	| {
			kind: "commentAdded";
			issueId: string;
			commentId: string;
			body?: string;
			projectIdents?: string[];
	  }
	| {
			kind: "reaction";
			emoji: string;
			/** Present for comment reactions; omitted for issue-only reactions. */
			commentId?: string;
			/** Present when Linear sends `issueId` / nested issue (including issue-only reactions). */
			issueId?: string;
			reactionAction: "create" | "remove";
			projectIdents?: string[];
	  }
	| {
			kind: "issueCreated";
			issueId: string;
			projectIdents?: string[];
	  };

/** Distinct non-empty project id, name, slug, or key strings from a Linear entity payload. */
function projectIdentsFromRecord(data: Record<string, unknown>): string[] {
	const out: string[] = [];
	const add = (s: unknown) => {
		if (typeof s === "string" && s.length > 0) out.push(s);
	};
	add(data.projectId);
	const proj = data.project;
	if (proj && typeof proj === "object" && proj !== null) {
		const parsed = projectLikeSchema.safeParse(proj);
		if (parsed.success) {
			add(parsed.data.id);
			add(parsed.data.name);
			add(parsed.data.slug);
			add(parsed.data.key);
		} else {
			const p = proj as Record<string, unknown>;
			add(p.id);
			add(p.name);
			add(p.slug);
			add(p.key);
		}
	}
	return [...new Set(out)];
}

function mapWithProjectIdents(
	evs: NormalizedEvent[],
	idents: string[],
): NormalizedEvent[] {
	if (!idents.length) return evs;
	return evs.map((ev) => ({ ...ev, projectIdents: idents }));
}

const stateRefSchema = z
	.object({
		name: z.string().nullish(),
	})
	.passthrough();

const issueDataSchema = z
	.object({
		id: z.string(),
		state: stateRefSchema.nullish(),
		labelIds: z.array(z.string()).nullish(),
		labels: z
			.array(
				z
					.object({
						id: z.string(),
						name: z.string().nullish(),
					})
					.passthrough(),
			)
			.nullish(),
		projectId: z.string().nullish().optional(),
		project: projectLikeSchema.nullish().optional(),
	})
	.passthrough();

type IssueData = z.infer<typeof issueDataSchema>;

function projectIdentsFromIssueData(data: IssueData): string[] {
	return projectIdentsFromRecord({
		projectId: data.projectId,
		project: data.project,
	});
}

function mergeProjectIdents(...groups: string[][]): string[] {
	return [...new Set(groups.flat())];
}

/** Comment / IssueLabel webhook payloads with optional nested `issue` carrying project fields. */
function projectIdentsFromIssueNestedPayload(data: Record<string, unknown>): string[] {
	const direct = projectIdentsFromRecord(data);
	const issue = data.issue;
	if (issue && typeof issue === "object") {
		return mergeProjectIdents(
			direct,
			projectIdentsFromRecord(issue as Record<string, unknown>),
		);
	}
	return direct;
}

const updatedFromSchema = z
	.object({
		state: stateRefSchema.nullish().optional(),
		labelIds: z.array(z.string()).optional(),
	})
	.passthrough();

type UpdatedFrom = z.infer<typeof updatedFromSchema>;

function readStateName(
	state: { name?: string | null } | null | undefined,
): string | null {
	const n = state?.name;
	return typeof n === "string" ? n : null;
}

function buildLabelIdToName(data: IssueData): Map<string, string> {
	const map = new Map<string, string>();
	if (!data.labels) return map;
	for (const l of data.labels) {
		if (l.name && l.name.length) map.set(l.id, l.name);
	}
	return map;
}

function eventsFromIssueStatus(
	data: IssueData,
	updatedFrom: UpdatedFrom | null | undefined,
): NormalizedEvent[] {
	const prev = readStateName(updatedFrom?.state);
	const next = readStateName(data.state);
	if (next !== null && prev !== next) {
		return [
			{
				kind: "statusChanged",
				issueId: data.id,
				previousStatusName: prev,
				newStatusName: next,
			},
		];
	}
	return [];
}

function eventsFromIssueLabels(
	data: IssueData,
	updatedFrom: UpdatedFrom | null | undefined,
): NormalizedEvent[] {
	const idToName = buildLabelIdToName(data);
	const currentIds = new Set(data.labelIds ?? []);
	const prevIds = updatedFrom?.labelIds ?? [];
	const removedIds = prevIds.filter((id) => !currentIds.has(id));
	const removedLabelNames = removedIds
		.map((id) => idToName.get(id))
		.filter((n): n is string => !!n);
	if (!removedLabelNames.length) return [];
	return [
		{
			kind: "labelRemoved",
			issueId: data.id,
			removedLabelNames,
		},
	];
}

const commentCreateWebhook = z
	.object({
		type: z.literal("Comment"),
		action: z.literal("create"),
		data: z
			.object({
				id: z.string(),
				issueId: z.string(),
				body: z.string().nullish(),
			})
			.passthrough(),
	})
	.transform(({ data }) => {
		const idents = projectIdentsFromIssueNestedPayload(
			data as unknown as Record<string, unknown>,
		);
		const ev: NormalizedEvent = {
			kind: "commentAdded",
			issueId: data.issueId,
			commentId: data.id,
			body: data.body ?? undefined,
		};
		return mapWithProjectIdents([ev], idents);
	});

const issueCreateWebhook = z
	.object({
		type: z.literal("Issue"),
		action: z.literal("create"),
		data: issueDataSchema,
	})
	.transform(({ data }) => {
		const idents = projectIdentsFromIssueData(data);
		const initialStatus = readStateName(data.state);
		if (initialStatus !== null) {
			const ev: NormalizedEvent = {
				kind: "statusChanged",
				issueId: data.id,
				previousStatusName: null,
				newStatusName: initialStatus,
			};
			return mapWithProjectIdents([ev], idents);
		}
		const created: NormalizedEvent = { kind: "issueCreated", issueId: data.id };
		return mapWithProjectIdents([created], idents);
	});

const issueUpdateWebhook = z
	.object({
		type: z.literal("Issue"),
		action: z.literal("update"),
		data: issueDataSchema,
		updatedFrom: updatedFromSchema.nullish(),
	})
	.transform(({ data, updatedFrom }) => {
		const idents = projectIdentsFromIssueData(data);
		return mapWithProjectIdents(
			[
				...eventsFromIssueStatus(data, updatedFrom ?? undefined),
				...eventsFromIssueLabels(data, updatedFrom ?? undefined),
			],
			idents,
		);
	});

const issueLabelRemoveWebhook = z
	.object({
		type: z.literal("IssueLabel"),
		action: z.literal("remove"),
		data: z
			.object({
				issueId: z.string(),
				label: z
					.object({
						name: z.string(),
					})
					.passthrough(),
			})
			.passthrough(),
	})
	.transform(({ data }) => {
		const idents = projectIdentsFromIssueNestedPayload(
			data as unknown as Record<string, unknown>,
		);
		const ev: NormalizedEvent = {
			kind: "labelRemoved",
			issueId: data.issueId,
			removedLabelNames: [data.label.name],
		};
		return mapWithProjectIdents([ev], idents);
	});

const reactionIssueRefSchema = z
	.object({
		id: z.string(),
	})
	.merge(projectLikeSchema.partial())
	.passthrough();

/** Linear `Reaction` entity — on a comment and/or issue (nested `comment` and/or `issue`). */
const reactionDataSchema = z
	.object({
		id: z.string(),
		emoji: z.string(),
		commentId: z.string().nullish(),
		issueId: z.string().nullish(),
		issue: reactionIssueRefSchema.optional(),
		comment: z
			.object({
				id: z.string().optional(),
				issueId: z.string().nullish(),
				issue: reactionIssueRefSchema.optional(),
			})
			.passthrough()
			.nullish(),
	})
	.passthrough();

type ReactionData = z.infer<typeof reactionDataSchema>;

function commentIdFromReaction(data: ReactionData): string | undefined {
	if (typeof data.commentId === "string" && data.commentId.length) {
		return data.commentId;
	}
	const c = data.comment;
	if (c && typeof c.id === "string" && c.id.length) return c.id;
	return undefined;
}

function issueIdFromReaction(data: ReactionData): string | undefined {
	if (typeof data.issueId === "string" && data.issueId.length) {
		return data.issueId;
	}
	const c = data.comment;
	if (!c) return undefined;
	if (typeof c.issueId === "string" && c.issueId.length) return c.issueId;
	const issue = c.issue;
	if (issue && typeof issue.id === "string") return issue.id;
	return undefined;
}

function projectIdentsFromReactionData(data: ReactionData): string[] {
	const fromCommentIssue =
		data.comment?.issue && typeof data.comment.issue === "object"
			? projectIdentsFromRecord(data.comment.issue as Record<string, unknown>)
			: [];
	const fromTopIssue =
		data.issue && typeof data.issue === "object"
			? projectIdentsFromRecord(data.issue as Record<string, unknown>)
			: [];
	return mergeProjectIdents(fromCommentIssue, fromTopIssue);
}

function reactionEvents(
	data: ReactionData,
	reactionAction: "create" | "remove",
): NormalizedEvent[] {
	const commentId = commentIdFromReaction(data);
	const issueId = issueIdFromReaction(data);
	const idents = projectIdentsFromReactionData(data);

	if (commentId) {
		const ev: NormalizedEvent =
			issueId !== undefined
				? {
						kind: "reaction",
						emoji: data.emoji,
						commentId,
						issueId,
						reactionAction,
					}
				: {
						kind: "reaction",
						emoji: data.emoji,
						commentId,
						reactionAction,
					};
		return mapWithProjectIdents([ev], idents);
	}

	if (issueId) {
		const ev: NormalizedEvent = {
			kind: "reaction",
			emoji: data.emoji,
			issueId,
			reactionAction,
		};
		return mapWithProjectIdents([ev], idents);
	}

	return [];
}

const reactionCreateWebhook = z
	.object({
		type: z.literal("Reaction"),
		action: z.literal("create"),
		data: reactionDataSchema,
	})
	.transform(({ data }) => reactionEvents(data, "create"));

const reactionRemoveWebhook = z
	.object({
		type: z.literal("Reaction"),
		action: z.literal("remove"),
		data: reactionDataSchema,
	})
	.transform(({ data }) => reactionEvents(data, "remove"));

const linearDataChangeWebhook = z.union([
	commentCreateWebhook,
	issueCreateWebhook,
	issueUpdateWebhook,
	issueLabelRemoveWebhook,
	reactionCreateWebhook,
	reactionRemoveWebhook,
]);

/**
 * Derives zero or more normalized events from a Linear data-change webhook body.
 * Unknown or non-matching shapes yield an empty array (no throw).
 */
export function normalizeLinearPayload(payload: unknown): NormalizedEvent[] {
	const r = linearDataChangeWebhook.safeParse(payload);
	return r.success ? r.data : [];
}
