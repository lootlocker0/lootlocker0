import { describe, expect, it } from "vitest";
import { adminStockAdjustSchema, inventoryStockAdjustSchema } from "@/lib/validation";

describe("adminStockAdjustSchema", () => {
  it("keeps existing deltas as adjustments by default", () => {
    expect(adminStockAdjustSchema.parse({ delta: -2 })).toEqual({
      delta: -2,
      type: "ADJUSTMENT",
    });
  });

  it("accepts a negative signed inventory delta for stock deduction", () => {
    expect(inventoryStockAdjustSchema.safeParse({ delta: -2 }).success).toBe(true);
  });

  it("accepts a positive purchase with a non-negative integer unit cost", () => {
    expect(
      adminStockAdjustSchema.safeParse({
        delta: 5,
        type: "PURCHASE",
        unitCostCents: 125,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ delta: -1, type: "PURCHASE", unitCostCents: 100 }],
    [{ delta: 1, type: "PURCHASE" }],
    [{ delta: 1, type: "PURCHASE", unitCostCents: -1 }],
    [{ delta: 1, type: "PURCHASE", unitCostCents: 1.5 }],
    [{ delta: 1, type: "PURCHASE", unitCostCents: 2_147_483_648 }],
    [{ delta: 1, type: "ADJUSTMENT", unitCostCents: 100 }],
  ])("rejects invalid purchase/cost combinations: %o", (payload) => {
    expect(adminStockAdjustSchema.safeParse(payload).success).toBe(false);
  });
});