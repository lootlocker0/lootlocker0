import { describe, expect, it } from "vitest";
import {
  adminRecordSaleSchema,
  adminStockAdjustSchema,
  inventoryStockAdjustSchema,
} from "@/lib/validation";

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

describe("adminRecordSaleSchema", () => {
  const sale = {
    productId: "cmtlfpsen0001v57dkjtmrxpf",
    qty: 2,
    saleTotalCents: 475,
  };

  it("accepts a positive sold quantity and integer-cent sale total", () => {
    expect(adminRecordSaleSchema.safeParse(sale).success).toBe(true);
  });

  it.each([
    [{ ...sale, qty: 0 }],
    [{ ...sale, qty: -2 }],
    [{ ...sale, qty: 1.5 }],
    [{ ...sale, saleTotalCents: -1 }],
    [{ ...sale, saleTotalCents: 1.5 }],
    [{ ...sale, delta: 5 }],
  ])("rejects invalid or inventory-changing sale inputs: %o", (payload) => {
    expect(adminRecordSaleSchema.safeParse(payload).success).toBe(false);
  });
});