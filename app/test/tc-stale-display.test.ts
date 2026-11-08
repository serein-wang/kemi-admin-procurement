import assert from "node:assert/strict";
import test from "node:test";
import { boot, call, createSubmitted, issueTermsPo, loginActors } from "./helpers.js";

function extractFn(html: string, name: string): string {
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
  return html.slice(start, end + 1);
}

function loadFns(html: string, names: string[]) {
  const source = names.map((name) => extractFn(html, name)).join("\n");
  return new Function(`${source}\nreturn { ${names.join(", ")} };`)() as {
    statusLabel: (code: string | null) => string;
    isEndedDoc: (kind: string, status: string) => boolean;
    rejectReasonVisible: (doc: { status?: string; rejectReason?: string | null } | null) => boolean;
    presentAuditRow: (row: {
      entity: string;
      entityId: string;
      docNo?: string;
      fromStatus: string | null;
      toStatus: string | null;
      comment: string;
      skipped?: boolean;
      sodViolationCode?: string;
    }) => { object: string; move: string; comment: string };
  };
}

test("取消后清掉驳回理由，按单号才能查到这张单据的流转", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);

    const pr = await createSubmitted(app, people.applicant, { qty: 1, estUnitPrice: "100.00", purpose: "待取消请购" });
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${pr.id}/dept-reject`, { reason: "规格不对" })).status, 200);
    const edited = await call(app, people.applicant, "POST", `/api/pr/${pr.id}/update`, {
      deptId: "D-ADMIN",
      purpose: "改完仍驳回",
      lines: [{ itemName: "显示器", qty: 1, estUnitPrice: "100.00", category: "consumable" }],
    });
    assert.equal(edited.body.rejectReason, "规格不对");
    const sameStatus = handle.store.audits.filter((row) => row.entity === "PR" && row.entityId === pr.id && row.fromStatus === row.toStatus);
    assert.ok(sameStatus.some((row) => row.fromStatus === "rejected"));

    const cancelledPr = await call(app, people.applicant, "POST", `/api/pr/${pr.id}/cancel`);
    assert.equal(cancelledPr.status, 200, JSON.stringify(cancelledPr.body));
    assert.equal(cancelledPr.body.status, "cancelled");
    assert.equal(cancelledPr.body.rejectReason, null);
    assert.equal((await call(app, people.applicant, "GET", `/api/pr/${pr.id}`)).body.rejectReason, null);
    assert.equal(handle.store.prs.get(pr.id)?.rejectReason, null);
    const todos = await call(app, people.applicant, "GET", "/api/todos");
    assert.equal((todos.body.todos as Array<{ id: string }>).some((row) => row.id === pr.id), false);

    const byNo = await call(app, people.applicant, "GET", `/api/audit?docNo=${encodeURIComponent(pr.id)}`);
    assert.equal(byNo.status, 200, JSON.stringify(byNo.body));
    assert.equal(byNo.body.entity, "PR");
    assert.equal(byNo.body.docNo, pr.id);
    assert.equal(byNo.body.status, "cancelled");
    assert.ok((byNo.body.audits as Array<{ toStatus: string }>).some((row) => row.toStatus === "cancelled"));
    assert.equal((byNo.body.audits as Array<{ entityId: string }>).every((row) => row.entityId === pr.id), true);

    const missing = await call(app, people.applicant, "GET", "/api/audit?docNo=NO-SUCH");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "NOT_FOUND");

    const pre = await call(app, people.applicant, "POST", "/api/pre", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "待取消事前",
      amount: "80.00",
    });
    const preId = pre.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${preId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${preId}/dept-reject`, { reason: "事由不行" })).status, 200);
    const cancelledPre = await call(app, people.applicant, "POST", `/api/pre/${preId}/cancel`);
    assert.equal(cancelledPre.body.status, "cancelled");
    assert.equal(cancelledPre.body.rejectReason, null);
    assert.equal((await call(app, people.applicant, "GET", `/api/audit?docNo=${preId}`)).body.entity, "PRE");

    const expensePre = await call(app, people.applicant, "POST", "/api/pre", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "报销取消用",
      amount: "80.00",
    });
    const expensePreId = expensePre.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${expensePreId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${expensePreId}/dept-approve`)).status, 200);
    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: expensePreId,
      purpose: "待取消报销",
      amount: "80.00",
      invoiceNos: ["EXP-STALE-1"],
      employeeAccount: "62220001",
    });
    const expId = expense.body.id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${expId}/dept-reject`, { reason: "票不对" })).status, 200);
    const cancelledExp = await call(app, people.applicant, "POST", `/api/exp/${expId}/cancel`);
    assert.equal(cancelledExp.body.status, "cancelled");
    assert.equal(cancelledExp.body.rejectReason, null);
    assert.equal((await call(app, people.applicant, "GET", `/api/audit?docNo=${expId}`)).body.entity, "EXP");

    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "预付取消" });
    const prepay = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      contractNo: "CT-STALE",
    });
    assert.equal(prepay.status, 200, JSON.stringify(prepay.body));
    const prepayId = prepay.body.id as string;
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${prepayId}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${prepayId}/dept-reject`, { reason: "比例不对" })).status, 200);
    const cancelledPrepay = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/cancel`);
    assert.equal(cancelledPrepay.body.status, "cancelled");
    assert.equal(cancelledPrepay.body.rejectReason, null);
    const prepayAudit = await call(app, people.admin, "GET", `/api/audit?docNo=${prepayId}`);
    assert.equal(prepayAudit.body.entity, "PREPAY");
    assert.equal(prepayAudit.body.status, "cancelled");
  } finally {
    await app.close();
  }
});

test("走查主列表只留当前状态，过期驳回、关卡和整表审计不铺在卡片上", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    const html = page.body;
    assert.match(html, /id="audit-query"/);
    assert.match(html, /按单号查询/);
    assert.match(html, /\/api\/audit\?docNo=/);
    assert.match(html, /已结束（/);
    assert.match(html, /toggle-ended/);
    assert.match(html, /rejectReasonVisible\(doc\)/);
    assert.match(html, /appendDetail\(parent, lines\)/);
    assert.equal(html.includes("workspace.audits"), false);
    assert.equal(html.includes('"请购 " + pr.status'), false);
    assert.equal(html.includes('财务关卡 " + pr.financeGate'), false);
    assert.equal(html.includes('财务关卡 " + prepay.financeGate'), false);
    assert.equal(html.includes('财务关卡 " + expense.financeGate'), false);
    assert.equal(html.includes('row.entity + " " + row.entityId'), false);
    const card = html.match(/function renderTodoCard\(row\) \{[\s\S]*?\n    \}/);
    assert.ok(card);
    assert.match(card[0], /appendRejectReason\(block, row\)/);
    assert.match(card[0], /statusLabel\(row\.status\)/);
    assert.equal(card[0].includes("financeGate"), false);

    const view = loadFns(html, [
      "statusLabel",
      "isEndedDoc",
      "rejectReasonVisible",
      "auditObjectLabel",
      "humanAuditComment",
      "presentAuditRow",
    ]);
    assert.equal(view.statusLabel("cancelled"), "已取消");
    assert.equal(view.statusLabel("submitted"), "待审批");
    assert.equal(view.statusLabel("rejected"), "已驳回");
    assert.equal(view.statusLabel(null), "—");

    assert.equal(view.isEndedDoc("PR", "cancelled"), true);
    assert.equal(view.isEndedDoc("PR", "closed_converted"), true);
    assert.equal(view.isEndedDoc("PR", "submitted"), false);
    assert.equal(view.isEndedDoc("PR", "rejected"), false);
    assert.equal(view.isEndedDoc("PO", "closed"), true);
    assert.equal(view.isEndedDoc("PO", "paid"), false);
    assert.equal(view.isEndedDoc("PRE", "consumed_by_expense"), true);
    assert.equal(view.isEndedDoc("PRE", "approved"), false);
    assert.equal(view.isEndedDoc("EXP", "paid"), true);
    assert.equal(view.isEndedDoc("EXP", "rejected"), false);
    assert.equal(view.isEndedDoc("PREPAY", "cancelled"), true);
    assert.equal(view.isEndedDoc("PREPAY", "chasing"), false);
    assert.equal(view.isEndedDoc("ASSET", "retired"), true);

    assert.equal(view.rejectReasonVisible({ status: "cancelled", rejectReason: "规格不对" }), false);
    assert.equal(view.rejectReasonVisible({ status: "paid", rejectReason: "规格不对" }), false);
    assert.equal(view.rejectReasonVisible({ status: "rejected", rejectReason: "  " }), false);
    assert.equal(view.rejectReasonVisible({ status: "rejected", rejectReason: "规格不对" }), true);
    assert.equal(view.rejectReasonVisible(null), false);

    const edited = view.presentAuditRow({
      entity: "PR",
      entityId: "PR-0034",
      fromStatus: "rejected",
      toStatus: "rejected",
      comment: "①-1 按驳回意见修改请购，尚未重新提交",
    });
    assert.equal(edited.object, "请购 PR-0034");
    assert.equal(edited.move, "修改");
    assert.equal(edited.comment, "按驳回意见修改请购，尚未重新提交");

    const resubmit = view.presentAuditRow({
      entity: "PR",
      entityId: "PR-0034",
      fromStatus: "rejected",
      toStatus: "submitted",
      comment: "①-1 驳回后重新提交；Q8 软占用",
    });
    assert.equal(resubmit.move, "已驳回 → 待审批");
    assert.equal(resubmit.comment, "驳回后重新提交");
    assert.equal(resubmit.comment.includes("Q8"), false);

    const rejected = view.presentAuditRow({
      entity: "PR",
      entityId: "PR-0013",
      fromStatus: "submitted",
      toStatus: "rejected",
      comment: "①-2 部门驳回；释放软占用；规格不对",
    });
    assert.equal(rejected.object, "请购 PR-0013");
    assert.equal(rejected.move, "待审批 → 已驳回");
    assert.equal(rejected.comment, "部门驳回；规格不对");

    const created = view.presentAuditRow({
      entity: "PRE",
      entityId: "PRE-0008",
      fromStatus: null,
      toStatus: "draft",
      comment: "②-1 创建事前申请草稿",
    });
    assert.equal(created.object, "事前 PRE-0008");
    assert.equal(created.move, "— → 草稿");
    assert.equal(created.comment, "创建事前申请草稿");

    const blocked = view.presentAuditRow({
      entity: "EXP",
      entityId: "EXP-0002",
      fromStatus: "submitted",
      toStatus: "submitted",
      comment: "S3 报销申请人不得担任部门审批人",
      sodViolationCode: "S3",
    });
    assert.equal(blocked.object, "报销 EXP-0002");
    assert.equal(blocked.move, "待审批 → 待审批 · S3");
    assert.equal(blocked.move.includes("修改"), false);
  } finally {
    await app.close();
  }
});
