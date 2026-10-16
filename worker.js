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
      return env.ASSETS.fetch(request);
    }

    return new Response("Asset handler not available", { status: 404 });
  },
};
