import assert from "node:assert/strict";
import test from "node:test";
import { emptyThresholds } from "../src/domain/thresholds.js";
import { auditsOf, boot, call, FIXTURE_THRESHOLDS, loginActors } from "./helpers.js";

async function approvedPre(
  app: Awaited<ReturnType<typeof boot>>["app"],
  people: Awaited<ReturnType<typeof loginActors>>,
  amount: string,
  currency = "CNY",
) {
  const created = await call(app, people.applicant, "POST", "/api/pre", {
    companyCode: currency === "HKD" ? "HK" : "SZ",
    currency,
    deptId: "D-ADMIN",
    purpose: "垫付办公耗材",
    amount,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await call(app, people.applicant, "POST", `/api/pre/${created.body.id}/submit`)).status, 200);
  const approved = await call(app, people.dept, "POST", `/api/pre/${created.body.id}/dept-approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, "approved");
  return approved.body as { id: string; amount: string; status: string; currency: string };
}

test("TC-②-4-PRE-required 无事前或未批准都不能提报销", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const missing = await call(app, people.applicant, "POST", "/api/exp", {
      purpose: "打印纸",
      amount: "80.00",
      invoiceNos: ["EXP-NONE"],
      employeeAccount: "62220001",
    });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error, "PRE_REQUIRED");
    assert.equal(handle.store.expenses.size, 0);

    const draft = await call(app, people.applicant, "POST", "/api/pre", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "尚未批准",
      amount: "80.00",
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${draft.body.id}/submit`)).status, 200);
    const unapproved = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: draft.body.id,
      purpose: "打印纸",
      amount: "80.00",
      invoiceNos: ["EXP-WAIT"],
      employeeAccount: "62220001",
    });
    assert.equal(unapproved.status, 409);
    assert.equal(unapproved.body.error, "PRE_NOT_APPROVED");
    assert.equal(handle.store.expenses.size, 0);
    assert.equal(handle.store.pres.get(draft.body.id)?.status, "submitted");

    const pre = await approvedPre(app, people, "80.00");
    const created = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "打印纸",
      amount: "80.00",
      invoiceNos: ["EXP-OK"],
      employeeAccount: "62220001",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status, "draft");
    assert.equal(created.body.preApprovalId, pre.id);
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${pre.id}/cancel`)).status, 200);
    const submit = await call(app, people.applicant, "POST", `/api/exp/${created.body.id}/submit`);
    assert.equal(submit.status, 409);
    assert.equal(submit.body.error, "PRE_NOT_APPROVED");
    assert.equal(handle.store.expenses.get(created.body.id)?.status, "draft");
    assert.equal(handle.store.pres.get(pre.id)?.status, "cancelled");
  } finally {
    await app.close();
  }
});

test("TC-②-4 低额跳过加签并占用事前；第二张报销不能再提交", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pre = await approvedPre(app, people, "500.00");
    const first = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "硒鼓",
      amount: "120.00",
      invoiceNos: ["EXP-LOW-1"],
      employeeAccount: "62220001",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "另一笔",
      amount: "30.00",
      invoiceNos: ["EXP-LOW-2"],
      employeeAccount: "62220001",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const submitted = await call(app, people.applicant, "POST", `/api/exp/${first.body.id}/submit`);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(handle.store.pres.get(pre.id)?.status, "consumed_by_expense");
    assert.equal(handle.store.pres.get(pre.id)?.consumedByExpenseId, first.body.id);
    const again = await call(app, people.applicant, "POST", `/api/exp/${second.body.id}/submit`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "PRE_ALREADY_CONSUMED");
    assert.equal(handle.store.expenses.get(second.body.id)?.status, "draft");

    assert.equal((await call(app, people.dept, "POST", `/api/exp/${first.body.id}/dept-approve`)).status, 200);
    const checked = await call(app, people.finance, "POST", `/api/exp/${first.body.id}/ticket-check`);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.status, "payment_approved");
    assert.equal(checked.body.financeGate, "skipped");
    assert.equal(checked.body.ticketCheckerId, people.finance.user.id);
    const skip = auditsOf(handle, "EXP", first.body.id).find((row) => row.skipped);
    assert.equal(skip?.skippedReason, "below_threshold");
    assert.equal(skip?.toStatus, "payment_approved");
    const cosign = await call(app, people.finance, "POST", `/api/exp/${first.body.id}/finance-cosign`);
    assert.equal(cosign.status, 409);
    const paid = await call(app, people.cashier, "POST", `/api/exp/${first.body.id}/pay`, { bankRef: "BANK-EXP" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "paid");
    assert.equal(paid.body.payerId, people.cashier.user.id);
    assert.equal(handle.store.pres.get(pre.id)?.status, "consumed_by_expense");
    assert.equal(handle.store.pos.size, 0);
  } finally {
    await app.close();
  }
});

test("TC-②-7 超额必须加签，低额与超额按币种各自的限额", async () => {
  const thresholds = {
    ...emptyThresholds(),
    ...FIXTURE_THRESHOLDS,
    THR_CNY_REIM: "100.00",
    THR_HKD_REIM: "5000.00",
  };
  const { app, handle } = await boot({ thresholds });
  try {
    const people = await loginActors(app);
    const cny = await approvedPre(app, people, "200.00", "CNY");
    const hkd = await approvedPre(app, people, "200.00", "HKD");
    const over = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: cny.id,
      purpose: "CNY 超额",
      amount: "100.00",
      invoiceNos: ["EXP-CNY"],
      employeeAccount: "62220001",
    });
    const low = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: hkd.id,
      purpose: "HKD 低额",
      amount: "100.00",
      invoiceNos: ["EXP-HKD"],
      employeeAccount: "62220001",
    });
    assert.equal(over.status, 200, JSON.stringify(over.body));
    assert.equal(low.status, 200, JSON.stringify(low.body));
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${over.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${low.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${over.body.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${low.body.id}/dept-approve`)).status, 200);

    const overChecked = await call(app, people.finance, "POST", `/api/exp/${over.body.id}/ticket-check`);
    assert.equal(overChecked.body.status, "ticket_checked");
    assert.equal(overChecked.body.financeGate, "required");
    const payEarly = await call(app, people.cashier, "POST", `/api/exp/${over.body.id}/pay`, { bankRef: "TOO-SOON" });
    assert.equal(payEarly.status, 409);
    assert.equal(handle.store.expenses.get(over.body.id)?.status, "ticket_checked");
    assert.equal(handle.store.expenses.get(over.body.id)?.payerId, null);
    const cosigned = await call(app, people.finance, "POST", `/api/exp/${over.body.id}/finance-cosign`);
    assert.equal(cosigned.status, 200, JSON.stringify(cosigned.body));
    assert.equal(cosigned.body.status, "payment_approved");
    assert.equal(cosigned.body.financeGate, "approved");
    assert.equal(
      auditsOf(handle, "EXP", over.body.id).some((row) => row.skipped && row.skippedReason === "below_threshold"),
      false,
    );

    const lowChecked = await call(app, people.finance, "POST", `/api/exp/${low.body.id}/ticket-check`);
    assert.equal(lowChecked.body.status, "payment_approved");
    assert.equal(lowChecked.body.financeGate, "skipped");
    assert.equal(lowChecked.body.currency, "HKD");
    const paid = await call(app, people.cashier, "POST", `/api/exp/${over.body.id}/pay`, { bankRef: "BANK-OVER" });
    assert.equal(paid.body.status, "paid");
  } finally {
    await app.close();
  }
});

test("TC-②-5-S3-reject 与 TC-②-8-S2-reject 报销自批和审票人付款都被拒绝", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pre = await approvedPre(app, people, "3000.00");
    assert.equal(
      (
        await call(app, people.admin, "POST", `/api/users/${people.applicant.user.id}/roles`, {
          roles: ["applicant", "dept"],
        })
      ).status,
      200,
    );
    const selfPre = await call(app, people.applicant, "POST", "/api/pre", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "自批事前",
      amount: "50.00",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${selfPre.body.id}/submit`)).status, 200);
    const preRejected = await call(app, people.applicant, "POST", `/api/pre/${selfPre.body.id}/dept-approve`);
    assert.equal(preRejected.status, 409);
    assert.equal(preRejected.body.sodViolationCode, "S3");
    assert.equal(handle.store.pres.get(selfPre.body.id)?.status, "submitted");
    assert.equal(handle.store.pres.get(selfPre.body.id)?.deptApproverId, null);
    assert.ok(auditsOf(handle, "PRE", selfPre.body.id).some((row) => row.sodViolationCode === "S3"));

    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "超额耗材",
      amount: "2500.00",
      invoiceNos: ["EXP-SOD"],
      employeeAccount: "62220001",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expense.body.id}/submit`)).status, 200);
    const expRejected = await call(app, people.applicant, "POST", `/api/exp/${expense.body.id}/dept-approve`);
    assert.equal(expRejected.status, 409);
    assert.equal(expRejected.body.sodViolationCode, "S3");
    assert.equal(handle.store.expenses.get(expense.body.id)?.status, "submitted");
    assert.equal(handle.store.expenses.get(expense.body.id)?.deptApproverId, null);
    assert.ok(auditsOf(handle, "EXP", expense.body.id).some((row) => row.sodViolationCode === "S3"));

    assert.equal((await call(app, people.dept, "POST", `/api/exp/${expense.body.id}/dept-approve`)).status, 200);
    const checked = await call(app, people.finance, "POST", `/api/exp/${expense.body.id}/ticket-check`);
    assert.equal(checked.body.status, "ticket_checked");
    assert.equal((await call(app, people.finance, "POST", `/api/exp/${expense.body.id}/finance-cosign`)).status, 200);
    assert.equal(
      (
        await call(app, people.admin, "POST", `/api/users/${people.finance.user.id}/roles`, {
          roles: ["finance", "cashier"],
        })
      ).status,
      200,
    );
    const payRejected = await call(app, people.finance, "POST", `/api/exp/${expense.body.id}/pay`, { bankRef: "BANK-S2" });
    assert.equal(payRejected.status, 409);
    assert.equal(payRejected.body.sodViolationCode, "S2");
    assert.equal(handle.store.expenses.get(expense.body.id)?.status, "payment_approved");
    assert.equal(handle.store.expenses.get(expense.body.id)?.payerId, null);
    assert.ok(auditsOf(handle, "EXP", expense.body.id).some((row) => row.sodViolationCode === "S2"));
    const paid = await call(app, people.cashier, "POST", `/api/exp/${expense.body.id}/pay`, { bankRef: "BANK-OK" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "paid");
  } finally {
    await app.close();
  }
});

test("TC-②-D5 报销限额未配置时审票不改状态", async () => {
  const thresholds = { ...FIXTURE_THRESHOLDS, THR_CNY_REIM: null };
  const { app, handle } = await boot({ thresholds });
  try {
    const people = await loginActors(app);
    const pre = await approvedPre(app, people, "80.00");
    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.id,
      purpose: "限额未配置",
      amount: "80.00",
      invoiceNos: ["EXP-THR"],
      employeeAccount: "62220001",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expense.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${expense.body.id}/dept-approve`)).status, 200);
    const checked = await call(app, people.finance, "POST", `/api/exp/${expense.body.id}/ticket-check`);
    assert.equal(checked.status, 422);
    assert.equal(checked.body.error, "THRESHOLD_NOT_CONFIGURED");
    assert.equal(handle.store.expenses.get(expense.body.id)?.status, "dept_approved");
    assert.equal(handle.store.expenses.get(expense.body.id)?.ticketCheckerId, null);
  } finally {
    await app.close();
  }
});
