import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { boot, call, issueTermsPo, loginActors, type Session } from "./helpers.js";

async function todos(app: FastifyInstance, session: Session) {
  const response = await call(app, session, "GET", "/api/todos");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.todos as Array<{
    id: string;
    entity: string;
    status: string;
    queue: string;
    rejectReason: string | null;
    amount: string;
    title: string;
  }>;
}

async function approvedPre(
  app: FastifyInstance,
  people: Awaited<ReturnType<typeof loginActors>>,
  amount: string,
  purpose: string,
) {
  const created = await call(app, people.applicant, "POST", "/api/pre", {
    currency: "CNY",
    deptId: "D-ADMIN",
    purpose,
    amount,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await call(app, people.applicant, "POST", `/api/pre/${created.body.id}/submit`)).status, 200);
  const approved = await call(app, people.dept, "POST", `/api/pre/${created.body.id}/dept-approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body as { id: string; status: string };
}

test("申请人可以取消已驳回的请购、事前和报销", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);

    const pr = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "待取消请购",
      lines: [{ itemName: "笔", qty: 1, estUnitPrice: "100.00", category: "consumable" }],
    });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    const prId = pr.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${prId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${prId}/dept-reject`, { reason: "不买了" })).status, 200);
    const strangerPr = await call(app, people.dept, "POST", `/api/pr/${prId}/cancel`);
    assert.equal(strangerPr.status, 403);
    assert.equal(strangerPr.body.error, "FORBIDDEN_ROLE");
    const cancelledPr = await call(app, people.applicant, "POST", `/api/pr/${prId}/cancel`);
    assert.equal(cancelledPr.status, 200, JSON.stringify(cancelledPr.body));
    assert.equal(cancelledPr.body.status, "cancelled");
    const holds = [...handle.store.budgetHolds.values()].filter((row) => row.sourceId === prId);
    assert.equal(holds.length, 1);
    assert.equal(holds[0]?.releaseReason, "pr_rejected");
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${prId}/cancel`)).status, 409);

    const pre = await call(app, people.applicant, "POST", "/api/pre", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "待取消事前",
      amount: "80.00",
    });
    const preId = pre.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${preId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${preId}/dept-reject`, { reason: "事由不行" })).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${preId}/cancel`)).status, 403);
    const cancelledPre = await call(app, people.applicant, "POST", `/api/pre/${preId}/cancel`);
    assert.equal(cancelledPre.status, 200, JSON.stringify(cancelledPre.body));
    assert.equal(cancelledPre.body.status, "cancelled");

    const open = await approvedPre(app, people, "80.00", "报销取消用");
    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: open.id,
      purpose: "待取消报销",
      amount: "80.00",
      invoiceNos: ["EXP-CANCEL-REJ"],
      employeeAccount: "62220001",
    });
    const expId = expense.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${expId}/dept-reject`, { reason: "票不对" })).status, 200);
    assert.equal(handle.store.pres.get(open.id)?.status, "approved");
    assert.equal((await call(app, people.finance, "POST", `/api/exp/${expId}/cancel`)).status, 403);
    const cancelledExp = await call(app, people.applicant, "POST", `/api/exp/${expId}/cancel`);
    assert.equal(cancelledExp.status, 200, JSON.stringify(cancelledExp.body));
    assert.equal(cancelledExp.body.status, "cancelled");
    assert.equal(handle.store.pres.get(open.id)?.status, "approved");
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expId}/cancel`)).status, 409);

    const draftPre = await approvedPre(app, people, "40.00", "草稿报销");
    const draftExp = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: draftPre.id,
      purpose: "草稿直接取消",
      amount: "40.00",
      invoiceNos: ["EXP-CANCEL-DRAFT"],
      employeeAccount: "62220001",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${draftExp.body.id}/cancel`)).body.status, "cancelled");
    const later = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: draftPre.id,
      purpose: "部门已过不能取消",
      amount: "40.00",
      invoiceNos: ["EXP-CANCEL-LATE"],
      employeeAccount: "62220001",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${later.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${later.body.id}/dept-approve`)).status, 200);
    const blocked = await call(app, people.applicant, "POST", `/api/exp/${later.body.id}/cancel`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "INVALID_STATE");
  } finally {
    await app.close();
  }
});

test("预付只允许申请人取消草稿和已驳回，提交后不能取消", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "可取消预付" });
    const draft = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-CANCEL", amount: "40.00", tax: "0.00" },
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const draftId = draft.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/prepay/${draftId}/cancel`)).status, 403);
    const cancelledDraft = await call(app, people.admin, "POST", `/api/prepay/${draftId}/cancel`);
    assert.equal(cancelledDraft.status, 200, JSON.stringify(cancelledDraft.body));
    assert.equal(cancelledDraft.body.status, "cancelled");
    assert.equal([...handle.store.invoices.values()].some((row) => row.invoiceNo === "PF-CANCEL"), false);

    const again = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-CANCEL", amount: "40.00", tax: "0.00" },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const liveId = again.body.id as string;
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${liveId}/submit`)).status, 200);
    const afterSubmit = await call(app, people.admin, "POST", `/api/prepay/${liveId}/cancel`);
    assert.equal(afterSubmit.status, 409);
    assert.equal(afterSubmit.body.error, "INVALID_STATE");
    assert.equal(handle.store.prepays.get(liveId)?.status, "submitted");

    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${liveId}/dept-reject`, { reason: "先撤回" })).status, 200);
    assert.equal((await call(app, people.applicant, "POST", `/api/prepay/${liveId}/cancel`)).status, 403);
    const cancelledRejected = await call(app, people.admin, "POST", `/api/prepay/${liveId}/cancel`);
    assert.equal(cancelledRejected.body.status, "cancelled");
    const replacement = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "30.00",
      contractNo: "CT-AFTER-CANCEL",
    });
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  } finally {
    await app.close();
  }
});

test("已驳回报销的发票号仍被占用，修改和重新提交都要排除本单再查重", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const firstPre = await approvedPre(app, people, "80.00", "第一张票");
    const secondPre = await approvedPre(app, people, "80.00", "第二张票");
    const thirdPre = await approvedPre(app, people, "50.00", "已付款票");
    const held = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: firstPre.id,
      purpose: "占用发票",
      amount: "80.00",
      invoiceNos: ["INV-LOCK"],
      employeeAccount: "62220001",
    });
    const heldId = held.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${heldId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${heldId}/dept-reject`, { reason: "退回改票" })).status, 200);

    const blockedCreate = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: secondPre.id,
      purpose: "想用同一张票",
      amount: "80.00",
      invoiceNos: ["INV-LOCK"],
      employeeAccount: "62220001",
    });
    assert.equal(blockedCreate.status, 409);
    assert.equal(blockedCreate.body.error, "DUPLICATE_INVOICE");

    const keep = await call(app, people.applicant, "POST", `/api/exp/${heldId}/update`, {
      purpose: "仍用原票",
      amount: "80.00",
      invoiceNos: ["INV-LOCK"],
      employeeAccount: "62220001",
    });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.deepEqual(keep.body.invoiceNos, ["INV-LOCK"]);

    const other = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: secondPre.id,
      purpose: "另一张票",
      amount: "70.00",
      invoiceNos: ["INV-OTHER"],
      employeeAccount: "62220001",
    });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const otherId = other.body.id as string;
    const steal = await call(app, people.applicant, "POST", `/api/exp/${otherId}/update`, {
      purpose: "改去占用号",
      amount: "70.00",
      invoiceNos: ["INV-LOCK"],
      employeeAccount: "62220001",
    });
    assert.equal(steal.status, 409);
    assert.equal(steal.body.error, "DUPLICATE_INVOICE");

    const stored = handle.store.expenses.get(heldId);
    assert.ok(stored);
    stored.invoiceNos = ["INV-OTHER"];
    const resubmitBlocked = await call(app, people.applicant, "POST", `/api/exp/${heldId}/submit`);
    assert.equal(resubmitBlocked.status, 409);
    assert.equal(resubmitBlocked.body.error, "DUPLICATE_INVOICE");
    assert.equal(handle.store.expenses.get(heldId)?.status, "rejected");
    assert.equal(handle.store.pres.get(firstPre.id)?.status, "approved");
    assert.equal(handle.store.pres.get(firstPre.id)?.consumedByExpenseId, null);

    const fixed = await call(app, people.applicant, "POST", `/api/exp/${heldId}/update`, {
      purpose: "换成新票再交",
      amount: "80.00",
      invoiceNos: ["INV-LOCK-2"],
      employeeAccount: "62220001",
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const resubmitted = await call(app, people.applicant, "POST", `/api/exp/${heldId}/submit`);
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    assert.equal(resubmitted.body.status, "submitted");
    assert.deepEqual(resubmitted.body.invoiceNos, ["INV-LOCK-2"]);

    const paid = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: thirdPre.id,
      purpose: "付完的票",
      amount: "50.00",
      invoiceNos: ["INV-PAID"],
      employeeAccount: "62220001",
    });
    const paidId = paid.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${paidId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${paidId}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/exp/${paidId}/ticket-check`)).status, 200);
    assert.equal((await call(app, people.cashier, "POST", `/api/exp/${paidId}/pay`, { bankRef: "BANK-PAID" })).body.status, "paid");
    const fourthPre = await approvedPre(app, people, "50.00", "不能再用已付票");
    const paidDup = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: fourthPre.id,
      purpose: "重复已付票",
      amount: "50.00",
      invoiceNos: ["INV-PAID"],
      employeeAccount: "62220001",
    });
    assert.equal(paidDup.status, 409);
    assert.equal(paidDup.body.error, "DUPLICATE_INVOICE");

    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${otherId}/cancel`)).body.status, "cancelled");
    const reused = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: fourthPre.id,
      purpose: "用已取消报销的票号",
      amount: "50.00",
      invoiceNos: ["INV-OTHER"],
      employeeAccount: "62220001",
    });
    assert.equal(reused.status, 200, JSON.stringify(reused.body));
  } finally {
    await app.close();
  }
});

test("中额预付财务驳回、高额预付总经理驳回后可以修改再提交", async () => {
  const { app } = await boot();
  try {
    const people = await loginActors(app);

    const midPo = await issueTermsPo(app, people, { unitPrice: "10000.00", paymentTerms: "prepay", purpose: "中额驳回" });
    const mid = await call(app, people.admin, "POST", "/api/prepay", {
      poId: midPo.id,
      amount: "4000.00",
      proforma: { invoiceNo: "PF-MID-REJ", amount: "4000.00", tax: "0.00" },
    });
    const midId = mid.body.id as string;
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${midId}/submit`)).status, 200);
    const midDept = await call(app, people.dept, "POST", `/api/prepay/${midId}/dept-approve`);
    assert.equal(midDept.body.financeGate, "required");
    assert.equal(midDept.body.ceoGate, "skipped");
    assert.equal((await todos(app, people.finance)).find((row) => row.id === midId)?.queue, "finance");

    const midEmpty = await call(app, people.finance, "POST", `/api/prepay/${midId}/finance-reject`, { reason: "  " });
    assert.equal(midEmpty.status, 400);
    assert.equal(midEmpty.body.error, "REJECT_REASON_REQUIRED");
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${midId}/finance-reject`, { reason: "部门不能财务驳回" })).status, 403);
    const midRejected = await call(app, people.finance, "POST", `/api/prepay/${midId}/finance-reject`, { reason: "合同条款不清" });
    assert.equal(midRejected.status, 200, JSON.stringify(midRejected.body));
    assert.equal(midRejected.body.status, "rejected");
    assert.equal(midRejected.body.rejectReason, "合同条款不清");
    const applicantTodo = (await todos(app, people.admin)).find((row) => row.id === midId);
    assert.equal(applicantTodo?.queue, "applicant");
    assert.equal(applicantTodo?.rejectReason, "合同条款不清");
    assert.equal((await todos(app, people.finance)).find((row) => row.id === midId), undefined);

    const midEdited = await call(app, people.admin, "POST", `/api/prepay/${midId}/update`, {
      amount: "4500.00",
      proforma: { invoiceNo: "PF-MID-REJ", amount: "4500.00", tax: "0.00" },
    });
    assert.equal(midEdited.status, 200, JSON.stringify(midEdited.body));
    assert.equal(midEdited.body.status, "rejected");
    assert.equal(midEdited.body.amount, "4500.00");
    assert.equal(midEdited.body.rejectReason, "合同条款不清");
    const midAgain = await call(app, people.admin, "POST", `/api/prepay/${midId}/submit`);
    assert.equal(midAgain.status, 200, JSON.stringify(midAgain.body));
    assert.equal(midAgain.body.status, "submitted");
    assert.equal(midAgain.body.rejectReason, null);
    assert.equal(midAgain.body.amount, "4500.00");
    const midReapproved = await call(app, people.dept, "POST", `/api/prepay/${midId}/dept-approve`);
    assert.equal(midReapproved.body.financeGate, "required");
    assert.equal(midReapproved.body.ceoGate, "skipped");
    assert.equal(midReapproved.body.amount, "4500.00");
    const ceoTooSoon = await call(app, people.ceo, "POST", `/api/prepay/${midId}/ceo-reject`, { reason: "还没到总经理" });
    assert.equal(ceoTooSoon.status, 409);
    const cosigned = await call(app, people.finance, "POST", `/api/prepay/${midId}/finance-cosign`);
    assert.equal(cosigned.body.status, "finance_cosigned");
    const ceoSkipped = await call(app, people.ceo, "POST", `/api/prepay/${midId}/ceo-reject`, { reason: "未达阈" });
    assert.equal(ceoSkipped.status, 409);
    assert.equal(ceoSkipped.body.error, "INVALID_STATE");

    const lowPo = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "低额不能财务驳回" });
    const low = await call(app, people.admin, "POST", "/api/prepay", {
      poId: lowPo.id,
      amount: "40.00",
      contractNo: "CT-LOW",
    });
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${low.body.id}/submit`)).status, 200);
    const lowDept = await call(app, people.dept, "POST", `/api/prepay/${low.body.id}/dept-approve`);
    assert.equal(lowDept.body.financeGate, "skipped");
    const lowReject = await call(app, people.finance, "POST", `/api/prepay/${low.body.id}/finance-reject`, { reason: "不该出现" });
    assert.equal(lowReject.status, 409);
    assert.equal(lowReject.body.error, "INVALID_STATE");
    assert.equal(lowReject.body.message.includes("不需要财务加签"), true);

    const highPo = await issueTermsPo(app, people, { unitPrice: "30000.00", paymentTerms: "prepay", purpose: "高额驳回" });
    const high = await call(app, people.admin, "POST", "/api/prepay", {
      poId: highPo.id,
      amount: "20000.00",
      contractNo: "CT-HIGH",
    });
    const highId = high.body.id as string;
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${highId}/submit`)).status, 200);
    const highDept = await call(app, people.dept, "POST", `/api/prepay/${highId}/dept-approve`);
    assert.equal(highDept.body.financeGate, "required");
    assert.equal(highDept.body.ceoGate, "required");
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${highId}/finance-cosign`)).status, 200);
    assert.equal((await todos(app, people.ceo)).find((row) => row.id === highId)?.queue, "ceo");
    const highEmpty = await call(app, people.ceo, "POST", `/api/prepay/${highId}/ceo-reject`, {});
    assert.equal(highEmpty.status, 400);
    assert.equal(highEmpty.body.error, "REJECT_REASON_REQUIRED");
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${highId}/ceo-reject`, { reason: "财务不能代驳" })).status, 403);
    const highRejected = await call(app, people.ceo, "POST", `/api/prepay/${highId}/ceo-reject`, { reason: "超过预算" });
    assert.equal(highRejected.status, 200, JSON.stringify(highRejected.body));
    assert.equal(highRejected.body.status, "rejected");
    assert.equal(highRejected.body.rejectReason, "超过预算");
    assert.equal((await todos(app, people.admin)).find((row) => row.id === highId)?.queue, "applicant");
    assert.equal((await todos(app, people.ceo)).find((row) => row.id === highId), undefined);

    const highEdited = await call(app, people.admin, "POST", `/api/prepay/${highId}/update`, {
      amount: "21000.00",
      contractNo: "CT-HIGH-2",
    });
    assert.equal(highEdited.status, 200, JSON.stringify(highEdited.body));
    assert.equal(highEdited.body.amount, "21000.00");
    assert.equal(highEdited.body.contractNo, "CT-HIGH-2");
    assert.equal(highEdited.body.rejectReason, "超过预算");
    const highAgain = await call(app, people.admin, "POST", `/api/prepay/${highId}/submit`);
    assert.equal(highAgain.body.status, "submitted");
    assert.equal(highAgain.body.rejectReason, null);
    assert.equal(highAgain.body.amount, "21000.00");
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${highId}/dept-approve`)).body.ceoGate, "required");
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${highId}/finance-cosign`)).status, 200);
    const highApproved = await call(app, people.ceo, "POST", `/api/prepay/${highId}/ceo-approve`);
    assert.equal(highApproved.status, 200, JSON.stringify(highApproved.body));
    assert.equal(highApproved.body.status, "ceo_approved");
    assert.equal(highApproved.body.amount, "21000.00");
    assert.equal(highApproved.body.contractNo, "CT-HIGH-2");
  } finally {
    await app.close();
  }
});

test("财务审票可以带理由退回给申请人，改完再提交", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pre = await approvedPre(app, people, "80.00", "审票退回");
    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "旧票报销",
      amount: "80.00",
      invoiceNos: ["EXP-TICKET"],
      employeeAccount: "62220001",
    });
    const id = expense.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${id}/submit`)).status, 200);
    const tooEarly = await call(app, people.finance, "POST", `/api/exp/${id}/ticket-reject`, { reason: "还没到审票" });
    assert.equal(tooEarly.status, 409);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${id}/dept-approve`)).status, 200);
    assert.equal(handle.store.pres.get(pre.id)?.status, "consumed_by_expense");

    const empty = await call(app, people.finance, "POST", `/api/exp/${id}/ticket-reject`, { reason: "" });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "REJECT_REASON_REQUIRED");
    assert.equal(handle.store.expenses.get(id)?.status, "dept_approved");
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${id}/ticket-reject`, { reason: "申请人不能审票" })).status, 403);

    const returned = await call(app, people.finance, "POST", `/api/exp/${id}/ticket-reject`, { reason: "发票不合规" });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.status, "rejected");
    assert.equal(returned.body.rejectReason, "发票不合规");
    assert.equal(returned.body.financeGate, "pending");
    assert.equal(handle.store.pres.get(pre.id)?.status, "approved");
    assert.equal(handle.store.pres.get(pre.id)?.consumedByExpenseId, null);
    const mine = (await todos(app, people.applicant)).find((row) => row.id === id);
    assert.equal(mine?.queue, "applicant");
    assert.equal(mine?.rejectReason, "发票不合规");

    const edited = await call(app, people.applicant, "POST", `/api/exp/${id}/update`, {
      purpose: "换合规发票",
      amount: "60.00",
      invoiceNos: ["EXP-TICKET-2"],
      employeeAccount: "62228888",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rejectReason, "发票不合规");
    const again = await call(app, people.applicant, "POST", `/api/exp/${id}/submit`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.status, "submitted");
    assert.equal(again.body.rejectReason, null);
    assert.equal(again.body.purpose, "换合规发票");
    const deptTodo = (await todos(app, people.dept)).find((row) => row.id === id);
    assert.equal(deptTodo?.title, "换合规发票");
    assert.equal(deptTodo?.amount, "60.00");
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${id}/dept-approve`)).status, 200);
    const checked = await call(app, people.finance, "POST", `/api/exp/${id}/ticket-check`);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.status, "payment_approved");
  } finally {
    await app.close();
  }
});

test("走查页保留不缓存，并为取消、预付驳回和审票退回提供按钮", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["cache-control"] ?? ""), /no-store/);
    const html = page.body;
    assert.match(html, /id="reject-modal"/);
    assert.match(html, /\/api\/pr\/" \+ id \+ "\/update"/);
    assert.match(html, /"ready_for_po", "rejected"\]\.includes\(pr\.status\)/);
    assert.match(html, /pre\.status === "approved" \|\| pre\.status === "rejected"/);
    assert.match(html, /button\("取消预付", "prepay-cancel"/);
    assert.match(html, /button\("财务驳回", "prepay-finance-reject"/);
    assert.match(html, /button\("总经理驳回", "prepay-ceo-reject"/);
    assert.match(html, /button\("取消报销", "exp-cancel"/);
    assert.match(html, /button\("审票退回", "exp-ticket-reject"/);
    assert.match(html, /"prepay-finance-reject": \(id\) => "\/api\/prepay\/" \+ id \+ "\/finance-reject"/);
    assert.match(html, /"prepay-ceo-reject": \(id\) => "\/api\/prepay\/" \+ id \+ "\/ceo-reject"/);
    assert.match(html, /"exp-ticket-reject": \(id\) => "\/api\/exp\/" \+ id \+ "\/ticket-reject"/);
    assert.match(html, /"PREPAY:finance": \["prepay-fin", "prepay-finance-reject"\]/);
    assert.match(html, /"PREPAY:ceo": \["prepay-ceo", "prepay-ceo-reject"\]/);
    assert.match(html, /act === "prepay-cancel"/);
    assert.match(html, /act === "exp-cancel"/);
  } finally {
    await app.close();
  }
});
