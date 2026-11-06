import assert from "node:assert/strict";
import test from "node:test";
import { boot, call, issueTermsPo, loginActors } from "./helpers.js";

test("TC-①-P-exclusive 预付未结清前不能并行付全款", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });

    const before = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(before.status, 409);
    assert.equal(before.body.error, "FULL_PAYMENT_EXCLUSIVE");
    assert.equal(handle.store.payments.size, 0);

    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-LOCK", amount: "40.00", tax: "0.00" },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const whileDraft = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(whileDraft.body.error, "FULL_PAYMENT_EXCLUSIVE");

    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/payment-approve`)).status, 200);
    assert.equal((await call(app, people.cashier, "POST", `/api/prepay/${created.body.id}/pay`, { bankRef: "BANK-LOCK" })).status, 200);
    const accrued = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/accrue`, { voucherRef: "VCH-LOCK" });
    assert.equal(accrued.body.status, "awaiting_delivery");

    const afterPaid = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(afterPaid.status, 409);
    assert.equal(afterPaid.body.error, "FULL_PAYMENT_EXCLUSIVE");
    assert.equal(handle.store.payments.size, 0);
    assert.equal([...handle.store.payments.values()].some((row) => row.sourceType === "po_balance"), false);
    assert.equal(handle.store.prepays.get(created.body.id)?.status, "awaiting_delivery");
    assert.equal(handle.store.pos.get(po.id)?.status, "awaiting_receipt");
  } finally {
    await app.close();
  }
});
