import { describe, it, expect } from "vitest";
// Imported directly from the formula module, not "@/lib/rewards" — that
// barrel also exports DB-touching helpers and would pull in lib/db.ts at
// import time, which throws without DATABASE_URL. This suite runs with
// QA_NO_SERVER=1 and no database at all (tests/setup/global-setup.ts).
import { pointsForSubtotal } from "@/lib/rewards-formula";

describe("pointsForSubtotal — pure, no floats, floors to the whole dollar", () => {
  it("earns the documented rate per whole dollar", () => {
    expect(pointsForSubtotal(300, 10)).toBe(30); // $3.00 -> 30
    expect(pointsForSubtotal(100, 10)).toBe(10); // $1.00 -> 10
  });

  it("floors a partial dollar rather than rounding it", () => {
    expect(pointsForSubtotal(199, 10)).toBe(10); // $1.99 earns as $1
    expect(pointsForSubtotal(99, 10)).toBe(0); // under a dollar earns nothing
  });

  it("is earned on subtotal, so the caller passing totalCents by mistake is the bug, not this function", () => {
    // This function does not know about tax; it multiplies whatever cents
    // figure it is given. Passing subtotalCents vs totalCents is the caller's
    // contract (checkout.ts §7/lib/rewards.ts docstring), not this function's.
    expect(pointsForSubtotal(0, 10)).toBe(0);
  });

  it("scales with the configured rate", () => {
    expect(pointsForSubtotal(500, 1)).toBe(5);
    expect(pointsForSubtotal(500, 0)).toBe(0);
    expect(pointsForSubtotal(500, 25)).toBe(125);
  });

  it("never produces a non-integer", () => {
    for (const cents of [1, 50, 99, 101, 12345, 999999]) {
      expect(Number.isInteger(pointsForSubtotal(cents, 10))).toBe(true);
    }
  });
});
