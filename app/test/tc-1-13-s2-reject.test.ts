import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, createSubmitted, login, type Session } from "./helpers.js";
import type { FastifyInstance } from "fastify";

async function untilFinanceApproved(app: FastifyInstance, sessions: {
  applicant: Session;
  dept: Session;
  admin: Session;
  finance: Session;
}) {
  const pr = await createSubmitted(app, sessions.applicant);
  assert.equal((await call(app, sessions.dept, "POST", `/api/pr/${pr.id}/dept-approve`)).status, 200);
  const quoted = await call(app, sessions.admin, "POST", `/api/pr/${pr.id}/rfq`, {
    quotes: [
      { vendorName: "供应商甲", amount: "2900.00", leadTimeDays: 7, selected: false },
      { vendorName: "供应商乙", amount: "3000.00", leadTimeDays: 5, selected: true },
      { vendorName: "供应商丙", amount: "3100.00", leadTimeDays: 9, selected: false },
    ],
  });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  const po = await call(app, sessions.admin, "POST", `/api/pr/${pr.id}/issue-po`, { paymentTerms: "after_delivery" });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  const grn = await call(app, sessions.applicant, "POST", `/api/po/${po.body.id}/receive`, { result: "accepted" });
  assert.equal(grn.status, 200, JSON.stringify(grn.body));
  const expense = await call(app, sessions.admin, "POST", `/api/po/${po.body.id}/expense`);
  assert.equal(expense.status, 200, JSON.stringify(expense.body));
  const invoice = await call(app, sessions.finance, "POST", "/api/invoices", {
    poId: po.body.id,
    invoiceNo: `INV-${po.body.id}`,
    invoiceType: "special",
    amount: po.body.amount,
    tax: "390.00",
  });
  assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
  const match = await call(app, sessions.finance, "POST", "/api/matches", { poId: po.body.id });
  assert.equal(match.status, 200, JSON.stringify(match.body));
  const requested = await call(app, sessions.admin, "POST", "/api/payments", { poId: po.body.id });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const approved = await call(app, sessions.finance, "POST", `/api/payments/${requested.body.id}/finance-approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { paymentId: approved.body.id as string, voucherCreatorId: approved.body.voucherCreatorId as string };
}

test("TC-①-13-S2-reject 记账人不得付款", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const admin = await login(app, "uc-admin");
    const finance = await login(app, "uc-finance");
    const ready = await untilFinanceApproved(app, { applicant, dept, admin, finance });
    assert.equal(ready.voucherCreatorId, finance.user.id);

    const granted = await call(app, admin, "POST", `/api/users/${finance.user.id}/roles`, {
      roles: ["finance", "cashier"],
    });
    assert.equal(granted.status, 200);

    const rejected = await call(app, finance, "POST", `/api/payments/${ready.paymentId}/pay`, { bankRef: "BANK-1" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.sodViolationCode, "S2");
    assert.equal(handle.store.payments.get(ready.paymentId)?.status, "finance_approved");
    assert.equal(handle.store.payments.get(ready.paymentId)?.payerId, null);
    assert.ok(auditsOf(handle, "PAY", ready.paymentId).some((row) => row.sodViolationCode === "S2"));
  } finally {
    await app.close();
  }
});
