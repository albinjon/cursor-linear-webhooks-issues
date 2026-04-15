import { handleLinearWebhookPost } from "./linear/handler";

function normalizePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = normalizePathname(url.pathname);

		if (path === "/webhooks/linear") {
			if (request.method !== "POST") {
				return new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "POST" },
				});
			}
			return handleLinearWebhookPost(request, env);
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Not Found", { status: 404 });
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
