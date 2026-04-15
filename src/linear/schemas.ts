import { z } from "zod";

/** Nested Linear `Project` fields used for routing identifiers (id, name, slugId, slug, key). */
export const projectLikeSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().nullish(),
		/** GraphQL `Project.slugId` (human-readable slug); webhooks may still send legacy `slug`. */
		slugId: z.string().nullish(),
		slug: z.string().nullish(),
		key: z.string().nullish(),
	})
	.passthrough();

export type ProjectLike = z.infer<typeof projectLikeSchema>;
