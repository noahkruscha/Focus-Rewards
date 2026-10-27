import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

auth.addHttpRoutes(http);

const extensionCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extensionCors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function randomToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashExtensionSecret(purpose: "pair" | "session", secret: string) {
  const input = new TextEncoder().encode(`focus-rewards:extension-${purpose}:v1:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
  return match?.[1] ?? null;
}

function isAllowedExtensionOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

http.route({
  path: "/extension/redeem",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

http.route({
  path: "/extension/redeem",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isAllowedExtensionOrigin(request)) return jsonResponse({ error: "Origin not allowed." }, 403);
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) return jsonResponse({ error: "Expected JSON." }, 415);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON." }, 400);
    }
    if (typeof body !== "object" || body === null || !("code" in body) || typeof body.code !== "string" || body.code.length !== 32 || !/^[A-Za-z0-9_-]{32}$/.test(body.code)) {
      return jsonResponse({ error: "Invalid pairing code." }, 400);
    }
    const token = randomToken(32);
    const codeHash = await hashExtensionSecret("pair", body.code);
    const sessionHash = await hashExtensionSecret("session", token);
    try {
      const session = await ctx.runMutation(internal.access.redeemExtensionPairingCode, {
        codeHash,
        sessionHash,
        now: Date.now(),
      });
      return jsonResponse({ token, expiresAt: session.expiresAt, email: session.email });
    } catch (error) {
      if (error instanceof ConvexError) {
        return jsonResponse({ error: error.message }, 401);
      }
      console.error("[extension:redeem] Unexpected backend failure.");
      return jsonResponse({ error: "Pairing service is temporarily unavailable." }, 503);
    }
  }),
});

http.route({
  path: "/extension/youtube/pricing-rates",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

http.route({
  path: "/extension/youtube/pricing-rates",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authenticated = await authenticatedExtensionSession(ctx, request);
    if ("error" in authenticated) return authenticated.error;
    try {
      const rates = await ctx.runQuery(internal.rewards.extensionYouTubePricingRates, {
        tokenHash: authenticated.session.tokenHash,
        now: Date.now(),
      });
      return jsonResponse({ ...rates, flexibleUsageEnabled: false });
    } catch (error) {
      if (error instanceof ConvexError) return jsonResponse({ error: error.message }, error.message.startsWith("Extension session") ? 401 : 400);
      console.error("[extension:youtube-pricing-rates] Unexpected backend failure.");
      return jsonResponse({ error: "Pricing settings are temporarily unavailable." }, 503);
    }
  }),
});

http.route({
  path: "/extension/youtube/quote",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

http.route({
  path: "/extension/youtube/quote",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isAllowedExtensionOrigin(request)) return jsonResponse({ error: "Origin not allowed." }, 403);
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return jsonResponse({ error: "Expected JSON." }, 415);
    let body: unknown;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }
    if (typeof body !== "object" || body === null || !("videoId" in body) || typeof body.videoId !== "string"
      || !/^[A-Za-z0-9_-]{11}$/.test(body.videoId) || !("contentType" in body)
      || (body.contentType !== "youtube_video" && body.contentType !== "youtube_short")
      || !("durationSeconds" in body) || typeof body.durationSeconds !== "number"
      || !Number.isSafeInteger(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > 6 * 60 * 60) {
      return jsonResponse({ error: "Invalid YouTube content identifier." }, 400);
    }
    const authenticated = await authenticatedExtensionSession(ctx, request);
    if ("error" in authenticated) return authenticated.error;
    try {
      const quote = await ctx.runMutation(internal.rewards.youtubePurchaseQuote, {
        tokenHash: authenticated.session.tokenHash,
        videoId: body.videoId,
        contentType: body.contentType,
        durationSeconds: body.durationSeconds,
        now: Date.now(),
      });
      return jsonResponse(quote);
    } catch (error) {
      if (error instanceof ConvexError) return jsonResponse({ error: error.message }, error.message.startsWith("Extension session") ? 401 : 400);
      console.error("[extension:youtube-quote] Unexpected backend failure.");
      return jsonResponse({ error: "Pricing service is temporarily unavailable." }, 503);
    }
  }),
});

http.route({
  path: "/extension/youtube/purchase",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

http.route({
  path: "/extension/youtube/entitlement",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

async function authenticatedExtensionSession(ctx: Parameters<Parameters<typeof httpAction>[0]>[0], request: Request): Promise<
  | { session: { userId: import("./_generated/dataModel").Id<"users">; tokenHash: string; email: string | null; expiresAt: number } }
  | { error: Response }
> {
  if (!isAllowedExtensionOrigin(request)) return { error: jsonResponse({ error: "Origin not allowed." }, 403) };
  const token = bearerToken(request);
  if (!token) return { error: jsonResponse({ error: "Extension session required." }, 401) };
  const tokenHash = await hashExtensionSecret("session", token);
  const session = await ctx.runQuery(internal.access.assertExtensionSession, { tokenHash, now: Date.now() });
  if (!session) return { error: jsonResponse({ error: "Extension session is expired or revoked." }, 401) };
  return { session: { ...session, tokenHash } };
}

http.route({
  path: "/extension/youtube/purchase",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isAllowedExtensionOrigin(request)) return jsonResponse({ error: "Origin not allowed." }, 403);
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return jsonResponse({ error: "Expected JSON." }, 415);
    let body: unknown;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }
    if (typeof body !== "object" || body === null || !("videoId" in body) || typeof body.videoId !== "string"
      || !/^[A-Za-z0-9_-]{11}$/.test(body.videoId) || !("contentType" in body)
      || (body.contentType !== "youtube_video" && body.contentType !== "youtube_short")
      || !("durationSeconds" in body) || typeof body.durationSeconds !== "number"
      || !("idempotencyKey" in body) || typeof body.idempotencyKey !== "string"
      || !("quoteId" in body) || typeof body.quoteId !== "string") {
      return jsonResponse({ error: "Invalid YouTube purchase request." }, 400);
    }
    const authenticated = await authenticatedExtensionSession(ctx, request);
    if ("error" in authenticated) return authenticated.error;
    try {
      const result = await ctx.runMutation(internal.rewards.purchaseYouTubeReward, {
        tokenHash: authenticated.session.tokenHash,
        videoId: body.videoId,
        contentType: body.contentType,
        durationSeconds: body.durationSeconds,
        idempotencyKey: body.idempotencyKey,
        quoteId: body.quoteId as import("./_generated/dataModel").Id<"youtubePurchaseQuotes">,
        now: Date.now(),
      });
      return jsonResponse({ ...result });
    } catch (error) {
      if (error instanceof ConvexError) {
        if (error.message === "INSUFFICIENT_COINS") return jsonResponse({ error: "INSUFFICIENT_COINS" }, 402);
        if (error.message.startsWith("Extension session")) return jsonResponse({ error: "Extension session is expired or revoked." }, 401);
        if (error.message.startsWith("Pricing quote")) return jsonResponse({ error: error.message }, 409);
        if (error.message.startsWith("Invalid YouTube")) return jsonResponse({ error: error.message }, 400);
        return jsonResponse({ error: error.message }, 409);
      }
      console.error("[extension:youtube-purchase] Unexpected backend failure.");
      return jsonResponse({ error: "Purchase service is temporarily unavailable." }, 503);
    }
  }),
});

http.route({
  path: "/extension/youtube/entitlement",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authenticated = await authenticatedExtensionSession(ctx, request);
    if ("error" in authenticated) return authenticated.error;
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId") ?? "";
    const contentType = url.searchParams.get("contentType");
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || (contentType !== "youtube_video" && contentType !== "youtube_short")) {
      return jsonResponse({ error: "Invalid YouTube content identifier." }, 400);
    }
    const entitlement = await ctx.runQuery(internal.rewards.verifyYouTubeEntitlement, {
      tokenHash: authenticated.session.tokenHash,
      videoId,
      contentType,
      now: Date.now(),
    });
    return entitlement ? jsonResponse({ unlocked: true, ...entitlement }) : jsonResponse({ unlocked: false });
  }),
});

http.route({
  path: "/extension/me",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: extensionCors })),
});

http.route({
  path: "/extension/me",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!isAllowedExtensionOrigin(request)) return jsonResponse({ error: "Origin not allowed." }, 403);
    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: "Unauthorized." }, 401);
    const tokenHash = await hashExtensionSecret("session", token);
    const session = await ctx.runQuery(internal.access.assertExtensionSession, { tokenHash, now: Date.now() });
    return session ? jsonResponse({ email: session.email, expiresAt: session.expiresAt }) : jsonResponse({ error: "Extension session is expired or revoked." }, 401);
  }),
});

http.route({
  path: "/extension/me",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (!isAllowedExtensionOrigin(request)) return jsonResponse({ error: "Origin not allowed." }, 403);
    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: "Unauthorized." }, 401);
    const tokenHash = await hashExtensionSecret("session", token);
    const session = await ctx.runQuery(internal.access.assertExtensionSession, { tokenHash, now: Date.now() });
    if (!session) return jsonResponse({ error: "Extension session is expired or revoked." }, 401);
    // A dedicated internal mutation revokes only the credential resolved from its hash.
    await ctx.runMutation(internal.access.revokeExtensionSessionByHash, { tokenHash, now: Date.now() });
    return jsonResponse({ revoked: true });
  }),
});

export default http;
