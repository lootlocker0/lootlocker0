import { describe, it, expect, vi, afterEach } from "vitest";
import { hashPii } from "@/lib/log";
import { emailMode, sendWelcomeEmail } from "@/lib/email";

/**
 * Simulate mode only, in this environment — same reasoning as
 * rate-limit.test.ts's "runs in memory mode here, not disabled" and
 * blob.test.ts's disk-mode assertion. tests/setup/env.ts and
 * tests/e2e/setup/env.ts both set RESEND_API_KEY to the placeholder
 * "re_placeholder", and RESEND_FROM_ADDRESS is never set in test env, so
 * emailMode must resolve to "simulate" — never a real network call in CI.
 */
describe("welcome email", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs in simulate mode here, not resend", () => {
    expect(emailMode).toBe("simulate");
  });

  it("never throws and reports simulate mode, with a recipient name", async () => {
    await expect(sendWelcomeEmail("student@example.com", "Alex")).resolves.toEqual({
      sent: false,
      mode: "simulate",
    });
  });

  it("never throws and reports simulate mode, with no recipient name", async () => {
    await expect(sendWelcomeEmail("student@example.com", null)).resolves.toEqual({
      sent: false,
      mode: "simulate",
    });
  });

  it("logs the hashed address, never the raw one", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const address = "priya.testerson@school.ca";

    await sendWelcomeEmail(address, "Priya");

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    const logged = lines.find((line) => line.includes("welcome_email_simulated"));
    expect(logged).toBeDefined();
    expect(logged).toContain(hashPii(address));
    expect(logged).not.toContain(address);
    expect(logged).not.toContain("Priya");
  });
});
