import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, createSubmitted, login } from "./helpers.js";

test("TC-① happy after_delivery 请购到付款", async () => {
  const { app, handle, erp } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const admin = await login(app, "uc-admin");
    const finance = await login(app, "uc-finance");
    const cashier = await login(app, "uc-cashier");

    const pr = await createSubmitted(app, applicant);
    assert.equal(pr.amount, "3000.00");
    assert.equal(handle.store.prs.get(pr.id)?.reserveStatus, "soft");

    const approved = await call(app, dept, "POST", `/api/pr/${pr.id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "sourcing");
    assert.equal(approved.body.financeGate, "skipped");
    assert.equal(approved.body.ceoGate, "skipped");
    assert.equal(approved.body.rfqRequired, true);
    const skips = auditsOf(handle, "PR", pr.id).filter((row) => row.skipped && row.skippedReason === "below_threshold");
    assert.equal(skips.length, 2);
    assert.ok(skips.some((row) => row.comment.includes("①-3")));
    assert.ok(skips.some((row) => row.comment.includes("①-4")));

    const quoted = await call(app, admin, "POST", `/api/pr/${pr.id}/rfq`, {
      quotes: [
        { vendorName: "供应商甲", amount: "2900.00", leadTimeDays: 7, selected: false },
        { vendorName: "供应商乙", amount: "3000.00", leadTimeDays: 5, selected: true },
        { vendorName: "供应商丙", amount: "3100.00", leadTimeDays: 9, selected: false },
      ],
    });
    assert.equal(quoted.body.status, "ready_for_po");

    const po = await call(app, admin, "POST", `/api/pr/${pr.id}/issue-po`, { paymentTerms: "after_delivery" });
    assert.equal(po.body.status, "awaiting_receipt");
    assert.equal(po.body.paymentTerms, "after_delivery");
    assert.equal(handle.store.prs.get(pr.id)?.status, "closed_converted");
    assert.notEqual(po.body.issuerId, applicant.user.id);

    const grn = await call(app, applicant, "POST", `/api/po/${po.body.id}/receive`, { result: "accepted" });
    assert.equal(grn.body.status, "confirmed");
    assert.equal(grn.body.accepterId, applicant.user.id);
    assert.notEqual(grn.body.accepterId, po.body.issuerId);
    assert.equal(handle.store.pos.get(po.body.id)?.status, "fully_received");
    assert.equal(handle.store.pos.get(po.body.id)?.disposition, "expense");

    const expense = await call(app, admin, "POST", `/api/po/${po.body.id}/expense`);
    assert.equal(expense.status, 200, JSON.stringify(expense.body));
    assert.equal(expense.body.dispositionDone, true);
    assert.equal(erp.calls.length, 1);
    assert.equal(erp.calls[0]?.sessionKind, "admin_inbound");
    assert.equal("cookie" in (erp.calls[0] ?? {}), false);
    assert.equal(erp.calls[0]?.lines[0]?.category, "consumable");

    const invoice = await call(app, finance, "POST", "/api/invoices", {
      poId: po.body.id,
      invoiceNo: "INV-HAPPY-1",
      invoiceType: "special",
      amount: "3000.00",
      tax: "390.00",
    });
    assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
    const match = await call(app, finance, "POST", "/api/matches", { poId: po.body.id });
    assert.equal(match.body.matchResult, "matched");
    assert.equal(match.body.matchedBy, finance.user.id);

    const requested = await call(app, admin, "POST", "/api/payments", { poId: po.body.id });
    assert.equal(requested.body.status, "submitted");
    assert.equal(requested.body.voucherCreatorId, finance.user.id);
    const payApproved = await call(app, finance, "POST", `/api/payments/${requested.body.id}/finance-approve`);
    assert.equal(payApproved.body.status, "finance_approved");
    const paid = await call(app, cashier, "POST", `/api/payments/${requested.body.id}/pay`, { bankRef: "BANK-HAPPY-1" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "paid");
    assert.equal(paid.body.payerId, cashier.user.id);
    assert.notEqual(paid.body.payerId, paid.body.voucherCreatorId);
    assert.equal(handle.store.pos.get(po.body.id)?.status, "paid");
  } finally {
    await app.close();
  }
});
