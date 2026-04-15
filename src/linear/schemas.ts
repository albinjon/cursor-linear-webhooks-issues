import { z } from "zod";

/** Nested Linear `Project` fields used for routing identifiers (id, name, slug, key). */
export const projectLikeSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().nullish(),
		slug: z.string().nullish(),
		key: z.string().nullish(),
	})
	.passthrough();

export type ProjectLike = z.infer<typeof projectLikeSchema>;
