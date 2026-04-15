import { z } from "zod";

/**
 * Minimal shape for replay-window checks and logging; unknown fields are preserved for normalization.
 */
export const linearWebhookPayloadSchema = z
	.object({
		webhookTimestamp: z.number().finite().optional(),
	})
	.passthrough();

export type LinearWebhookPayloadParsed = z.infer<
	typeof linearWebhookPayloadSchema
>;
