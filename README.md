## Overview

This project uses the following tech stack:
- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- Convex (for backend & database)
- Convex Auth (for authentication)
- Framer Motion (for animations)
- Three js (for 3d models)

All relevant files live in the 'src' directory.

Use bun for the package manager.

## Local development and environment variables

Use Bun with the checked-in `bun.lock`:

```sh
bun install --frozen-lockfile
bun run dev
```

Set the following through the local Convex CLI/dashboard for the intended development deployment:

- `CONVEX_DEPLOYMENT` is the local Convex CLI deployment selector (for example, `dev:useful-firefly-508`); it is not a browser credential. `VITE_CONVEX_URL` is the public client URL used by the website to connect to Convex. Do not put secrets in any `VITE_` variable.
- `CONVEX_SITE_URL` is the Convex HTTP Actions URL used by Convex Auth; keep it in the Convex deployment's configuration.
- `AUTH_RESEND_KEY` is a private Resend API key, and `AUTH_EMAIL_FROM` is the verified sender address. Configure these as Convex server environment variables. Never use a `VITE_` prefix for credentials.
- Convex Auth signing configuration such as `JWT_PRIVATE_KEY` and `JWKS` is managed by the Convex deployment; do not copy private key material into frontend or extension files.
- `BETA_REQUIRE_APPROVAL`, `BETA_INVITATIONS_ENABLED`, and `BETA_ADMIN_EMAIL` are server-only beta policy configuration. Per-user YouTube pricing rates are validated and stored on the Convex user record; they are not supplied by environment variables or trusted from extension requests.

Use `.env.example` as a name-only template. Do not commit `.env`, `.env.local`, deployment credentials, Resend keys, JWT private keys, or other secret values. The development and production Convex deployments have separate configuration and data; configure and verify each intentionally. Local Convex code generation writes local generated types and does not upload functions. `convex dev` uploads functions to the selected development deployment; do not use it as a substitute for code generation when upload is not intended. Production deployment is a separate, explicit operation.

## Browser extension (Opera GX and Chrome)

The extension is a Manifest V3 unpacked extension. To try the current local build:

1. In Chrome, open `chrome://extensions`; in Opera GX, open `opera://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension/` directory.
4. After editing extension files, use the extension card's **Reload** control and reload the YouTube tab.

For a distributable release, first package/review only the `extension/` directory and install through the appropriate browser store or extension-management policy. No extension store release is performed by these local steps.

### Pairing and session lifetime

Sign in to the website using the existing email OTP or guest flow, obtain beta approval as required, and complete profile setup. In Dashboard → Wallet, create an extension pairing code and enter the code and the corresponding HTTPS `*.convex.site` URL in the extension options. Pairing codes are single-use and expire after five minutes. The extension receives a dedicated random bearer credential; it persists in Chrome/Opera extension local storage across service-worker restarts and is restricted to trusted extension contexts. The backend validates the session on requests and enforces its maximum 30-day expiration, server-side revocation, beta approval and completed profile. Use **Abmelden und Erweiterungssitzung widerrufen** to revoke it. A transient network error retains the credential so it can be checked again; a confirmed 401 or local expiry clears it. Extension credentials are never placed in a URL, website local storage, or page-readable storage.

### YouTube purchases, unlocks, and local Flexible Usage testing

On supported YouTube watch and Shorts pages, the extension displays an estimate/interface only. Each account can set separate standard-video and Shorts rates (defaulting to 1.2 and 1.4 Coins per minute); the server validates and stores those rates and creates a short-lived price quote. A purchase is charged from that server quote, not from a client-supplied price, and the backend atomically records the debit, transaction, idempotency key and 30-day entitlement. The overlay is only a deterrence/interface feature: it does not control or bypass YouTube playback and cannot prevent access by other means. Changes in YouTube's DOM/layout may require extension updates.

Flexible Shorts Usage remains disabled by default and is only exposed by the extension when the server flag is enabled **and** the paired Convex HTTP Actions URL is a loopback local site (`http://127.0.0.1:3211` or `http://localhost:3211`). To test locally:

1. Start/select a Convex **local** development deployment for this project (`bunx convex deployment select local`, then `bunx convex dev`). Do not select a cloud or production deployment for billing tests.
2. In another terminal, set the opt-in on that local deployment only: `bunx convex env set FLEXIBLE_USAGE_ENABLED true --deployment local`. Restart/reload the local Convex development process if it does not pick up the change.
3. Start the website against that local deployment, pair the extension to the local HTTP Actions URL `http://127.0.0.1:3211` (or `http://localhost:3211`), and load/reload `extension/` as an unpacked extension. The extension's local HTTP host access is limited to loopback; it rejects non-local HTTP URLs.
4. Remove the opt-in when finished with `bunx convex env remove FLEXIBLE_USAGE_ENABLED --deployment local`.

The server independently fails closed unless `FLEXIBLE_USAGE_ENABLED=true` and its Convex runtime URL is loopback. Hosted/production runtimes therefore continue to return Flexible Usage as disabled regardless of the local opt-in. Flexible billing is based on server-authorized 10-second intervals and browser playback signals; those signals are not proof of actual viewing. The extension overlay is not server-enforced protection against bypassing the extension.

### Tests and checks

```sh
node --test extension/tests/*.test.js
bunx vitest run src/convex/access.test.ts src/convex/extension.test.ts
bunx eslint extension/src/content.js extension/src/service-worker.js extension/options/options.js extension/popup/popup.js extension/tests/*.test.js
bun run build
```

To regenerate Convex types locally without uploading functions, confirm the existing development deployment, then run `CONVEX_DEPLOYMENT=dev:useful-firefly-508 bunx convex codegen`; generated code is ignored by Git in this repository. Code generation requires Convex CLI authentication in the shell running it. `bunx convex dev` is not a code-generation-only command and uploads functions to the selected development deployment. Never select production for local verification. Tests use simulated browser APIs/Convex test contexts and do not prove real browser lifecycle behavior, real OTP email delivery, or a live deployment integration.


# Using Authentication (Important!)

You must follow these conventions when using authentication.

## Auth is already set up.

All convex authentication functions are already set up. The auth currently uses email OTP and anonymous users, but can support more.

The email OTP configuration is defined in `src/convex/auth/emailOtp.ts`. DO NOT MODIFY THIS FILE.

Also, DO NOT MODIFY THESE AUTH FILES: `src/convex/auth.config.ts` and `src/convex/auth.ts`.

## Using Convex Auth on the backend

On the `src/convex/users.ts` file, you can use the `getCurrentUser` function to get the current user's data.

## Using Convex Auth on the frontend

The `/auth` page is already set up to use auth. Navigate to `/auth` for all log in / sign up sequences.

You MUST use this hook to get user data. Never do this yourself without the hook:
```typescript
import { useAuth } from "@/hooks/use-auth";

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth();
```

## Protected Routes

The starter `/dashboard` route is protected with `RequireAuth`. Extend that page
for the product's authenticated experience, and reuse `RequireAuth` when adding
another protected route — do NOT hand-roll a redirect to `/auth`, since landing
on a bare sign-in form with no explanation of what was blocked is confusing.

`RequireAuth` states the block on the page the visitor asked for and sends them
to `/auth?returnTo=<current route>` when they choose to sign in, so they come
back to it. Pass `title` and `description` to say what the page is:

```tsx
<Route
  path="/dashboard"
  element={
    <RequireAuth
      title="Sign in to view your dashboard"
      description="Your projects and settings live here."
    >
      <Dashboard />
    </RequireAuth>
  }
/>
```

Pass `redirectImmediately` for a route where bouncing straight to `/auth` really
is better.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`.

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, you can use the `useAuth` hook to get the current user's data and authentication state.

You should also be protecting queries, mutations, and actions at the base level, checking for authorization securely.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.
- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.


## Landing Pages

You must always create good-looking designer-level styles to your application. 
- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.


### Other Items to animate
- Fade in and Fade Out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Three JS Graphics

Your app comes with three js by default. You can use it to create 3D graphics for landing pages, games, etc.


## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead. 

# Using the Convex backend

You will be implementing the convex backend. Follow your knowledge of convex and the documentation to implement the backend.

## The Convex Schema

You must correctly follow the convex schema implementation.

The schema is defined in `src/convex/schema.ts`.

Do not include the `_id` and `_creationTime` fields in your queries (it is included by default for each table).
Do not index `_creationTime` as it is indexed for you. Never have duplicate indexes.


## Convex Actions: Using CRUD operations

When running anything that involves external connections, you must use a convex action with "use node" at the top of the file.

You cannot have queries or mutations in the same file as a "use node" action file. Thus, you must use pre-built queries and mutations in other files.

You can also use the pre-installed internal crud functions for the database:

```ts
// in convex/users.ts
import { crud } from "convex-helpers/server/crud";
import schema from "./schema.ts";

export const { create, read, update, destroy } = crud(schema, "users");

// in some file, in an action:
const user = await ctx.runQuery(internal.users.read, { id: userId });

await ctx.runMutation(internal.users.update, {
  id: userId,
  patch: {
    status: "inactive",
  },
});
```


## Common Convex Mistakes To Avoid

When using convex, make sure:
- Document IDs are referenced as `_id` field, not `id`.
- Document ID types are referenced as `Id<"TableName">`, not `string`.
- Document object types are referenced as `Doc<"TableName">`.
- Keep schemaValidation to false in the schema file.
- You must correctly type your code so that it passes the type checker.
- You must handle null / undefined cases of your convex queries for both frontend and backend, or else it will throw an error that your data could be null or undefined.
- Always use the `@/folder` path, with `@/convex/folder/file.ts` syntax for importing convex files.
- This includes importing generated files like `@/convex/_generated/server`, `@/convex/_generated/api`
- Remember to import functions like useQuery, useMutation, useAction, etc. from `convex/react`
- NEVER have return type validators.

# Private Beta Access and Security

Focus Rewards temporarily requires explicit backend approval for all rewards functionality. The restriction is deliberately configurable and is enforced in Convex, not by the frontend. The existing `/auth` flow remains unchanged: Convex Auth provides email OTP and anonymous sign-in. `getAuthUserId(ctx)` obtains the user ID from the authenticated server identity; no client-supplied user ID is used as the current account.

## Configure the initial administrator

1. In the Convex dashboard, select and confirm the intended existing **development** deployment. The noted URL `https://useful-firefly-508.eu-west-1.convex.cloud` was a development URL and must not be assumed to be production.
2. In its **Settings → Environment Variables**, set `BETA_REQUIRE_APPROVAL=true`, `BETA_INVITATIONS_ENABLED=true`, and `BETA_ADMIN_EMAIL` to the exact email on your existing account. Keep `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`, `CONVEX_SITE_URL`, and the other existing auth settings configured as required. These are Convex server variables, never `VITE_` variables.
3. Deploy the backend to that selected development deployment through the authenticated Convex dashboard/CLI. No website deployment is part of these steps.
4. Sign in to the existing account through the normal email OTP page. The approval screen offers **Configure this existing account as administrator** only when the server-verified email matches `BETA_ADMIN_EMAIL`. Use it once; it sets the role and approval record on the same user and does not reset account data.
5. Open `/admin` to manage beta accounts.

This bootstrap checks the authenticated Convex Auth user and the server-side configured email; it does not guess a user ID or grant admin to the first registrant. Remove `BETA_ADMIN_EMAIL` after initial setup to disable this bootstrap path. Do not change or recreate your existing account.

## Grant access to a friend

In `/admin`, **Approve by email** pre-approves an address, including one whose owner has not signed in yet. Access takes effect only after the owner signs in with Convex Auth and verifies that email. You may revoke and restore that email-level permission under the same section; the server links it only to a matching verified account and invalidates extension sessions when revoked.

In **Invitation Codes**, create a single-use code. Leave the optional recipient email blank to make a shareable code for someone using **Continue without an email** (a guest account), or provide an email to bind the code to that verified email. Codes have 192 bits of randomness, are stored only as SHA-256 hashes, expire within seven days by default (up to 90 days), and at most ten outstanding codes per administrator are permitted. Share codes privately, never in URLs, source, or logs. A signed-in user enters the code at the beta-approval screen, and the server atomically claims it once. The invitation grants beta access only; it never assigns an administrator role.

A guest or email account can instead submit a manual approval request from the beta-approval screen. The requester must enter a name; the request is linked to that server-authenticated account, and administrators see the entered name under **User Access** before approving or revoking it. Access checks are enforced server-side. The initial administrator cannot revoke their own access; use another trusted administrator for recovery.

## Pause invitations or remove the beta gate later

- Pause new invitations by setting Convex deployment variable `BETA_INVITATIONS_ENABLED=false`. Existing invitations remain claimable until used, revoked, or expired. Set it to `true` to resume.
- When opening registration, set `BETA_REQUIRE_APPROVAL=false` in each intended Convex deployment using trusted deployment/dashboard access. This is the sole bypass; it is not exposed to clients. Authentication remains mandatory and per-user authorization/data scoping remain in force. Set it to `true` to restore approval checks.
- Do not delete the `betaAccess` table or user/reward data when the temporary restriction is lifted. Keeping it is safe and makes re-enabling the gate reversible. No account, wallet, task, reward, or transaction migration is needed.
- `BETA_REQUIRE_APPROVAL` defaults to required (fail-closed); `BETA_INVITATIONS_ENABLED` defaults to enabled. Never change these from browser code.

## Protection and limitations

All public reward queries and mutations use the shared approved-authenticated-user guard. The current-user profile query is also approval-gated while beta mode is on, with a narrow bootstrap exception for the configured verified administrator email so the existing account can load and complete one-time setup. That exception exposes only the current profile query; reward data remains blocked until approval. Auth framework HTTP endpoints remain limited to signing in/out. Database reads/writes are scoped to the server-derived user ID; task ownership, fixed reward catalog prices, balance sufficiency, and atomic wallet transactions remain backend-enforced. Convex mutations are transactional; transaction idempotency and purchase-per-reward checks prevent ordinary duplicate/replay purchases. Existing authenticated users and data are preserved by the bootstrap and revocation operations.

The extension's YouTube `/watch` and `/shorts/` overlay now offers a server-quoted, 30-day informational unlock. The server price is `YOUTUBE_UNLOCK_PRICE_COINS` (default `36`, valid integer range `1`–`10,000`); video duration is validated and stored as client-reported metadata but does not affect the fixed price, and it is not cryptographically attested. The overlay is a deterrence/UI feature only and does not block or bypass YouTube playback.

Extension pairing uses a server-bound five-minute single-use code from Dashboard → Wallet. The backend stores its hash, then the MV3 service worker redeems it over HTTPS and receives a random 256-bit bearer credential stored only in `chrome.storage.local` under `TRUSTED_CONTEXTS` access. The server enforces the session's maximum 30-day expiry, revocation, beta approval, and profile completion. The purchase endpoint resolves the account from that verified credential, charges the existing `accountData` wallet via an atomic Convex mutation, records `walletTransactions` and a `libraryPurchases` entitlement with a 30-day expiry, and is idempotent on retry. Valid entitlements are checked server-side before the overlay reports them. No website cookies or Convex deployment secrets are sent to the extension.

No deployment has been performed. Production deployment configuration, OTP delivery, the live existing account, multi-account production isolation, and the Cloudflare Pages state were not verifiable from this workspace. The public website must remain offline until you separately authorize redeployment. Do not commit `.env` or secret values.

### Security checks

- `bunx vitest run src/convex/access.test.ts src/convex/extension.test.ts` covers access restrictions and extension purchases: server pricing, existing-entitlement no-charge behavior, insufficient balance, expired/revoked sessions, per-user identity, concurrent wallet transactions, and replay idempotency.
- `node --test extension/tests/*.test.js` covers YouTube metadata/pricing, watch/Shorts navigation and overlay state, plus extension credential and purchase retry handling.
- `bunx eslint <changed paths>` and `bun run build` run lint and the TypeScript/Vite production build.
- Local Convex code generation completed successfully for the existing development deployment `dev:useful-firefly-508` in the user's already-authenticated local terminal; it generated local types and did not upload functions or deploy changes. The separate cloud workspace lacks Convex authentication (`CONVEX_ACCESS_TOKEN` / `CONVEX_DEPLOY_KEY`), so Convex CLI operations requiring deployment access cannot be run from that workspace. No `convex dev`, backend function upload, or production deployment was performed here.
