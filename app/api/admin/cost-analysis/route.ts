import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOLD_ORDER_STATUSES = [
  "RESERVED",
  "PAID",
  "PACKED",
  "PICKED_UP",
  "REFUNDED",
] as const;

function centsAsNumber(cents: bigint): number {
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new Error("Cost analysis exceeded safe integer-cent bounds");
  }
  return value;
}

function aggregatePurchaseRows(rows: PurchaseRow[]): PurchaseRow[] {
  const byProduct = new Map<string, PurchaseRow[]>();
  for (const row of rows) {
    const productRows = byProduct.get(row.productId) ?? [];
    productRows.push(row);
    byProduct.set(row.productId, productRows);
  }

  return [...byProduct.values()].map((productRows) => {
    const first = productRows.reduce((oldest, row) =>
      row.date < oldest.date ? row : oldest,
    );
    const lastUpdated = productRows.reduce(
      (latest, row) => (row.lastUpdated > latest ? row.lastUpdated : latest),
      first.lastUpdated,
    );
    const quantity = productRows.reduce((total, row) => total + row.quantity, 0);
    const quantityLeft = productRows.reduce((total, row) => total + row.quantityLeft, 0);
    const allCostsKnown = productRows.every((row) => row.totalCostCents !== null);
    const totalCost = allCostsKnown
      ? productRows.reduce((total, row) => total + BigInt(row.totalCostCents!), BigInt(0))
      : null;
    const projectedProfit = productRows.every((row) => row.projectedProfitCents !== null)
      ? productRows.reduce(
          (total, row) => total + BigInt(row.projectedProfitCents!),
          BigInt(0),
        )
      : null;
    const actualProfit = productRows.every((row) => row.actualProfitCents !== null)
      ? productRows.reduce(
          (total, row) => total + BigInt(row.actualProfitCents!),
          BigInt(0),
        )
      : null;

    return {
      ...first,
      id: first.productId,
      quantity,
      quantityLeft,
      totalCostCents: totalCost === null ? null : centsAsNumber(totalCost),
      unitCostCents:
        totalCost === null ? null : Math.round(centsAsNumber(totalCost) / quantity),
      projectedProfitCents:
        projectedProfit === null ? null : centsAsNumber(projectedProfit),
      actualProfitCents: actualProfit === null ? null : centsAsNumber(actualProfit),
      date: first.date,
      lastUpdated,
    };
  });
}

function allocateCentsByQuantity(amountCents: number, quantities: number[]): bigint[] {
  const weights = quantities.map((quantity) => BigInt(quantity));
  const zero = BigInt(0);
  const two = BigInt(2);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, zero);
  if (totalWeight === zero) return quantities.map(() => zero);

  const sign = amountCents < 0 ? BigInt(-1) : BigInt(1);
  const amount = BigInt(Math.abs(amountCents));
  let cumulativeWeight = zero;
  let allocated = zero;

  return weights.map((weight, index) => {
    cumulativeWeight += weight;
    const nextAllocated =
      index === weights.length - 1
        ? amount
        : (amount * cumulativeWeight + totalWeight / two) / totalWeight;
    const share = (nextAllocated - allocated) * sign;
    allocated = nextAllocated;
    return share;
  });
}

interface PurchaseRow {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  quantityLeft: number;
  totalCostCents: number | null;
  unitCostCents: number | null;
  currentSellingPriceCents: number;
  projectedProfitCents: number | null;
  actualProfitCents: number | null;
  date: string;
  lastUpdated: string;
}

interface Lot {
  purchase: PurchaseRow | null;
  quantity: number;
  quantityLeft: number;
  totalCostCents: bigint | null;
  costConsumedQty: number;
  costAllocatedCents: bigint;
  actualProfitCents: bigint | null;
}

interface OrderRow {
  orderNumber: string;
  date: string;
  itemsSold: number;
  cogsCents: number | null;
  revenueCents: number;
  profitCents: number | null;
  costBasisComplete: boolean;
}

interface SaleEvent {
  id: string;
  productId: string;
  createdAt: Date;
  qty: number;
  revenueCents: number | null;
  order: OrderRow | null;
  type: "PURCHASE" | "SALE" | "ADJUSTMENT" | "ORDER_SALE";
  qtyDelta: number;
  purchaseId?: string;
}

interface Consumption {
  lot: Lot | null;
  quantity: number;
}

function allocateLotCost(lot: Lot, quantity: number): bigint | null {
  if (lot.totalCostCents === null) return null;
  const nextQuantity = lot.costConsumedQty + quantity;
  const nextAllocated =
    (lot.totalCostCents * BigInt(nextQuantity) + BigInt(lot.quantity) / BigInt(2)) /
    BigInt(lot.quantity);
  const amount = nextAllocated - lot.costAllocatedCents;
  lot.costConsumedQty = nextQuantity;
  lot.costAllocatedCents = nextAllocated;
  return amount;
}

export async function GET(req: NextRequest) {
  try {
    requireAdminSession(req);

    const [purchaseEntries, stockTransactions, orders, products] = await Promise.all([
      db.stockTransaction.findMany({
        where: { type: "PURCHASE" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          productId: true,
          qtyDelta: true,
          unitCostCents: true,
          totalCostCents: true,
          createdAt: true,
          product: { select: { name: true, priceCents: true } },
        },
      }),
      db.stockTransaction.findMany({
        where: { type: { in: ["ADJUSTMENT", "SALE"] } },
        select: {
          id: true,
          productId: true,
          type: true,
          qtyDelta: true,
          saleTotalCents: true,
          createdAt: true,
        },
      }),
      db.order.findMany({
        where: { status: { in: [...SOLD_ORDER_STATUSES] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          orderNumber: true,
          status: true,
          createdAt: true,
          items: {
            select: {
              id: true,
              qty: true,
              unitPriceCents: true,
              productId: true,
              createdAt: true,
            },
          },
        },
      }),
      db.product.findMany({
        select: { id: true, name: true, stockQty: true },
      }),
    ]);

    const productsById = new Map(products.map((product) => [product.id, product]));
    const purchaseRowsById = new Map<string, PurchaseRow>();
    const purchaseLotsById = new Map<string, Lot>();
    const purchases = purchaseEntries.map((entry): PurchaseRow => {
      const quantity = entry.qtyDelta;
      const totalCostCents =
        entry.totalCostCents ??
        (entry.unitCostCents === null ? null : entry.unitCostCents * quantity);
      const unitCostCents =
        totalCostCents === null
          ? entry.unitCostCents
          : Math.round(totalCostCents / quantity);
      const date = entry.createdAt.toISOString();
      const row: PurchaseRow = {
        id: entry.id,
        productId: entry.productId,
        productName: entry.product.name,
        quantity,
        quantityLeft: quantity,
        totalCostCents,
        unitCostCents,
        currentSellingPriceCents: entry.product.priceCents,
        projectedProfitCents:
          totalCostCents === null
            ? null
            : quantity * entry.product.priceCents - totalCostCents,
        actualProfitCents: totalCostCents === null ? null : -totalCostCents,
        date,
        lastUpdated: date,
      };
      const cost = totalCostCents === null ? null : BigInt(totalCostCents);
      purchaseRowsById.set(entry.id, row);
      purchaseLotsById.set(entry.id, {
        purchase: row,
        quantity,
        quantityLeft: quantity,
        totalCostCents: cost,
        costConsumedQty: 0,
        costAllocatedCents: BigInt(0),
        actualProfitCents: cost === null ? null : -cost,
      });
      return row;
    });

    const orderRows: OrderRow[] = [];
    const events: SaleEvent[] = purchaseEntries.map((entry) => ({
      id: entry.id,
      productId: entry.productId,
      createdAt: entry.createdAt,
      qty: entry.qtyDelta,
      revenueCents: null,
      order: null,
      type: "PURCHASE",
      qtyDelta: entry.qtyDelta,
      purchaseId: entry.id,
    }));
    events.push(...stockTransactions.map((entry) => ({
      id: entry.id,
      productId: entry.productId,
      createdAt: entry.createdAt,
      qty: Math.abs(entry.qtyDelta),
      revenueCents: entry.type === "SALE" ? entry.saleTotalCents : null,
      order: null,
      type: entry.type,
      qtyDelta: entry.qtyDelta,
    })));
    for (const order of orders) {
      const row: OrderRow = {
        orderNumber: order.orderNumber,
        date: order.createdAt.toISOString(),
        itemsSold: order.items.reduce((sum, item) => sum + item.qty, 0),
        cogsCents: null,
        revenueCents: 0,
        profitCents: null,
        costBasisComplete: true,
      };
      orderRows.push(row);
      for (const item of order.items) {
        const revenueCents =
          order.status === "REFUNDED" ? 0 : item.unitPriceCents * item.qty;
        row.revenueCents += revenueCents;
        events.push({
          id: item.id,
          productId: item.productId,
          createdAt: item.createdAt,
          qty: item.qty,
          revenueCents,
          order: row,
          type: "ORDER_SALE",
          qtyDelta: -item.qty,
        });
      }
    }

    const eventsByProduct = new Map<string, SaleEvent[]>();
    for (const event of events) {
      const productEvents = eventsByProduct.get(event.productId) ?? [];
      productEvents.push(event);
      eventsByProduct.set(event.productId, productEvents);
    }

    for (const [productId, productEvents] of eventsByProduct) {
      productEvents.sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.type === "PURCHASE" ? -1 : b.type === "PURCHASE" ? 1 : 0) ||
          a.id.localeCompare(b.id),
      );
      const lots: Lot[] = [];
      const product = productsById.get(productId);
      const netLedgerDelta = productEvents.reduce(
        (sum, event) => sum + event.qtyDelta,
        0,
      );
      const openingUnknownQty = (product?.stockQty ?? 0) - netLedgerDelta;
      if (openingUnknownQty > 0) {
        lots.push({
          purchase: null,
          quantity: openingUnknownQty,
          quantityLeft: openingUnknownQty,
          totalCostCents: null,
          costConsumedQty: 0,
          costAllocatedCents: BigInt(0),
          actualProfitCents: null,
        });
      }

      const consume = (quantity: number, at: string): Consumption[] => {
        const consumed: Consumption[] = [];
        let remaining = quantity;
        for (const lot of lots) {
          if (remaining === 0) break;
          const taken = Math.min(remaining, lot.quantityLeft);
          if (taken === 0) continue;
          lot.quantityLeft -= taken;
          remaining -= taken;
          if (lot.purchase) {
            lot.purchase.quantityLeft = lot.quantityLeft;
            lot.purchase.lastUpdated = at;
          }
          consumed.push({ lot, quantity: taken });
        }
        if (remaining > 0) consumed.push({ lot: null, quantity: remaining });
        return consumed;
      };

      for (const event of productEvents) {
        const timestamp = event.createdAt.toISOString();
        if (event.type === "PURCHASE") {
          const lot = purchaseLotsById.get(event.purchaseId ?? event.id);
          if (lot) lots.push(lot);
          continue;
        }

        if (event.type === "ADJUSTMENT" && event.qtyDelta > 0) {
          lots.push({
            purchase: null,
            quantity: event.qtyDelta,
            quantityLeft: event.qtyDelta,
            totalCostCents: null,
            costConsumedQty: 0,
            costAllocatedCents: BigInt(0),
            actualProfitCents: null,
          });
          continue;
        }

        const consumed = consume(event.qty, timestamp);
        if (event.type === "ADJUSTMENT") continue;

        let cogsCents = BigInt(0);
        let costBasisComplete = true;
        for (const segment of consumed) {
          if (!segment.lot || segment.lot.totalCostCents === null) {
            costBasisComplete = false;
            continue;
          }
          cogsCents += allocateLotCost(segment.lot, segment.quantity) ?? BigInt(0);
        }
        if (event.order) {
          if (!costBasisComplete) {
            event.order.costBasisComplete = false;
          } else {
            const priorCogs = BigInt(event.order.cogsCents ?? 0);
            event.order.cogsCents = centsAsNumber(priorCogs + cogsCents);
          }
        }

        if (event.revenueCents !== null) {
          const revenueShares = allocateCentsByQuantity(
            event.revenueCents,
            consumed.map((segment) => segment.quantity),
          );
          consumed.forEach((segment, index) => {
            const lot = segment.lot;
            if (!lot?.purchase || lot.actualProfitCents === null) return;
            lot.actualProfitCents += revenueShares[index];
          });
        } else {
          for (const { lot } of consumed) {
            if (lot?.purchase) lot.actualProfitCents = null;
          }
        }
      }
    }

    for (const row of orderRows) {
      if (!row.costBasisComplete) {
        row.cogsCents = null;
        row.profitCents = null;
      } else {
        row.cogsCents ??= 0;
        row.profitCents = row.revenueCents - row.cogsCents;
      }
    }
    for (const [purchaseId, lot] of purchaseLotsById) {
      const row = purchaseRowsById.get(purchaseId);
      if (row) {
        row.quantityLeft = lot.quantityLeft;
        row.actualProfitCents =
          lot.actualProfitCents === null ? null : centsAsNumber(lot.actualProfitCents);
      }
    }
    const aggregatedPurchases = aggregatePurchaseRows(purchases);

    return Response.json(
      {
        purchases: aggregatedPurchases,
        orders: orderRows,
        products: products.map((product) => ({
          productId: product.id,
          productName: product.name,
          currentStockQty: product.stockQty,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
