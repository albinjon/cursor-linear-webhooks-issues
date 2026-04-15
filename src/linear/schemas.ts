import { z } from "zod";

/** Nested Linear `Project` fields for parsing; routing uses id, name, slug, and key — not `slugId`. */
export const projectLikeSchema = z
	.object({
		id: z.string().optional(),
		name: z.string().nullish(),
		/** Ignored for matchingProjects (opaque in GraphQL); kept for payload compatibility. */
		slugId: z.string().nullish(),
		slug: z.string().nullish(),
		key: z.string().nullish(),
	})
	.passthrough();

export type ProjectLike = z.infer<typeof projectLikeSchema>;
