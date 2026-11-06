import assert from "node:assert/strict";
import test from "node:test";
import { emptyThresholds } from "../src/domain/thresholds.js";
import { auditsOf, boot, call, loginActors } from "./helpers.js";

test("TC-Q7 低值仍走路径①：免比价、简化低额矩阵、可批量收货", async () => {
  const { app, handle, erp } = await boot();
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "HK",
      currency: "HKD",
      deptId: "D-HK",
      purpose: "低值文具",
      lines: [{ itemName: "回形针", qty: 10, estUnitPrice: "6000.00", category: "low_value" }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.docType, "low_value");
    assert.equal(created.body.amount, "60000.00");
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${created.body.id}/submit`)).status, 200);
    const approved = await call(app, people.dept, "POST", `/api/pr/${created.body.id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "sourcing");
    assert.equal(approved.body.financeGate, "skipped");
    assert.equal(approved.body.ceoGate, "skipped");
    assert.equal(approved.body.rfqRequired, false);
    assert.equal(approved.body.rfqWaiverKind, "low_value");
    const skips = auditsOf(handle, "PR", created.body.id).filter((row) => row.skipped);
    assert.equal(skips.length, 2);
    assert.ok(skips.every((row) => row.skippedReason === "low_value_matrix"));

    const standard = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "HK",
      currency: "HKD",
      deptId: "D-HK",
      purpose: "同额标准单",
      lines: [
        { itemName: "回形针", qty: 1, estUnitPrice: "100.00", category: "low_value" },
        { itemName: "维修", qty: 1, estUnitPrice: "59900.00", category: "service" },
      ],
    });
    assert.equal(standard.body.docType, "standard");
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${standard.body.id}/submit`)).status, 200);
    const standardApproved = await call(app, people.dept, "POST", `/api/pr/${standard.body.id}/dept-approve`);
    assert.equal(standardApproved.body.status, "dept_approved");
    assert.equal(standardApproved.body.financeGate, "required");
    assert.equal(standardApproved.body.ceoGate, "required");

    const waived = await call(app, people.admin, "POST", `/api/pr/${created.body.id}/rfq-waive`, { reasonCode: "LOW_VALUE" });
    assert.equal(waived.status, 200, JSON.stringify(waived.body));
    assert.equal(auditsOf(handle, "PR", created.body.id).some((row) => row.skippedReason === "low_value_waiver"), true);
    const po = await call(app, people.admin, "POST", `/api/pr/${created.body.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "文具商",
    });
    assert.equal(po.body.status, "awaiting_receipt");
    const batch = await call(app, people.applicant, "POST", `/api/po/${po.body.id}/receive-batch`, { result: "accepted" });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.qtyReceived, 10);
    assert.equal(handle.store.pos.get(po.body.id)?.disposition, "asset");
    const expense = await call(app, people.admin, "POST", `/api/po/${po.body.id}/expense`);
    assert.equal(expense.status, 409);
    assert.equal(expense.body.error, "NEED_ASSET_CARD");
    assert.equal(erp.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("TC-Q7 低值批量收货一次收完，标准单不能走批量，缺审批阈值也不挡低值部门审", async () => {
  const thresholds = {
    ...emptyThresholds(),
    THR_CNY_CAPEX: "8000.00",
    THR_HKD_CAPEX: "8000.00",
  };
  const { app, handle, erp } = await boot({ thresholds });
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "批量回形针",
      lines: [{ itemName: "回形针", qty: 10, estUnitPrice: "10.00", category: "low_value" }],
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${created.body.id}/submit`)).status, 200);
    const approved = await call(app, people.dept, "POST", `/api/pr/${created.body.id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.financeGate, "skipped");
    assert.equal((await call(app, people.admin, "POST", `/api/pr/${created.body.id}/rfq-waive`, { reasonCode: "LOW_VALUE" })).status, 200);
    const po = await call(app, people.admin, "POST", `/api/pr/${created.body.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "文具商",
    });
    const asIssuer = await call(app, people.admin, "POST", `/api/po/${po.body.id}/receive-batch`, { result: "accepted" });
    assert.equal(asIssuer.status, 409);
    assert.equal(asIssuer.body.sodViolationCode, "S1");
    assert.equal(handle.store.pos.get(po.body.id)?.status, "awaiting_receipt");
    const batch = await call(app, people.applicant, "POST", `/api/po/${po.body.id}/receive-batch`, { result: "accepted" });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.qtyReceived, 10);
    assert.equal(batch.body.status, "confirmed");
    assert.equal(handle.store.pos.get(po.body.id)?.status, "fully_received");
    assert.equal(handle.store.pos.get(po.body.id)?.disposition, "expense");
    assert.equal(handle.store.grns.size, 1);
    const expense = await call(app, people.admin, "POST", `/api/po/${po.body.id}/expense`);
    assert.equal(expense.status, 200, JSON.stringify(expense.body));
    assert.equal(erp.calls.length, 1);
    assert.equal(erp.calls[0]?.lines[0]?.category, "low_value");
    assert.equal(erp.calls[0]?.sessionKind, "admin_inbound");

    const standard = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "普通耗材",
      lines: [{ itemName: "纸", qty: 2, estUnitPrice: "10.00", category: "consumable" }],
    });
    assert.equal(standard.body.docType, "standard");
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${standard.body.id}/submit`)).status, 200);
    const dept = await call(app, people.dept, "POST", `/api/pr/${standard.body.id}/dept-approve`);
    assert.equal(dept.status, 422);
    assert.equal(dept.body.error, "THRESHOLD_NOT_CONFIGURED");
    assert.equal(handle.store.prs.get(standard.body.id)?.status, "submitted");
  } finally {
    await app.close();
  }
});

test("标准采购单拒绝批量收货，且没有第三条低值路径", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "普通纸",
      lines: [{ itemName: "纸", qty: 2, estUnitPrice: "10.00", category: "consumable" }],
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${created.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${created.body.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/pr/${created.body.id}/rfq-waive`, { reasonCode: "BELOW_RFQ" })).status, 200);
    const po = await call(app, people.admin, "POST", `/api/pr/${created.body.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "纸商",
    });
    const batch = await call(app, people.applicant, "POST", `/api/po/${po.body.id}/receive-batch`, { result: "accepted" });
    assert.equal(batch.status, 409);
    assert.equal(batch.body.error, "LOW_VALUE_ONLY");
    assert.equal(handle.store.pos.get(po.body.id)?.status, "awaiting_receipt");
    assert.equal(handle.store.grns.size, 0);
    const ghost = await app.inject({
      method: "POST",
      url: "/api/low-value",
      headers: { cookie: people.applicant.cookie },
      payload: {},
    });
    assert.equal(ghost.statusCode, 404);
  } finally {
    await app.close();
  }
});
