e LootLockers Sign-In

This document records the account work implemented for **The Locker**, the setup required to run it, and the remaining work before production launch.

## Implemented

- Added `/locker` and linked **The Locker** from the shared shop header.
- Added email/password sign-in.
- Added separate account signup with:
  - Username
  - Email
  - Password
- Added **Continue with Google** OAuth entry point.
- Added server-side users in PostgreSQL.
- Added salted Node `scrypt` password hashing. Plaintext passwords are never stored.
- Added opaque, httpOnly `ll_account` sessions.
- Added database-backed session revocation on logout.
- Added current-account lookup through `/api/account/me`.
- Added Google OAuth state storage and one-time state consumption.
- Added `rewardPoints` to the account response and Locker profile view.
- Added the rewards display:
  - `$1.00 spent = 10 points`
  - `10 points = $0.10 off`
- Changed unconfigured Google OAuth failures from raw JSON to a redirect back to The Locker with a visible setup message.

## Code Changes

### Frontend

- `app/(shop)/locker/page.tsx`
  - Server page for The Locker.
  - Passes the OAuth configuration message into the client UI.

- `components/account/LockerSignIn.tsx`
  - Loads the current account from `/api/account/me`.
  - Renders email/password sign-in.
  - Renders signup mode with username, email, and password.
  - Renders the separate **Continue with Google** button.
  - Calls server logout and clears the signed-in UI only after logout succeeds.
  - Displays the account username, email, and reward balance.

- `components/layout/Nav.tsx`
  - Adds the **The Locker** header link.

### Backend

- `lib/account-auth.ts`
  - Password hashing and verification.
  - Account session creation, lookup, and revocation.
  - Session cookie creation and clearing.
  - Google OAuth configuration checks and state handling.

- `app/api/account/signup/route.ts`
  - Creates a password account.
  - Starts an authenticated session.

- `app/api/account/login/route.ts`
  - Verifies email/password credentials.
  - Starts an authenticated session.

- `app/api/account/me/route.ts`
  - Returns the authenticated account.

- `app/api/account/logout/route.ts`
  - Deletes the current server session.
  - Expires the `ll_account` cookie.
  - Does not require a valid session, so a broken or expired cookie can always be cleared.

- `app/api/account/google/start/route.ts`
  - Creates a one-time OAuth state.
  - Redirects to Google when configured.
  - Redirects back to `/locker?oauth=not_configured` when configuration is missing.

- `app/api/account/google/callback/route.ts`
  - Exchanges the authorization code with Google.
  - Verifies the Google profile and email.
  - Creates or links an account.
  - Starts the LootLockers account session.

- `lib/validation.ts`
  - Adds signup and login request validation.

- `lib/errors.ts`
  - Adds account and OAuth error codes.

### Database

- `prisma/schema.prisma`
  - Adds `User`.
  - Adds `AccountSession`.
  - Adds `OAuthState`.
  - Adds `rewardPoints` to `User`.

- `prisma/migrations/20260916000000_account_auth/migration.sql`
  - Creates the account, session, and OAuth state tables and indexes.

- `.env.example`
  - Documents the Google OAuth environment variables.

## API Contract

### `POST /api/account/signup`

Request:

```json
{
  "username": "locker_kid",
  "email": "student@example.com",
  "password": "at-least-8-chars"
}
```

Response:

```json
{
  "user": {
    "id": "cuid",
    "username": "locker_kid",
    "email": "student@example.com",
    "rewardPoints": 0
  }
}
```

### `POST /api/account/login`

Request:

```json
{
  "email": "student@example.com",
  "password": "at-least-1-char"
}
```

Successful response matches signup and sets `ll_account`.

### `GET /api/account/me`

Returns the current account when `ll_account` is valid. Returns `401` otherwise.

### `POST /api/account/logout`

Deletes the current server session and clears `ll_account`.

### `GET /api/account/google/start`

Starts Google OAuth when configured. If configuration is missing, redirects to:

```text
/locker?oauth=not_configured
```

### `GET /api/account/google/callback`

Google must redirect to this endpoint after authentication.

## Local Setup

1. Apply the database migration:

```bash
npx prisma migrate deploy
```

2. Regenerate the Prisma client after schema changes:

```bash
npx prisma generate
```

3. Add Google OAuth values to `.env.local`:

```env
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="http://localhost:3000/api/account/google/callback"
```

4. Restart Next.js:

```bash
npm run dev
```

## Google Cloud Setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Open **APIs & Services → OAuth consent screen**.
4. Configure the app as **External** for normal Gmail accounts.
5. Add a test user while the app is in testing mode.
6. Open **APIs & Services → Credentials**.
7. Select **Create Credentials → OAuth client ID**.
8. Choose **Web application**.
9. Add this authorized redirect URI for local development:

```text
http://localhost:3000/api/account/google/callback
```

10. Copy the client ID and client secret into `.env.local`.

For production, register the exact HTTPS callback URL:

```text
https://your-domain.com/api/account/google/callback
```

Never commit `.env.local` or expose `GOOGLE_CLIENT_SECRET` in client code.

## Verification

The following checks have been run:

```bash
npx prisma generate
npx prisma migrate deploy
npx tsc --noEmit
npx eslint components/account/LockerSignIn.tsx app/api/account/google/start/route.ts
```

The account lifecycle was also tested end to end:

1. Signup creates a database account.
2. Signup sets an authenticated session.
3. `/api/account/me` returns the account.
4. Logout returns success.
5. `/api/account/me` returns `401` after logout.
6. Google OAuth returns a configuration redirect when credentials are absent.

## Remaining Work

### Required before production

- Add production Google OAuth credentials.
- Add the production HTTPS redirect URI in Google Cloud Console.
- Set a production `NEXT_PUBLIC_SITE_URL`.
- Confirm the production database has the account migration applied.
- Confirm rate limiting is configured with Upstash Redis.
- Add account-focused automated tests for signup, login, duplicate email, duplicate username, invalid password, OAuth state replay, and logout revocation.
- Confirm the school privacy and retention policy for student account email addresses.

### Rewards functionality still needed

The account balance is stored and displayed, but reward earning and redemption are not yet connected to checkout.

Remaining rewards implementation:

- Associate completed orders with the signed-in `User`.
- Award points only after the order reaches the trusted payment state:
  - Card orders: after the Stripe webhook marks the order paid.
  - Cash orders: after staff records collection, if that is the approved policy.
- Use integer cents only. The initial earning rule is:

```text
pointsEarned = floor(eligibleOrderTotalCents / 100) * 10
```

- Make point awarding idempotent so webhook replay cannot award points twice.
- Add a rewards ledger rather than relying only on a mutable balance.
- Add redemption validation and server-side subtraction.
- Decide whether points apply to subtotal, tax-inclusive total, or another school-approved amount.
- Decide the expiration, refund, and cancellation rules for points.

These rewards policy decisions should be approved before connecting points to real orders.

## Security Notes

- Account cookies are httpOnly and `SameSite=Lax`.
- Passwords are salted and hashed with Node `scrypt`.
- Sessions store only a SHA-256 token hash in the database.
- Logout revokes the database session, not only the browser cookie.
- OAuth state is one-time and stored as a hash.
- Google OAuth is fail-closed when credentials are missing.
- No account password or OAuth secret belongs in client-side code, URLs, logs, or committed environment files.
