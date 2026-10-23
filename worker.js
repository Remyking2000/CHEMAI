import { onRequest, onRequestOptions } from "./functions/api/[[route]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route /api/* requests to our API gateway
    if (url.pathname.startsWith("/api")) {
      if (request.method === "OPTIONS") {
        return onRequestOptions();
      }
      return onRequest({
        request,
        env,
        params: {},
        waitUntil: ctx.waitUntil ? ctx.waitUntil.bind(ctx) : () => {},
        next: () => (env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 })),
      });
    }

    // Route all other requests to static assets (with SPA routing)
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404 && !url.pathname.includes(".")) {
        return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      }
      return res;
    }

    // SPA fallback when running on bare workers.dev without ASSETS binding
    if (!url.pathname.includes(".")) {
      try {
        const rootRes = await fetch(new URL("/", request.url));
        if (rootRes.ok) {
          return new Response(rootRes.body, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        }
      } catch {
        // fall through to error
      }
    }

    return new Response("Asset handler not available", { status: 404 });
  },
};
