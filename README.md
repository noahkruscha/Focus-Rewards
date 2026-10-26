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

## Setup

This project is set up already and running on a cloud environment, as well as a convex development in the sandbox.

## Environment Variables

The project is set up with project specific CONVEX_DEPLOYMENT and VITE_CONVEX_URL environment variables on the client side.

The convex server has a separate set of environment variables that are accessible by the convex backend.

Currently, these variables include auth-specific keys: JWKS, JWT_PRIVATE_KEY, and SITE_URL.


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

## Invite and approve a friend

Your friend signs up/signs in through the existing email OTP flow, then opens the approval screen while signed in with the invited email. On `/admin`, enter that exact email and create an invitation. Convex generates 192-bit random codes using Web Crypto, persists only a SHA-256 hash, and binds each code to the normalized recipient email. Invitations expire after seven days, are single-use, and at most ten outstanding invitations per administrator are permitted. Share a code privately (never as a URL or in source/logs). A recipient must have a verified email matching the invitation to claim it. As an alternative, `/admin` lets you approve a signed-in account directly, without an email allowlist or manual database edits.

To revoke access, use `/admin` → **Revoke**. This immediately blocks future protected Convex operations and retains all the user's account data. Use **Revoke code** to invalidate an unclaimed invitation. The current administrator cannot revoke their own approval in the UI; keep a second trusted administrator or use the Convex dashboard for recovery. Anonymous accounts cannot claim invitations or be approved.

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
