import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { boot, call, issueTermsPo, loginActors, type Session } from "./helpers.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function dataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function todos(app: FastifyInstance, session: Session) {
  const response = await call(app, session, "GET", "/api/todos");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.todos as Array<{
    id: string;
    entity: string;
    title: string;
    amount: string;
    status: string;
    queue: string;
    rejectReason: string | null;
  }>;
}

test("走查页给草稿和已驳回单据编辑入口，提交按钮仍在", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["cache-control"] ?? ""), /no-store/);
    const html = page.body;
    assert.match(html, /id="edit-card"/);
    assert.match(html, /id="edit-form"/);
    assert.match(html, /button\("编辑", "edit", row\.id, "ghost", row\.entity\)/);
    assert.match(html, /button\("编辑", "edit", pr\.id, "ghost", "PR"\)/);
    assert.match(html, /button\("编辑", "edit", prepay\.id, "ghost", "PREPAY"\)/);
    assert.match(html, /button\("编辑", "edit", pre\.id, "ghost", "PRE"\)/);
    assert.match(html, /button\("编辑", "edit", expense\.id, "ghost", "EXP"\)/);
    assert.match(html, /\/api\/pr\/" \+ id \+ "\/update"/);
    assert.match(html, /\/api\/pre\/" \+ id \+ "\/update"/);
    assert.match(html, /\/api\/exp\/" \+ id \+ "\/update"/);
    assert.match(html, /\/api\/prepay\/" \+ id \+ "\/update"/);
    assert.match(html, /act === "edit"/);
    assert.match(html, /重新提交/);
    const forms = html.match(/<form id="(?:pr|pre)-form">[\s\S]*?<\/form>/g) ?? [];
    assert.equal(forms.length, 2);
    assert.equal((html.match(/currency:\s*"CNY"/g) ?? []).length, 2);
    assert.equal(html.includes('name="companyCode"'), false);
  } finally {
    await app.close();
  }
});

test("请购驳回后可改事由和明细，重新提交后审批人看到新内容，关卡按新金额重算", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "旧显示器",
      lines: [{
        itemName: "旧显示器",
        spec: "24 寸",
        purchaseUrl: "https://example.com/old",
        qty: 1,
        estUnitPrice: "50000.00",
        category: "consumable",
        images: [{ name: "old.png", dataUrl: dataUrl(PNG_1X1) }],
      }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;
    const imageId = created.body.lines[0].images[0].id as string;
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/pr/${id}/finance-approve`)).status, 200);
    const rejected = await call(app, people.ceo, "POST", `/api/pr/${id}/ceo-reject`, { reason: "规格不对" });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.financeGate, "approved");
    assert.equal(rejected.body.ceoGate, "required");
    assert.equal(rejected.body.amount, "50000.00");

    const stranger = await call(app, people.dept, "POST", `/api/pr/${id}/update`, {
      deptId: "D-ADMIN",
      purpose: "不该改成",
      lines: [{ itemName: "x", qty: 1, estUnitPrice: "1.00", category: "consumable" }],
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error, "FORBIDDEN_ROLE");
    assert.equal(handle.store.prs.get(id)?.purpose, "旧显示器");

    const updated = await call(app, people.applicant, "POST", `/api/pr/${id}/update`, {
      deptId: "D-IT",
      purpose: "新会议室屏幕",
      lines: [{
        itemName: "新屏幕",
        spec: "27 寸 4K",
        purchaseUrl: "https://example.com/new",
        qty: 2,
        estUnitPrice: "40.00",
        category: "low_value",
        images: [{ id: imageId, name: "old.png" }],
      }],
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.status, "rejected");
    assert.equal(updated.body.rejectReason, "规格不对");
    assert.equal(updated.body.purpose, "新会议室屏幕");
    assert.equal(updated.body.deptId, "D-IT");
    assert.equal(updated.body.amount, "80.00");
    assert.equal(updated.body.docType, "low_value");
    assert.equal(updated.body.financeGate, "pending");
    assert.equal(updated.body.ceoGate, "pending");
    assert.equal(updated.body.reserveStatus, "none");
    assert.equal(updated.body.deptApproverId, null);
    assert.equal(updated.body.lines[0].itemName, "新屏幕");
    assert.equal(updated.body.lines[0].spec, "27 寸 4K");
    assert.equal(updated.body.lines[0].purchaseUrl, "https://example.com/new");
    assert.equal(updated.body.lines[0].qty, 2);
    assert.equal(updated.body.lines[0].images[0].id, imageId);
    assert.equal(handle.store.images.has(imageId), true);

    const applicantTodo = (await todos(app, people.applicant)).find((row) => row.id === id);
    assert.equal(applicantTodo?.queue, "applicant");
    assert.equal(applicantTodo?.title, "新会议室屏幕");
    assert.equal(applicantTodo?.amount, "80.00");
    assert.equal(applicantTodo?.rejectReason, "规格不对");

    const locked = await call(app, people.applicant, "POST", `/api/pr/${id}/update`, {
      currency: "HKD",
      deptId: "D-IT",
      purpose: "不该换币",
      lines: [{ itemName: "新屏幕", qty: 1, estUnitPrice: "80.00", category: "low_value" }],
    });
    assert.equal(locked.status, 400);
    assert.equal(locked.body.error, "INVALID_CURRENCY");
    assert.equal(handle.store.prs.get(id)?.currency, "CNY");
    assert.equal(handle.store.prs.get(id)?.purpose, "新会议室屏幕");

    const again = await call(app, people.applicant, "POST", `/api/pr/${id}/submit`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.status, "submitted");
    assert.equal(again.body.rejectReason, null);
    assert.equal(again.body.amount, "80.00");
    assert.equal(again.body.purpose, "新会议室屏幕");
    const deptTodo = (await todos(app, people.dept)).find((row) => row.id === id);
    assert.equal(deptTodo?.title, "新会议室屏幕");
    assert.equal(deptTodo?.amount, "80.00");
    assert.equal(deptTodo?.rejectReason, null);
    const seen = await call(app, people.dept, "GET", `/api/pr/${id}`);
    assert.equal(seen.body.lines[0].spec, "27 寸 4K");
    assert.equal(seen.body.lines[0].itemName, "新屏幕");
    const approved = await call(app, people.dept, "POST", `/api/pr/${id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "sourcing");
    assert.equal(approved.body.financeGate, "skipped");
    assert.equal(approved.body.ceoGate, "skipped");
    assert.equal(approved.body.docType, "low_value");

    const immutable = await call(app, people.applicant, "POST", `/api/pr/${id}/update`, {
      deptId: "D-IT",
      purpose: "审批中不能改",
      lines: [{ itemName: "新屏幕", qty: 1, estUnitPrice: "80.00", category: "low_value" }],
    });
    assert.equal(immutable.status, 409);
    assert.equal(immutable.body.error, "INVALID_STATE");
    assert.match(immutable.body.message, /sourcing/);
  } finally {
    await app.close();
  }
});

test("请购草稿改字段后再提交，贴图可保留也可换掉", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "草稿事由",
      lines: [{
        itemName: "纸",
        spec: "A4",
        qty: 1,
        estUnitPrice: "10.00",
        category: "consumable",
        images: [{ name: "a.png", dataUrl: dataUrl(PNG_1X1) }],
      }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;
    const oldImage = created.body.lines[0].images[0].id as string;
    const replaced = await call(app, people.applicant, "POST", `/api/pr/${id}/update`, {
      purpose: "改后的草稿",
      deptId: "D-ADMIN",
      lines: [{
        itemName: "彩纸",
        spec: "A3 彩色",
        purchaseUrl: "https://example.com/paper",
        qty: 3,
        estUnitPrice: "12.50",
        category: "consumable",
        images: [{ name: "b.png", dataUrl: dataUrl(PNG_1X1) }],
      }],
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.status, "draft");
    assert.equal(replaced.body.amount, "37.50");
    assert.equal(replaced.body.purpose, "改后的草稿");
    assert.notEqual(replaced.body.lines[0].images[0].id, oldImage);
    assert.equal(handle.store.images.has(oldImage), false);
    assert.equal(handle.store.images.has(replaced.body.lines[0].images[0].id), true);
    const submitted = await call(app, people.applicant, "POST", `/api/pr/${id}/submit`);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.amount, "37.50");
    assert.equal(submitted.body.lines[0].spec, "A3 彩色");
    const foreign = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "另一张",
      lines: [{ itemName: "笔", qty: 1, estUnitPrice: "2.00", category: "consumable" }],
    });
    const stolen = await call(app, people.applicant, "POST", `/api/pr/${foreign.body.id}/update`, {
      purpose: "另一张",
      deptId: "D-ADMIN",
      lines: [{
        itemName: "笔",
        qty: 1,
        estUnitPrice: "2.00",
        category: "consumable",
        images: [{ id: replaced.body.lines[0].images[0].id }],
      }],
    });
    assert.equal(stolen.status, 400);
    assert.equal(stolen.body.error, "INVALID_INPUT");
    assert.equal(handle.store.prs.get(foreign.body.id)?.lines[0].images.length, 0);
  } finally {
    await app.close();
  }
});

test("事前与报销：草稿可改，驳回后改完再提交，审批人看到新事由和金额", async () => {
  const { app } = await boot();
  try {
    const people = await loginActors(app);
    const draft = await call(app, people.applicant, "POST", "/api/pre", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "旧事前",
      amount: "80.00",
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const preId = draft.body.id as string;
    const edited = await call(app, people.applicant, "POST", `/api/pre/${preId}/update`, {
      deptId: "D-FIN",
      purpose: "改后的事前",
      amount: "120.00",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.status, "draft");
    assert.equal(edited.body.amount, "120.00");
    assert.equal(edited.body.purpose, "改后的事前");
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${preId}/submit`)).status, 200);
    const empty = await call(app, people.dept, "POST", `/api/pre/${preId}/dept-reject`, { reason: " " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "REJECT_REASON_REQUIRED");
    const rejected = await call(app, people.dept, "POST", `/api/pre/${preId}/dept-reject`, { reason: "事由不清" });
    assert.equal(rejected.body.rejectReason, "事由不清");
    const revised = await call(app, people.applicant, "POST", `/api/pre/${preId}/update`, {
      deptId: "D-FIN",
      purpose: "补齐事由的事前",
      amount: "90.00",
    });
    assert.equal(revised.body.status, "rejected");
    assert.equal(revised.body.rejectReason, "事由不清");
    assert.equal(revised.body.amount, "90.00");
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${preId}/update`, {
      deptId: "D-FIN",
      purpose: "别人改",
      amount: "1.00",
    })).status, 403);
    const resubmitted = await call(app, people.applicant, "POST", `/api/pre/${preId}/submit`);
    assert.equal(resubmitted.body.status, "submitted");
    assert.equal(resubmitted.body.rejectReason, null);
    assert.equal(resubmitted.body.purpose, "补齐事由的事前");
    const deptTodo = (await todos(app, people.dept)).find((row) => row.id === preId);
    assert.equal(deptTodo?.title, "补齐事由的事前");
    assert.equal(deptTodo?.amount, "90.00");
    assert.equal((await call(app, people.dept, "POST", `/api/pre/${preId}/dept-approve`)).body.status, "approved");
    assert.equal((await call(app, people.applicant, "POST", `/api/pre/${preId}/update`, {
      deptId: "D-FIN",
      purpose: "已批准不能改",
      amount: "90.00",
    })).status, 409);

    const expense = await call(app, people.applicant, "POST", "/api/exp", {
      preApprovalId: preId,
      purpose: "旧报销",
      amount: "90.00",
      invoiceNos: ["EXP-EDIT-1"],
      employeeAccount: "62220001",
    });
    assert.equal(expense.status, 200, JSON.stringify(expense.body));
    const expId = expense.body.id as string;
    const expDraft = await call(app, people.applicant, "POST", `/api/exp/${expId}/update`, {
      purpose: "改后的报销草稿",
      amount: "70.00",
      invoiceNos: ["EXP-EDIT-1"],
      employeeAccount: "62229999",
    });
    assert.equal(expDraft.status, 200, JSON.stringify(expDraft.body));
    assert.equal(expDraft.body.amount, "70.00");
    assert.equal(expDraft.body.employeeAccount, "62229999");
    assert.equal(expDraft.body.financeGate, "pending");
    assert.equal((await call(app, people.applicant, "POST", `/api/exp/${expId}/submit`)).status, 200);
    const expRejected = await call(app, people.dept, "POST", `/api/exp/${expId}/dept-reject`, { reason: "票号有误" });
    assert.equal(expRejected.body.rejectReason, "票号有误");
    const expFixed = await call(app, people.applicant, "POST", `/api/exp/${expId}/update`, {
      purpose: "换票后的报销",
      amount: "2500.00",
      invoiceNos: ["EXP-EDIT-2"],
      employeeAccount: "62228888",
    });
    assert.equal(expFixed.status, 200, JSON.stringify(expFixed.body));
    assert.equal(expFixed.body.status, "rejected");
    assert.equal(expFixed.body.rejectReason, "票号有误");
    assert.equal(expFixed.body.amount, "2500.00");
    assert.deepEqual(expFixed.body.invoiceNos, ["EXP-EDIT-2"]);
    assert.equal(expFixed.body.financeGate, "pending");
    const expAgain = await call(app, people.applicant, "POST", `/api/exp/${expId}/submit`);
    assert.equal(expAgain.body.rejectReason, null);
    assert.equal(expAgain.body.purpose, "换票后的报销");
    const expTodo = (await todos(app, people.dept)).find((row) => row.id === expId);
    assert.equal(expTodo?.title, "换票后的报销");
    assert.equal(expTodo?.amount, "2500.00");
    assert.equal((await call(app, people.dept, "POST", `/api/exp/${expId}/dept-approve`)).status, 200);
    const ticket = await call(app, people.finance, "POST", `/api/exp/${expId}/ticket-check`);
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    assert.equal(ticket.body.financeGate, "required");
    assert.equal(ticket.body.amount, "2500.00");

    const granted = await call(app, people.admin, "POST", `/api/users/${people.applicant.user.id}/roles`, {
      roles: ["applicant", "dept"],
    });
    assert.equal(granted.status, 200);
    const own = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "自批探针",
      lines: [{ itemName: "笔", qty: 1, estUnitPrice: "10.00", category: "consumable" }],
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${own.body.id}/submit`)).status, 200);
    const sod = await call(app, people.applicant, "POST", `/api/pr/${own.body.id}/dept-approve`);
    assert.equal(sod.status, 409);
    assert.equal(sod.body.error, "SOD_VIOLATION");
    assert.equal(sod.body.sodViolationCode, "S3");
  } finally {
    await app.close();
  }
});

test("预付草稿和驳回可改金额与合同，重新提交后按新金额走关卡", async () => {
  const { app } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "10000.00", paymentTerms: "prepay", purpose: "预付编辑" });
    assert.equal(po.status, "awaiting_prepay");
    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "1000.00",
      contractNo: "CT-OLD",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status, "draft");
    const id = created.body.id as string;
    const edited = await call(app, people.admin, "POST", `/api/prepay/${id}/update`, {
      amount: "1500.00",
      contractNo: "CT-NEW",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.amount, "1500.00");
    assert.equal(edited.body.contractNo, "CT-NEW");
    assert.equal(edited.body.financeGate, "pending");
    assert.equal(edited.body.ceoGate, "pending");
    assert.equal(edited.body.ratio, null);
    assert.equal((await call(app, people.applicant, "POST", `/api/prepay/${id}/update`, {
      amount: "10.00",
      contractNo: "NOPE",
    })).status, 403);
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${id}/submit`)).status, 200);
    const blank = await call(app, people.dept, "POST", `/api/prepay/${id}/dept-reject`, {});
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error, "REJECT_REASON_REQUIRED");
    const rejected = await call(app, people.dept, "POST", `/api/prepay/${id}/dept-reject`, { reason: "比例不对" });
    assert.equal(rejected.body.rejectReason, "比例不对");
    const raised = await call(app, people.admin, "POST", `/api/prepay/${id}/update`, {
      amount: "5000.00",
      contractNo: "CT-RAISED",
    });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.status, "rejected");
    assert.equal(raised.body.rejectReason, "比例不对");
    assert.equal(raised.body.amount, "5000.00");
    assert.equal(raised.body.contractNo, "CT-RAISED");
    assert.equal(raised.body.financeGate, "pending");
    assert.equal(raised.body.ceoGate, "pending");
    assert.equal(raised.body.fullPrepay, false);
    const again = await call(app, people.admin, "POST", `/api/prepay/${id}/submit`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.rejectReason, null);
    assert.equal(again.body.amount, "5000.00");
    const deptTodo = (await todos(app, people.dept)).find((row) => row.id === id);
    assert.equal(deptTodo?.amount, "5000.00");
    assert.equal(deptTodo?.rejectReason, null);
    const approved = await call(app, people.dept, "POST", `/api/prepay/${id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.financeGate, "required");
    assert.equal(approved.body.ceoGate, "skipped");
    assert.equal(approved.body.amount, "5000.00");
    const frozen = await call(app, people.admin, "POST", `/api/prepay/${id}/update`, {
      amount: "1000.00",
      contractNo: "CT-LATE",
    });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "INVALID_STATE");

    const secondPo = await issueTermsPo(app, people, { unitPrice: "10000.00", paymentTerms: "prepay", purpose: "第二张预付" });
    const first = await call(app, people.admin, "POST", "/api/prepay", {
      poId: secondPo.id,
      amount: "1000.00",
      contractNo: "CT-A",
    });
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${first.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${first.body.id}/dept-reject`, { reason: "先驳回" })).status, 200);
    const newer = await call(app, people.admin, "POST", "/api/prepay", {
      poId: secondPo.id,
      amount: "1200.00",
      contractNo: "CT-B",
    });
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    const blocked = await call(app, people.admin, "POST", `/api/prepay/${first.body.id}/update`, {
      amount: "1300.00",
      contractNo: "CT-A2",
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "PREPAY_OPEN");
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${first.body.id}/submit`)).status, 409);
  } finally {
    await app.close();
  }
});

test("同一套驳回后修改再提交连续跑十轮，事由和金额都不回退", async () => {
  for (let round = 1; round <= 10; round += 1) {
    const { app } = await boot();
    try {
      const people = await loginActors(app);
      const purpose = `第${round}轮新事由`;
      const created = await call(app, people.applicant, "POST", "/api/pr", {
        currency: "CNY",
        deptId: "D-ADMIN",
        purpose: `第${round}轮旧事由`,
        lines: [{ itemName: "旧品", qty: 1, estUnitPrice: "1500.00", category: "consumable" }],
      });
      assert.equal(created.status, 200, `round ${round} ${JSON.stringify(created.body)}`);
      const id = created.body.id as string;
      assert.equal((await call(app, people.applicant, "POST", `/api/pr/${id}/submit`)).status, 200);
      const wrongRole = await call(app, people.finance, "POST", `/api/pr/${id}/dept-approve`);
      assert.equal(wrongRole.status, 403, `round ${round}`);
      assert.equal(wrongRole.body.error, "FORBIDDEN_ROLE");
      const missing = await call(app, people.dept, "POST", `/api/pr/${id}/dept-reject`, { reason: "" });
      assert.equal(missing.status, 400, `round ${round}`);
      assert.equal(missing.body.error, "REJECT_REASON_REQUIRED");
      const rejected = await call(app, people.dept, "POST", `/api/pr/${id}/dept-reject`, { reason: `第${round}轮退回` });
      assert.equal(rejected.body.rejectReason, `第${round}轮退回`);
      const updated = await call(app, people.applicant, "POST", `/api/pr/${id}/update`, {
        deptId: "D-ADMIN",
        purpose,
        lines: [{
          itemName: `新品${round}`,
          spec: `规格${round}`,
          purchaseUrl: `https://example.com/r${round}`,
          qty: round,
          estUnitPrice: "20.00",
          category: "consumable",
        }],
      });
      assert.equal(updated.status, 200, `round ${round} ${JSON.stringify(updated.body)}`);
      assert.equal(updated.body.rejectReason, `第${round}轮退回`);
      assert.equal(updated.body.amount, `${(round * 20).toFixed(2)}`);
      const again = await call(app, people.applicant, "POST", `/api/pr/${id}/submit`);
      assert.equal(again.body.rejectReason, null, `round ${round}`);
      const seen = await call(app, people.dept, "GET", `/api/pr/${id}`);
      assert.equal(seen.body.purpose, purpose, `round ${round}`);
      assert.equal(seen.body.lines[0].itemName, `新品${round}`);
      assert.equal(seen.body.lines[0].spec, `规格${round}`);
      assert.equal(seen.body.amount, `${(round * 20).toFixed(2)}`);
      const deptTodo = (await todos(app, people.dept)).find((row) => row.id === id);
      assert.equal(deptTodo?.title, purpose, `round ${round}`);
      assert.equal(deptTodo?.amount, `${(round * 20).toFixed(2)}`);
    } finally {
      await app.close();
    }
  }
});
