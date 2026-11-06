import assert from "node:assert/strict";
import test from "node:test";
import { boot, call, issueTermsPo, loginActors } from "./helpers.js";

async function overpayReady(app: Awaited<ReturnType<typeof boot>>["app"]) {
  const people = await loginActors(app);
  const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
  const created = await call(app, people.admin, "POST", "/api/prepay", {
    poId: po.id,
    amount: "40.00",
    proforma: { invoiceNo: `PF-${po.id}`, amount: "40.00", tax: "0.00" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`)).status, 200);
  assert.equal((await call(app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`)).status, 200);
  assert.equal((await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/payment-approve`)).status, 200);
  assert.equal((await call(app, people.cashier, "POST", `/api/prepay/${created.body.id}/pay`, { bankRef: "BANK-OVER" })).status, 200);
  assert.equal((await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/accrue`, { voucherRef: "VCH-OVER" })).status, 200);
  assert.equal((await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" })).status, 200);
  assert.equal((await call(app, people.admin, "POST", `/api/po/${po.id}/expense`)).status, 200);
  const invoice = await call(app, people.finance, "POST", "/api/invoices", {
    poId: po.id,
    invoiceNo: `INV-${po.id}`,
    invoiceType: "special",
    amount: "25.00",
    tax: "0.00",
  });
  assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
  assert.equal((await call(app, people.finance, "POST", "/api/matches", { poId: po.id })).status, 200);
  const settled = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/settle`);
  assert.equal(settled.body.status, "settling");
  return { people, po, prepayId: created.body.id as string };
}

test("TC-①-P-D-P2-over 溢付默认走退款且不再付款", async () => {
  const { app, handle } = await boot();
  try {
    const { people, po, prepayId } = await overpayReady(app);
    assert.equal(handle.store.settleByPrepay(prepayId)?.dp2Result, "over");
    const blocked = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "FULL_PAYMENT_EXCLUSIVE");

    const requested = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/refund`, { mode: "refund" });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.mode, "refund");
    assert.equal(requested.body.amount, "15.00");
    assert.equal(requested.body.status, "requested");
    const approved = await call(app, people.finance, "POST", `/api/prepay/${prepayId}/refund/approve`);
    assert.equal(approved.body.status, "finance_approved");
    const executed = await call(app, people.cashier, "POST", `/api/prepay/${prepayId}/refund/execute`, { bankRef: "BANK-REFUND" });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.status, "executed");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "settled_with_refund");
    assert.equal(handle.store.pos.get(po.id)?.status, "closed");
    assert.equal(handle.store.payments.size, 0);
  } finally {
    await app.close();
  }
});

test("TC-①-P10-suspense 挂账必须有财务原因码", async () => {
  const { app, handle } = await boot();
  try {
    const { people, po, prepayId } = await overpayReady(app);
    const missing = await call(app, people.finance, "POST", `/api/prepay/${prepayId}/refund`, { mode: "suspense" });
    assert.equal(missing.status, 400);
    assert.equal(handle.store.prepays.get(prepayId)?.status, "settling");
    const posted = await call(app, people.finance, "POST", `/api/prepay/${prepayId}/refund`, {
      mode: "suspense",
      reasonCode: "SUSPENSE_HOLD",
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.status, "finance_approved");
    assert.equal(posted.body.reasonCode, "SUSPENSE_HOLD");
    assert.equal(posted.body.financeApproverId, people.finance.user.id);
    const executed = await call(app, people.finance, "POST", `/api/prepay/${prepayId}/refund/execute`);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(handle.store.prepays.get(prepayId)?.status, "settled_with_refund");
    assert.equal(handle.store.pos.get(po.id)?.status, "closed");
    assert.equal(handle.store.payments.size, 0);
  } finally {
    await app.close();
  }
});
