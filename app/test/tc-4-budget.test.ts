import assert from "node:assert/strict";
import test from "node:test";
import type { BudgetHold } from "../src/domain/types.js";
import type { ModuleHandle } from "../src/host.js";
import { boot, call, createSubmitted, issueTermsPo, login, loginActors } from "./helpers.js";

function holds(handle: ModuleHandle, sourceId?: string): BudgetHold[] {
  return [...handle.store.budgetHolds.values()].filter((row) => (sourceId ? row.sourceId === sourceId : true));
}

test("TC-Q8 请购软占用，驳回、财务驳回、总经理驳回和取消都释放", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const draft = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "未提交",
      budgetId: "BUD-DRAFT",
      lines: [{ itemName: "便签", qty: 1, estUnitPrice: "10.00", category: "consumable" }],
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.reserveStatus, "none");
    assert.equal(holds(handle, draft.body.id).length, 0);
    const draftCancelled = await call(app, people.applicant, "POST", `/api/pr/${draft.body.id}/cancel`);
    assert.equal(draftCancelled.body.status, "cancelled");
    assert.equal(draftCancelled.body.reserveStatus, "none");

    const rejected = await createSubmitted(app, people.applicant, {
      qty: 1,
      estUnitPrice: "100.00",
      purpose: "部门驳回",
      budgetId: "BUD-DEPT",
    });
    const soft = holds(handle, rejected.id);
    assert.equal(soft.length, 1);
    assert.equal(soft[0]?.kind, "soft");
    assert.equal(soft[0]?.status, "open");
    assert.equal(soft[0]?.amount, "100.00");
    assert.equal(soft[0]?.budgetId, "BUD-DEPT");
    assert.equal(soft[0]?.companyCode, "SZ");
    assert.equal(soft[0]?.currency, "CNY");
    const deptRejected = await call(app, people.dept, "POST", `/api/pr/${rejected.id}/dept-reject`);
    assert.equal(deptRejected.body.status, "rejected");
    assert.equal(deptRejected.body.reserveStatus, "released");
    assert.equal(holds(handle, rejected.id)[0]?.status, "released");
    assert.equal(holds(handle, rejected.id)[0]?.releaseReason, "pr_rejected");

    const mid = await createSubmitted(app, people.applicant, {
      qty: 1,
      estUnitPrice: "10000.00",
      purpose: "财务驳回",
      budgetId: "BUD-FIN",
    });
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${mid.id}/dept-approve`)).body.status, "dept_approved");
    const finRejected = await call(app, people.finance, "POST", `/api/pr/${mid.id}/finance-reject`);
    assert.equal(finRejected.status, 200, JSON.stringify(finRejected.body));
    assert.equal(finRejected.body.status, "rejected");
    assert.equal(finRejected.body.reserveStatus, "released");
    assert.equal(holds(handle, mid.id)[0]?.releaseReason, "pr_rejected");
    assert.equal(handle.store.prs.get(mid.id)?.status, "rejected");

    const high = await createSubmitted(app, people.applicant, {
      qty: 1,
      estUnitPrice: "50000.00",
      purpose: "总经理驳回",
      budgetId: "BUD-CEO",
    });
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${high.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/pr/${high.id}/finance-approve`)).status, 200);
    const ceoRejected = await call(app, people.ceo, "POST", `/api/pr/${high.id}/ceo-reject`);
    assert.equal(ceoRejected.body.status, "rejected");
    assert.equal(holds(handle, high.id)[0]?.status, "released");
    assert.equal(holds(handle, high.id)[0]?.releaseReason, "pr_rejected");

    const cancelled = await createSubmitted(app, people.applicant, {
      qty: 1,
      estUnitPrice: "80.00",
      purpose: "申请人取消",
      budgetId: "BUD-CANCEL",
    });
    const prCancelled = await call(app, people.applicant, "POST", `/api/pr/${cancelled.id}/cancel`);
    assert.equal(prCancelled.body.status, "cancelled");
    assert.equal(prCancelled.body.reserveStatus, "released");
    assert.equal(holds(handle, cancelled.id)[0]?.releaseReason, "pr_cancelled");
    const again = await call(app, people.applicant, "POST", `/api/pr/${cancelled.id}/cancel`);
    assert.equal(again.status, 409);
    assert.equal(holds(handle, cancelled.id).length, 1);
  } finally {
    await app.close();
  }
});

test("TC-Q8 下 PO 把软占用转成硬占用，取消或付款后关闭才释放", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "after_delivery", purpose: "可取消" });
    const stored = handle.store.pos.get(po.id);
    assert.ok(stored);
    assert.equal(stored.reserveStatus, "hard");
    assert.equal(handle.store.prs.get(stored.prId)?.reserveStatus, "hard");
    const soft = holds(handle, stored.prId)[0];
    const hard = holds(handle, po.id)[0];
    assert.equal(soft?.status, "converted");
    assert.equal(soft?.releaseReason, "converted_to_hard");
    assert.equal(hard?.kind, "hard");
    assert.equal(hard?.status, "open");
    assert.equal(hard?.amount, po.amount);
    assert.equal(hard?.linkedPrId, stored.prId);

    const cancelled = await call(app, people.admin, "POST", `/api/po/${po.id}/cancel`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.reserveStatus, "released");
    assert.equal(holds(handle, po.id)[0]?.releaseReason, "po_cancelled");
    assert.equal(handle.store.prs.get(stored.prId)?.reserveStatus, "released");

    const paidPo = await issueTermsPo(app, people, { unitPrice: "200.00", paymentTerms: "after_delivery", purpose: "付完关闭" });
    assert.equal((await call(app, people.applicant, "POST", `/api/po/${paidPo.id}/receive`, { result: "accepted" })).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/po/${paidPo.id}/expense`)).status, 200);
    assert.equal(
      (
        await call(app, people.finance, "POST", "/api/invoices", {
          poId: paidPo.id,
          invoiceNo: "INV-Q8-CLOSE",
          invoiceType: "special",
          amount: paidPo.amount,
          tax: "0.00",
        })
      ).status,
      200,
    );
    assert.equal((await call(app, people.finance, "POST", "/api/matches", { poId: paidPo.id })).status, 200);
    const payment = await call(app, people.admin, "POST", "/api/payments", { poId: paidPo.id });
    assert.equal((await call(app, people.finance, "POST", `/api/payments/${payment.body.id}/finance-approve`)).status, 200);
    assert.equal((await call(app, people.cashier, "POST", `/api/payments/${payment.body.id}/pay`, { bankRef: "BANK-Q8" })).status, 200);
    assert.equal(handle.store.pos.get(paidPo.id)?.status, "paid");
    assert.equal(holds(handle, paidPo.id)[0]?.status, "open");
    const closed = await call(app, people.admin, "POST", `/api/po/${paidPo.id}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "closed");
    assert.equal(closed.body.reserveStatus, "released");
    assert.equal(holds(handle, paidPo.id)[0]?.releaseReason, "po_closed");
    const listed = await call(app, people.finance, "GET", "/api/budget-holds");
    assert.equal(listed.body.holds.some((row: BudgetHold) => row.sourceId === paidPo.id && row.status === "released"), true);
  } finally {
    await app.close();
  }
});

test("预算编号不是合法钩子时不落单", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const rejected = await call(app, applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "坏预算号",
      budgetId: "预算 1",
      lines: [{ itemName: "笔", qty: 1, estUnitPrice: "1.00", category: "consumable" }],
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "INVALID_BUDGET");
    assert.equal(handle.store.prs.size, 0);
    assert.equal(handle.store.budgetHolds.size, 0);
  } finally {
    await app.close();
  }
});
