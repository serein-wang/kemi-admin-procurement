import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, issueTermsPo, loginActors } from "./helpers.js";

test("TC-①-P-D-P2-equal 预付等于正式票额则关闭且不再付款", async () => {
  const { app, handle, erp } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
    assert.equal(po.status, "awaiting_prepay");

    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-EQUAL", amount: "40.00", tax: "0.00" },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const proformaId = created.body.proformaInvoiceId as string;
    assert.equal(handle.store.invoices.get(proformaId)?.kind, "proforma");

    const submitted = await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const dept = await call(app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`);
    assert.equal(dept.body.status, "dept_approved");
    assert.equal(dept.body.financeGate, "skipped");
    assert.equal(dept.body.ceoGate, "skipped");
    const skips = auditsOf(handle, "PREPAY", created.body.id).filter((row) => row.skipped && row.skippedReason === "below_threshold");
    assert.equal(skips.length, 2);

    const tooSoon = await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" });
    assert.equal(tooSoon.status, 409);

    const approved = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/payment-approve`);
    const paid = await call(app, people.cashier, "POST", `/api/prepay/${created.body.id}/pay`, { bankRef: "BANK-EQUAL" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.notEqual(paid.body.applicantId, paid.body.paymentApproverId);
    assert.notEqual(paid.body.paymentApproverId, paid.body.payerId);
    assert.notEqual(paid.body.applicantId, paid.body.payerId);
    const accrued = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/accrue`, { voucherRef: "VCH-EQUAL" });
    assert.equal(accrued.body.status, "awaiting_delivery");
    assert.equal(accrued.body.accrualVoucherRef, "VCH-EQUAL");
    assert.equal(handle.store.pos.get(po.id)?.status, "awaiting_receipt");
    const accrualAudit = auditsOf(handle, "PREPAY", created.body.id).find((row) => row.toStatus === "accrued");
    assert.equal(accrualAudit?.comment.includes("不回写金蝶"), true);

    assert.equal((await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" })).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/po/${po.id}/expense`)).status, 200);
    assert.equal(erp.calls.length, 1);
    assert.equal(erp.calls[0]?.sessionKind, "admin_inbound");

    const earlyMatch = await call(app, people.finance, "POST", "/api/matches", { poId: po.id });
    assert.equal(earlyMatch.status, 422);
    assert.equal(earlyMatch.body.error, "FORMAL_INVOICE_REQUIRED");
    const proformaAttempt = await call(app, people.finance, "POST", "/api/invoices", {
      poId: po.id,
      invoiceNo: "PF-LATE",
      invoiceType: "proforma",
      amount: "40.00",
      tax: "0.00",
    });
    assert.equal(proformaAttempt.body.error, "PROFORMA_NOT_FOR_SETTLEMENT");

    const invoice = await call(app, people.finance, "POST", "/api/invoices", {
      poId: po.id,
      invoiceNo: "INV-EQUAL",
      invoiceType: "special",
      amount: "40.00",
      tax: "0.00",
    });
    assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
    assert.equal(invoice.body.kind, "formal");
    assert.equal(invoice.body.formalOf, proformaId);
    const match = await call(app, people.finance, "POST", "/api/matches", { poId: po.id });
    assert.equal(match.body.prepayAmount, "40.00");
    assert.equal(match.body.prepayId, created.body.id);

    const settled = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/settle`);
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.status, "settled_equal");
    assert.equal(handle.store.settles.values().next().value?.dp2Result, "equal");
    assert.equal(handle.store.pos.get(po.id)?.status, "closed");

    const blocked = await call(app, people.admin, "POST", "/api/payments", { poId: po.id });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "FULL_PAYMENT_EXCLUSIVE");
    assert.equal(handle.store.payments.size, 0);
    assert.equal(approved.body.paymentApproverId, people.finance.user.id);
  } finally {
    await app.close();
  }
});
