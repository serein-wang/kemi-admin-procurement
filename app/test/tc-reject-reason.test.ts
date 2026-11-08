import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { boot, call, createSubmitted, issueTermsPo, loginActors, type Session } from "./helpers.js";

interface TodoRow {
  entity: string;
  id: string;
  status: string;
  applicantId: string;
  rejectReason: string | null;
  queue: string;
}

async function todosOf(app: FastifyInstance, session: Session): Promise<TodoRow[]> {
  const response = await call(app, session, "GET", "/api/todos");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.todos as TodoRow[];
}

function findTodo(rows: TodoRow[], id: string): TodoRow | undefined {
  return rows.find((row) => row.id === id);
}

function loadPageFn(html: string, name: string): (...args: never[]) => unknown {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, name);
  const open = html.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, name);
  const source = html.slice(start, end + 1);
  return new Function(`${source}\nreturn ${name};`)() as (...args: never[]) => unknown;
}

test("走查页不缓存；待办按 queue 给出通过和驳回，驳回先打开理由框", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["cache-control"] ?? ""), /no-store/);
    const html = page.body;
    assert.match(html, /id="reject-modal"/);
    assert.match(html, /<textarea id="reject-reason"/);
    assert.match(html, /驳回理由窗口没有加载，请刷新页面后再试/);
    assert.match(html, /rejectModal\.hidden = false/);
    assert.match(html, /rejectModal\.style\.display = "grid"/);
    assert.match(html, /if \(REJECT_URL\[act\]\) \{\s*openReject\(REJECT_URL\[act\]\(id\)\);\s*return;\s*\}/);
    assert.equal(html.includes("row.financeGate"), false);
    assert.equal(html.includes("row.ceoGate"), false);
    const decision = html.match(/function todoDecision\(row\) \{[\s\S]*?\n    \}/);
    assert.ok(decision, "todoDecision missing");
    const body = decision[0];
    assert.match(body, /row\.queue !== "dept" && row\.queue !== "finance" && row\.queue !== "ceo"/);
    assert.match(body, /"PR:dept": \["dept-approve", "dept-reject"\]/);
    assert.match(body, /"PR:finance": \["finance-approve", "finance-reject"\]/);
    assert.match(body, /"PR:ceo": \["ceo-approve", "ceo-reject"\]/);
    assert.match(body, /"PREPAY:dept": \["prepay-dept", "prepay-dept-reject"\]/);
    assert.match(body, /"PRE:dept": \["pre-dept", "pre-dept-reject"\]/);
    assert.match(body, /"EXP:dept": \["exp-dept", "exp-dept-reject"\]/);
    assert.equal(body.includes("financeGate"), false);
    assert.equal(body.includes("ceoGate"), false);
    const todos = html.match(/function renderTodos\(\) \{[\s\S]*?\n    \}/);
    assert.ok(todos, "renderTodos missing");
    assert.match(todos[0], /splitTodos\(todos, selectedPath\)/);
    assert.match(todos[0], /todoEmptyLines\(split, returnedHint\)/);
    assert.equal(todos[0].includes("financeGate"), false);
    assert.equal(todos[0].includes("ceoGate"), false);
    const card = html.match(/function renderTodoCard\(row\) \{[\s\S]*?\n    \}/);
    assert.ok(card, "renderTodoCard missing");
    assert.match(card[0], /button\("通过", decision\[0\], row\.id\)/);
    assert.match(card[0], /button\("驳回", decision\[1\], row\.id, "danger"\)/);
    assert.match(card[0], /button\("编辑", "edit", row\.id, "ghost", row\.entity\)/);
    assert.match(card[0], /重新提交/);
    assert.match(card[0], /appendRejectReason\(block, row\)/);
    assert.equal(card[0].includes("financeGate"), false);
    assert.equal(card[0].includes("ceoGate"), false);
  } finally {
    await app.close();
  }
});

test("另一路径的驳回和草稿仍出现在待办，驳回人看到单据回到申请人", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    const html = page.body;
    const splitTodos = loadPageFn(html, "splitTodos") as (
      rows: Array<{ entity: string; id: string; queue: string; status: string }>,
      selectedPath: string,
    ) => { onPath: Array<{ id: string }>; heldOffPath: Array<{ id: string }> };
    const todoEmptyLines = loadPageFn(html, "todoEmptyLines") as (
      split: { onPath: unknown[]; heldOffPath: unknown[] },
      showReturnedHint: boolean,
    ) => string[];

    const rejectedPre = { entity: "PRE", id: "PRE-1", queue: "applicant", status: "rejected" };
    const draftPr = { entity: "PR", id: "PR-1", queue: "applicant", status: "draft" };
    const submittedPr = { entity: "PR", id: "PR-2", queue: "dept", status: "submitted" };
    const onCompany = splitTodos([rejectedPre, draftPr, submittedPr], "company");
    assert.deepEqual(onCompany.onPath.map((row) => row.id), ["PR-1", "PR-2"]);
    assert.deepEqual(onCompany.heldOffPath.map((row) => row.id), ["PRE-1"]);
    assert.deepEqual(todoEmptyLines(onCompany, false), []);

    const onlyOther = splitTodos([rejectedPre], "company");
    assert.deepEqual(onlyOther.onPath, []);
    assert.equal(onlyOther.heldOffPath.length, 1);
    assert.deepEqual(todoEmptyLines(onlyOther, false), [
      "当前路径没有待办；你还有 1 条驳回/草稿在另一路径（点返回重选路径）。",
    ]);

    const approver = splitTodos([], "company");
    assert.deepEqual(todoEmptyLines(approver, true), ["没有待办。", "驳回后单据回到申请人待办。"]);
    assert.deepEqual(todoEmptyLines(approver, false), ["没有待办。"]);

    const onReimburse = splitTodos([draftPr, rejectedPre], "reimburse");
    assert.deepEqual(onReimburse.onPath.map((row) => row.id), ["PRE-1"]);
    assert.deepEqual(onReimburse.heldOffPath.map((row) => row.id), ["PR-1"]);
    const hiddenQueue = splitTodos([submittedPr], "reimburse");
    assert.deepEqual(hiddenQueue.onPath, []);
    assert.deepEqual(hiddenQueue.heldOffPath, []);
    assert.deepEqual(todoEmptyLines(hiddenQueue, false), ["没有待办。"]);

    assert.match(html, /act === "switch-path"/);
    assert.match(html, /切到" \+ otherPathName\(selectedPath\)/);
    assert.match(html, /showReturnedHint = true/);
    assert.match(html, /appendRejectReason\(block, row\)/);
  } finally {
    await app.close();
  }
});

test("驳回不填理由失败；填写后请购回到申请人待办且理由可读", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pr = await createSubmitted(app, people.applicant, { qty: 1, estUnitPrice: "100.00", purpose: "待驳回请购" });
    assert.equal(findTodo(await todosOf(app, people.dept), pr.id)?.queue, "dept");
    assert.equal(findTodo(await todosOf(app, people.applicant), pr.id), undefined);

    for (const payload of [undefined, {}, { reason: "" }, { reason: "   " }, { comment: "\n\t" }]) {
      const rejected = await call(app, people.dept, "POST", `/api/pr/${pr.id}/dept-reject`, payload);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error, "REJECT_REASON_REQUIRED");
    }
    assert.equal(handle.store.prs.get(pr.id)?.status, "submitted");
    assert.equal([...handle.store.budgetHolds.values()].find((row) => row.sourceId === pr.id)?.status, "open");
    assert.equal(findTodo(await todosOf(app, people.dept), pr.id)?.queue, "dept");

    const tooLong = await call(app, people.dept, "POST", `/api/pr/${pr.id}/dept-reject`, { reason: "长".repeat(201) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, "INVALID_INPUT");
    assert.equal(handle.store.prs.get(pr.id)?.status, "submitted");

    const reason = "规格描述不完整";
    const rejected = await call(app, people.dept, "POST", `/api/pr/${pr.id}/dept-reject`, { comment: reason });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.status, "rejected");
    assert.equal(rejected.body.rejectReason, reason);
    assert.equal(rejected.body.reserveStatus, "released");

    const stored = await call(app, people.applicant, "GET", `/api/pr/${pr.id}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.rejectReason, reason);
    assert.equal(stored.body.status, "rejected");

    const applicantTodo = findTodo(await todosOf(app, people.applicant), pr.id);
    assert.ok(applicantTodo);
    assert.equal(applicantTodo.entity, "PR");
    assert.equal(applicantTodo.queue, "applicant");
    assert.equal(applicantTodo.status, "rejected");
    assert.equal(applicantTodo.rejectReason, reason);
    assert.equal(applicantTodo.applicantId, people.applicant.user.id);
    assert.equal(findTodo(await todosOf(app, people.dept), pr.id), undefined);
    assert.equal(findTodo(await todosOf(app, people.finance), pr.id), undefined);

    const again = await call(app, people.applicant, "POST", `/api/pr/${pr.id}/submit`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.status, "submitted");
    assert.equal(again.body.rejectReason, null);
    assert.equal(again.body.deptApproverId, null);
    assert.equal(findTodo(await todosOf(app, people.applicant), pr.id), undefined);
    assert.equal(findTodo(await todosOf(app, people.dept), pr.id)?.queue, "dept");
    const holds = [...handle.store.budgetHolds.values()].filter((row) => row.sourceId === pr.id);
    assert.equal(holds.filter((row) => row.status === "released").length, 1);
    assert.equal(holds.filter((row) => row.status === "open").length, 1);
  } finally {
    await app.close();
  }
});

test("财务驳回和总经理驳回同样要求理由并回到申请人待办", async () => {
  const { app } = await boot();
  try {
    const people = await loginActors(app);
    const mid = await createSubmitted(app, people.applicant, { qty: 1, estUnitPrice: "10000.00", purpose: "财务驳回" });
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${mid.id}/dept-approve`)).status, 200);
    assert.equal(findTodo(await todosOf(app, people.finance), mid.id)?.queue, "finance");
    const finMissing = await call(app, people.finance, "POST", `/api/pr/${mid.id}/finance-reject`, { reason: " " });
    assert.equal(finMissing.status, 400);
    assert.equal(finMissing.body.error, "REJECT_REASON_REQUIRED");
    const finReason = "超出本月预算";
    const finRejected = await call(app, people.finance, "POST", `/api/pr/${mid.id}/finance-reject`, { reason: finReason });
    assert.equal(finRejected.status, 200, JSON.stringify(finRejected.body));
    assert.equal(finRejected.body.rejectReason, finReason);
    assert.equal(findTodo(await todosOf(app, people.applicant), mid.id)?.rejectReason, finReason);
    assert.equal(findTodo(await todosOf(app, people.finance), mid.id), undefined);
    assert.equal((await call(app, people.applicant, "GET", `/api/pr/${mid.id}`)).body.rejectReason, finReason);

    const high = await createSubmitted(app, people.applicant, { qty: 1, estUnitPrice: "50000.00", purpose: "总经理驳回" });
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${high.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/pr/${high.id}/finance-approve`)).status, 200);
    assert.equal(findTodo(await todosOf(app, people.ceo), high.id)?.queue, "ceo");
    const ceoMissing = await call(app, people.ceo, "POST", `/api/pr/${high.id}/ceo-reject`);
    assert.equal(ceoMissing.status, 400);
    assert.equal(ceoMissing.body.error, "REJECT_REASON_REQUIRED");
    const ceoReason = "本期不采购";
    const ceoRejected = await call(app, people.ceo, "POST", `/api/pr/${high.id}/ceo-reject`, { reason: ceoReason });
    assert.equal(ceoRejected.body.status, "rejected");
    assert.equal(ceoRejected.body.rejectReason, ceoReason);
    assert.equal(findTodo(await todosOf(app, people.applicant), high.id)?.rejectReason, ceoReason);
    assert.equal(findTodo(await todosOf(app, people.ceo), high.id), undefined);
  } finally {
    await app.close();
  }
});

test("预付、事前和报销驳回必须有理由，并回到各自申请人待办", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);

    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "预付驳回" });
    const prepay = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-REJ", amount: "40.00", tax: "0.00" },
    });
    assert.equal(prepay.status, 200, JSON.stringify(prepay.body));
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${prepay.body.id}/submit`)).status, 200);
    assert.equal(findTodo(await todosOf(app, people.dept), prepay.body.id)?.queue, "dept");
    const prepayMissing = await call(app, people.dept, "POST", `/api/prepay/${prepay.body.id}/dept-reject`, { reason: "" });
    assert.equal(prepayMissing.status, 400);
    assert.equal(prepayMissing.body.error, "REJECT_REASON_REQUIRED");
    assert.equal(handle.store.prepays.get(prepay.body.id)?.status, "submitted");
    const prepayReason = "合同未盖章";
    const prepayRejected = await call(app, people.dept, "POST", `/api/prepay/${prepay.body.id}/dept-reject`, {
      reason: prepayReason,
    });
    assert.equal(prepayRejected.status, 200, JSON.stringify(prepayRejected.body));
    assert.equal(prepayRejected.body.rejectReason, prepayReason);
    const prepayTodo = findTodo(await todosOf(app, people.admin), prepay.body.id);
    assert.equal(prepayTodo?.queue, "applicant");
    assert.equal(prepayTodo?.rejectReason, prepayReason);
    assert.equal(prepayTodo?.applicantId, people.admin.user.id);
    assert.equal(findTodo(await todosOf(app, people.dept), prepay.body.id), undefined);
    assert.equal((await call(app, people.admin, "GET", `/api/prepay/${prepay.body.id}`)).body.prepay.rejectReason, prepayReason);
    const prepayAgain = await call(app, people.admin, "POST", `/api/prepay/${prepay.body.id}/submit`);
    assert.equal(prepayAgain.status, 200, JSON.stringify(prepayAgain.body));
    assert.equal(prepayAgain.body.status, "submitted");
    assert.equal(prepayAgain.body.rejectReason, null);
    assert.equal(findTodo(await todosOf(app, people.dept), prepay.body.id)?.queue, "dept");

    const pre = await call(app, people.applicant, "POST", "/api/pre", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "事前驳回",
      amount: "80.00",
    });
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${pre.body.id}/submit`)).status, 200);
    const preMissing = await call(app, people.dept, "POST", `/api/pre/${pre.body.id}/dept-reject`);
    assert.equal(preMissing.body.error, "REJECT_REASON_REQUIRED");
    const preReason = "事由不清晰";
    const preRejected = await call(app, people.dept, "POST", `/api/pre/${pre.body.id}/dept-reject`, { reason: preReason });
    assert.equal(preRejected.body.status, "rejected");
    assert.equal(preRejected.body.rejectReason, preReason);
    assert.equal(findTodo(await todosOf(app, people.applicant), pre.body.id)?.rejectReason, preReason);
    assert.equal(findTodo(await todosOf(app, people.dept), pre.body.id), undefined);
    assert.equal((await call(app, people.applicant, "GET", `/api/pre/${pre.body.id}`)).body.rejectReason, preReason);
    const preAgain = await call(app, people.applicant, "POST", `/api/pre/${pre.body.id}/submit`);
    assert.equal(preAgain.body.status, "submitted");
    assert.equal(preAgain.body.rejectReason, null);

    assert.equal((await call(app, people.dept, "POST", `/api/pre/${pre.body.id}/dept-approve`)).body.status, "approved");
    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: pre.body.id,
      purpose: "报销驳回",
      amount: "80.00",
      invoiceNos: ["EXP-REJ-1"],
      employeeAccount: "62220001",
    });
    assert.equal(expense.status, 200, JSON.stringify(expense.body));
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expense.body.id}/submit`)).status, 200);
    assert.equal(handle.store.pres.get(pre.body.id)?.status, "consumed_by_expense");
    const expMissing = await call(app, people.dept, "POST", `/api/exp/${expense.body.id}/dept-reject`, { reason: "  " });
    assert.equal(expMissing.status, 400);
    assert.equal(expMissing.body.error, "REJECT_REASON_REQUIRED");
    assert.equal(handle.store.expenses.get(expense.body.id)?.status, "submitted");
    assert.equal(handle.store.pres.get(pre.body.id)?.status, "consumed_by_expense");
    const expReason = "发票抬头不符";
    const expRejected = await call(app, people.dept, "POST", `/api/exp/${expense.body.id}/dept-reject`, { reason: expReason });
    assert.equal(expRejected.status, 200, JSON.stringify(expRejected.body));
    assert.equal(expRejected.body.rejectReason, expReason);
    assert.equal(handle.store.pres.get(pre.body.id)?.status, "approved");
    assert.equal(findTodo(await todosOf(app, people.applicant), expense.body.id)?.rejectReason, expReason);
    assert.equal(findTodo(await todosOf(app, people.dept), expense.body.id), undefined);
    assert.equal((await call(app, people.applicant, "GET", `/api/exp/${expense.body.id}`)).body.rejectReason, expReason);
    const expAgain = await call(app, people.applicant, "POST", `/api/exp/${expense.body.id}/submit`);
    assert.equal(expAgain.status, 200, JSON.stringify(expAgain.body));
    assert.equal(expAgain.body.status, "submitted");
    assert.equal(expAgain.body.rejectReason, null);
    assert.equal(handle.store.pres.get(pre.body.id)?.status, "consumed_by_expense");
    assert.equal(findTodo(await todosOf(app, people.dept), expense.body.id)?.queue, "dept");
  } finally {
    await app.close();
  }
});
