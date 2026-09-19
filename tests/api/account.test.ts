import { describe, it, expect, beforeEach } from "vitest";
import { testDb, resetDb } from "../setup/db";
import { BASE_URL } from "../setup/env";
import {
  checkoutPayload,
  getAccountMe,
  getAccountOrders,
  paymentIntentSucceeded,
  postCheckout,
  postWebhook,
  seedProduct,
  seedSlot,
  signupAccount,
} from "../helpers";

describe("account signup and login", () => {
  beforeEach(resetDb);

  it("creates an account, starts a session, and returns rewardPoints: 0", async () => {
    const account = await signupAccount({ username: "new_locker_kid" });
    expect(account.user.username).toBe("new_locker_kid");
    expect(account.user.rewardPoints).toBe(0);
    expect(account.cookie).toMatch(/^ll_account=/);

    const me = await getAccountMe(account.cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(account.user.id);
  });

  it("refuses a duplicate username or email with the documented codes", async () => {
    const first = await signupAccount({
      username: "taken_name",
      email: "taken@school.ca",
    });

    const res = await fetch(`${BASE_URL}/api/account/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "taken_name",
        email: "different@school.ca",
        password: "qa-password-1234",
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("USERNAME_TAKEN");

    const res2 = await fetch(`${BASE_URL}/api/account/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "different_name",
        email: "taken@school.ca",
        password: "qa-password-1234",
      }),
    });
    expect(res2.status).toBe(409);
    expect((await res2.json()).error.code).toBe("EMAIL_TAKEN");

    expect(first.user.username).toBe("taken_name"); // the original is untouched
  });

  it("logs in with the right password and refuses the wrong one identically to an unknown email", async () => {
    const account = await signupAccount({
      email: "login-test@school.ca",
      password: "correct-horse-battery",
    });

    const ok = await fetch(`${BASE_URL}/api/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login-test@school.ca", password: "correct-horse-battery" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.id).toBe(account.user.id);

    const wrongPassword = await fetch(`${BASE_URL}/api/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login-test@school.ca", password: "nope" }),
    });
    const unknownEmail = await fetch(`${BASE_URL}/api/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody-here@school.ca", password: "nope" }),
    });
    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(await wrongPassword.text()).toBe(await unknownEmail.text());
    expect((await fetch(`${BASE_URL}/api/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login-test@school.ca", password: "nope" }),
    }).then((r) => r.json())).error.code).toBe("ACCOUNT_UNAUTHORIZED");
  });

  it("logout revokes the session immediately, not just on cookie expiry", async () => {
    const account = await signupAccount();
    expect((await getAccountMe(account.cookie)).status).toBe(200);

    const logout = await fetch(`${BASE_URL}/api/account/logout`, {
      method: "POST",
      headers: { cookie: account.cookie },
    });
    expect(logout.status).toBe(200);

    // The client's copy of the cookie is unchanged (it never learns the value
    // was revoked) — this proves revocation is server-side, not just the
    // browser forgetting the cookie.
    expect((await getAccountMe(account.cookie)).status).toBe(401);
  });

  it("/api/account/me is 401 with no cookie and does not merely 500", async () => {
    const r = await getAccountMe();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("ACCOUNT_UNAUTHORIZED");
  });
});

describe("GET /api/account/orders", () => {
  beforeEach(resetDb);

  it("requires a session", async () => {
    const r = await getAccountOrders();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("ACCOUNT_UNAUTHORIZED");
  });

  it("lists only the signed-in account's own orders, most recent first", async () => {
    const account = await signupAccount();
    const slot = await seedSlot({ capacity: 10 });
    const productA = await seedProduct({ priceCents: 200, name: "First Item" });
    const productB = await seedProduct({ priceCents: 300, name: "Second Item" });

    const first = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: productA.id, qty: 1 }],
      }),
      { cookie: account.cookie },
    );
    expect(first.status).toBe(200);

    const second = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: productB.id, qty: 1 }],
      }),
      { cookie: account.cookie },
    );
    expect(second.status).toBe(200);

    const r = await getAccountOrders(account.cookie);
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(2);
    // Most recent first.
    expect(r.body.orders[0].orderNumber).toBe(second.body.orderNumber);
    expect(r.body.orders[1].orderNumber).toBe(first.body.orderNumber);
    expect(r.body.orders[0].items[0].nameSnapshot).toBe("Second Item");
  });

  it("never shows a guest order, or another account's order", async () => {
    const account = await signupAccount();
    const other = await signupAccount();
    const slot = await seedSlot({ capacity: 10 });
    const product = await seedProduct({ priceCents: 200 });

    // A guest order (no cookie at all).
    await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 1 }],
      }),
    );
    // Another account's order.
    await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 1 }],
      }),
      { cookie: other.cookie },
    );

    const r = await getAccountOrders(account.cookie);
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(0);
  });

  it("never returns studentName, email, phone, or homeroom", async () => {
    const account = await signupAccount();
    const slot = await seedSlot({ capacity: 10 });
    const product = await seedProduct({ priceCents: 200 });

    await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        studentName: "Priya Testerson",
        email: "priya.testerson@school.ca",
        phone: "604-555-0199",
        homeroom: "9B",
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 1 }],
      }),
      { cookie: account.cookie },
    );

    const r = await getAccountOrders(account.cookie);
    expect(r.status).toBe(200);
    for (const needle of ["Priya", "priya.testerson@school.ca", "604-555-0199", "9B"]) {
      expect(r.text, `response contained ${needle}`).not.toContain(needle);
    }
    expect(Object.keys(r.body.orders[0])).not.toContain("studentName");
    expect(Object.keys(r.body.orders[0])).not.toContain("email");
    expect(Object.keys(r.body.orders[0])).not.toContain("phone");
    expect(Object.keys(r.body.orders[0])).not.toContain("homeroom");
  });

  it("reflects status changes as an order moves through its lifecycle", async () => {
    const account = await signupAccount();
    const slot = await seedSlot({ capacity: 10 });
    const product = await seedProduct({ priceCents: 300 });

    const checkout = await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        paymentMethod: "CARD",
        items: [{ productId: product.id, qty: 1 }],
      }),
      { cookie: account.cookie },
    );
    expect(checkout.status).toBe(200);

    const beforePaid = await getAccountOrders(account.cookie);
    expect(beforePaid.body.orders[0].status).toBe("PENDING");
    expect(beforePaid.body.orders[0].paidAt).toBeNull();

    const order = await testDb.order.findUniqueOrThrow({
      where: { orderNumber: checkout.body.orderNumber },
    });
    await postWebhook(paymentIntentSucceeded(order.stripePaymentIntentId!, 300));

    const afterPaid = await getAccountOrders(account.cookie);
    expect(afterPaid.body.orders[0].status).toBe("PAID");
    expect(afterPaid.body.orders[0].paidAt).not.toBeNull();
  });

  it("shows no orders placed as a guest before the account existed — no retroactive linking by email", async () => {
    const slot = await seedSlot({ capacity: 10 });
    const product = await seedProduct({ priceCents: 200 });

    // A guest order placed with the SAME email a signup will later use.
    await postCheckout(
      checkoutPayload({
        slotId: slot.id,
        email: "future-member@school.ca",
        paymentMethod: "CASH_AT_PICKUP",
        items: [{ productId: product.id, qty: 1 }],
      }),
    );

    const account = await signupAccount({ email: "future-member@school.ca" });
    const r = await getAccountOrders(account.cookie);
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(0);
  });
});
