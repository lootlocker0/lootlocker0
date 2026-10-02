import { Resend } from "resend";
import { hashPii, logEvent } from "./log";

// Confirmation email — call sites live, delivery deliberately not built.
//
// backend.md §3 and §5 both call `sendConfirmationEmail(order.id)`. The call
// sites are real and are wired up here so that turning delivery on is one
// module, not an archaeology exercise across the checkout route and the webhook
// handler. What this does NOT do is send mail, and that is a decision rather
// than an omission:
//
//   · The recipients are children. CLAUDE.md §7 escalates "anything touching
//     school data policy or PII retention" to a human, and mailing a student's
//     name, pickup code, pickup location and allergen list to an address typed
//     into a public form is squarely that. Resend also retains message content;
//     who may read it is exactly the kind of question §7 says an agent does not
//     get to answer.
//   · RESEND_API_KEY is a placeholder in every environment that exists today,
//     so a "working" implementation would be untested against the real service.
//   · Nothing in the ordering flow depends on it. The pickup code is on the
//     confirmation screen; the confirmation screen is the receipt.
//
// So: this logs that a confirmation was due, and resolves. It never throws —
// no notification failure may ever break a checkout that already took money or
// already holds stock. `docs/API-CONTRACT.md` states plainly that no email is
// sent, so the UI does not tell a student to check an inbox that stays empty.
//
// See docs/HANDOFF.md, P3 item on notifications, for what implementing this
// needs (from-domain, template review, PII sign-off).

export interface NotifyResult {
  sent: boolean;
  reason: "not_implemented";
}

export async function sendConfirmationEmail(
  orderId: string,
): Promise<NotifyResult> {
  // orderId, never the email address or the student's name (CLAUDE.md §2.6).
  logEvent("confirmation_email_not_sent", { orderId, reason: "not_implemented" });
  return { sent: false, reason: "not_implemented" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome email — sent once, on genuine new-account creation only (password
// signup, or a Google sign-in that creates a brand-new account). Never on
// login, and never on a Google sign-in that links to an existing password
// account — see the call sites in app/api/account/signup/route.ts and
// app/api/account/google/callback/route.ts's `isNewAccount` signal.
//
// Unlike sendConfirmationEmail above, this one is real: the account owner
// made the CLAUDE.md §7 call to turn on delivery, and this email carries none
// of the harder PII sendConfirmationEmail would (no pickup code, no allergen
// data, no order details) — just an address the student typed in themselves
// moments earlier.
//
// Modes, resolved once per process — same shape as lib/rate-limit.ts's
// resolveMode() and lib/blob.ts's imageStorageMode:
//
//   resend    RESEND_API_KEY is real-shaped AND RESEND_FROM_ADDRESS is set.
//             Real delivery via Resend.
//   simulate  Either is missing/placeholder-shaped. Every call logs and
//             returns without sending. Deliberately NOT fail-closed like the
//             rate limiter — a missing key must never block account
//             creation. In production, simulate mode logs loudly
//             (welcome_email_simulated_in_production) so it cannot stay
//             silently mis-configured forever.

type EmailMode = "resend" | "simulate";

const API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? "";

function resolveEmailMode(): EmailMode {
  // Real Resend keys are shaped "re_...". Checked in tandem with an explicit
  // placeholder exclusion — same reasoning as lib/stripe/payments.ts's
  // SIMULATED flag — because tests/setup/env.ts's own placeholder value is
  // "re_placeholder", which would otherwise false-match a bare prefix test.
  const hasRealKey = /^re_/.test(API_KEY) && !/placeholder/i.test(API_KEY);
  return hasRealKey && FROM_ADDRESS ? "resend" : "simulate";
}

export const emailMode: EmailMode = resolveEmailMode();
logEvent("email_mode", { mode: emailMode });

let resendClient: Resend | null = null;
function client(): Resend {
  resendClient ??= new Resend(API_KEY);
  return resendClient;
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://lootlockers.shop";

function welcomeEmailText(recipientName: string | null): string {
  const greeting = recipientName ? `Hey ${recipientName},` : "Hey there,";
  return [
    greeting,
    "",
    "Your LootLockers account is ready. Order snacks online and pick them up at your locker — no more scrambling at the counter.",
    "",
    "Every order earns points too: 10 points per dollar spent, added automatically the moment your order is picked up. Check your balance anytime in The Locker.",
    "",
    `Start shopping: ${SITE_URL}`,
    "",
    "LootLockers — snacks made simple.",
    "Sullivan Heights Secondary School, 6248-144 Street, Surrey, BC V3X 1A1, Canada",
    "Questions? Just reply to this email.",
  ].join("\n");
}

function welcomeEmailHtml(recipientName: string | null): string {
  const greeting = recipientName ? `Hey ${escapeHtml(recipientName)},` : "Hey there,";
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Welcome to LootLockers</title>
  </head>
  <body style="margin:0;padding:0;background-color:#13131B;font-family:'Archivo Narrow',Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Your account's ready — order snacks, earn points at pickup.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#13131B;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding-bottom:24px;">
                <span style="font-size:20px;font-weight:700;letter-spacing:0.05em;color:#DDB7FF;">LOOT LOCKERS</span>
              </td>
            </tr>
            <tr>
              <td style="color:#E4E1EE;font-size:16px;line-height:1.6;">
                <p style="margin:0 0 16px;">${greeting}</p>
                <p style="margin:0 0 16px;">
                  Your LootLockers account is ready. Order snacks online and pick
                  them up at your locker &mdash; no more scrambling at the counter.
                </p>
                <p style="margin:0 0 24px;">
                  Every order earns points too: 10 points per dollar spent, added
                  automatically the moment your order is picked up. Check your
                  balance anytime in The Locker.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:32px;">
                <a href="${SITE_URL}" style="display:inline-block;background-color:#F5C518;color:#13131B;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:4px;">
                  Start Shopping
                </a>
              </td>
            </tr>
            <tr>
              <td style="color:#CFC2D6;font-size:12px;line-height:1.6;border-top:1px solid #2A2A35;padding-top:16px;">
                <p style="margin:0 0 4px;">LootLockers &mdash; snacks made simple.</p>
                <p style="margin:0 0 4px;">Sullivan Heights Secondary School, 6248-144 Street, Surrey, BC V3X 1A1, Canada</p>
                <p style="margin:0;">Questions? Just reply to this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface WelcomeEmailResult {
  sent: boolean;
  mode: EmailMode;
}

export async function sendWelcomeEmail(
  to: string,
  recipientName: string | null,
): Promise<WelcomeEmailResult> {
  const emailHash = hashPii(to); // never the raw address — CLAUDE.md §2.6
  if (emailMode === "simulate") {
    logEvent(
      process.env.NODE_ENV === "production"
        ? "welcome_email_simulated_in_production"
        : "welcome_email_simulated",
      { emailHash },
    );
    return { sent: false, mode: "simulate" };
  }
  try {
    await client().emails.send({
      from: FROM_ADDRESS,
      to,
      subject: "Welcome to LootLockers!",
      html: welcomeEmailHtml(recipientName),
      text: welcomeEmailText(recipientName),
    });
    logEvent("welcome_email_sent", { emailHash });
    return { sent: true, mode: "resend" };
  } catch (error) {
    // Never throws outward — account creation must succeed regardless of
    // Resend's availability, same philosophy as sendConfirmationEmail's two
    // call sites. Resend's own error shape is message/name only (no request
    // body echoed), but re-check this if a real error payload is ever seen
    // to differ, since email addresses must never reach a log line.
    logEvent("welcome_email_failed", { emailHash, error: String(error) });
    return { sent: false, mode: "resend" };
  }
}
