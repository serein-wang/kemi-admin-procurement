import assert from "node:assert/strict";
import test from "node:test";
import { boot, call, issueTermsPo, loginActors } from "./helpers.js";

test("TC-①-P-D-P2-short 预付小于票额时只付尾款", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-SHORT", amount: "100.00", tax: "0.00" },
    });
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/payment-approve`)).status, 200);
    assert.equal((await call(app, people.cashier, "POST", `/api/prepay/${created.body.id}/pay`, { bankRef: "BANK-SHORT" })).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/accrue`, { voucherRef: "VCH-SHORT" })).status, 200);
    assert.equal((await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" })).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/po/${po.id}/expense`)).status, 200);
    const invoice = await call(app, people.finance, "POST", "/api/invoices", {
      poId: po.id,
      invoiceNo: "INV-SHORT",
      invoiceType: "general",
      amount: "90.00",
      tax: "0.00",
    });
    assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
    assert.equal((await call(app, people.finance, "POST", "/api/matches", { poId: po.id })).status, 200);

    const settled = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/settle`);
    assert.equal(settled.body.status, "settled_with_balance");
    assert.equal(handle.store.pos.get(po.id)?.status, "matched");

    const tail = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(tail.status, 200, JSON.stringify(tail.body));
    assert.equal(tail.body.sourceType, "prepay_tail");
    assert.equal(tail.body.amount, "50.00");
    assert.notEqual(tail.body.amount, po.amount);
    const again = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "FULL_PAYMENT_EXCLUSIVE");
    assert.equal(handle.store.payments.size, 1);
    assert.equal([...handle.store.payments.values()].some((row) => row.sourceType === "po_balance"), false);

    const approved = await call(app, people.finance, "POST", `/api/payments/${tail.body.id}/finance-approve`);
    assert.equal(approved.body.status, "finance_approved");
    assert.equal((await call(app, people.admin, "POST", `/api/users/${people.finance.user.id}/roles`, {
      roles: ["finance", "cashier"],
    })).status, 200);
    const selfPay = await call(app, people.finance, "POST", `/api/payments/${tail.body.id}/pay`, { bankRef: "BANK-TAIL-SELF" });
    assert.equal(selfPay.status, 409);
    assert.equal(selfPay.body.sodViolationCode, "S2");
    const paid = await call(app, people.cashier, "POST", `/api/payments/${tail.body.id}/pay`, { bankRef: "BANK-TAIL" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "paid");
    assert.equal(handle.store.pos.get(po.id)?.status, "paid");
    assert.equal(handle.store.settleByPrepay(created.body.id)?.tailPayId, tail.body.id);
    assert.notEqual(paid.body.payerId, paid.body.voucherCreatorId);
  } finally {
    await app.close();
  }
});
