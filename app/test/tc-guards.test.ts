import assert from "node:assert/strict";
import test from "node:test";
import { emptyThresholds, THRESHOLD_KEYS } from "../src/domain/thresholds.js";
import { loadThresholds } from "../src/config.js";
import { ErpProInboundStub } from "../src/erp/inbound.js";
import { boot, call, createSubmitted, login } from "./helpers.js";

test("TC-①-1-category-reject 生产物料不能建单", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const rejected = await call(app, applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "贴片电阻",
      lines: [{ itemName: "电阻", qty: 100, estUnitPrice: "0.01", category: "production_material" }],
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, "PRODUCTION_CATEGORY_REJECTED");
    assert.equal(handle.store.prs.size, 0);
  } finally {
    await app.close();
  }
});

test("未登录不能建请购，开发登录默认关闭时不可用", async () => {
  const { app } = await boot({ allowDevLogin: false });
  try {
    const anon = await app.inject({ method: "POST", url: "/api/pr", payload: {} });
    assert.equal(anon.statusCode, 401);
    const dev = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { ucUserId: "uc-applicant" } });
    assert.equal(dev.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("阈值仍为占位时拒绝审批，且不把夹具金额暴露到 meta", async () => {
  const { app, handle } = await boot({ thresholds: emptyThresholds() });
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const pr = await createSubmitted(app, applicant, { qty: 1, estUnitPrice: "100.00" });
    const rejected = await call(app, dept, "POST", `/api/pr/${pr.id}/dept-approve`);
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, "THRESHOLD_NOT_CONFIGURED");
    assert.equal(handle.store.prs.get(pr.id)?.status, "submitted");
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    assert.equal(meta.json().thresholdReady.CNY, false);
    assert.equal(JSON.stringify(meta.json()).includes("10000"), false);
  } finally {
    await app.close();
  }
});

test("配置加载把空值和占位符当成未配置", () => {
  const loaded = loadThresholds({});
  for (const key of THRESHOLD_KEYS) assert.equal(loaded[key], null);
  const named = loadThresholds({ THR_CNY_FIN: "THR_CNY_FIN", THR_CNY_CEO: "PLACEHOLDER" });
  assert.equal(named.THR_CNY_FIN, null);
  assert.equal(named.THR_CNY_CEO, null);
});

test("阶段 1 拒绝预付，接受月结", async () => {
  const { app } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const admin = await login(app, "uc-admin");
    const pr = await createSubmitted(app, applicant, { qty: 1, estUnitPrice: "100.00", purpose: "月结文具" });
    assert.equal((await call(app, dept, "POST", `/api/pr/${pr.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, admin, "POST", `/api/pr/${pr.id}/rfq-waive`, { reasonCode: "BELOW_RFQ" })).status, 200);
    const prepay = await call(app, admin, "POST", `/api/pr/${pr.id}/issue-po`, { paymentTerms: "prepay" });
    assert.equal(prepay.status, 422);
    assert.equal(prepay.body.error, "PREPAY_NOT_IN_SCOPE");
    const monthly = await call(app, admin, "POST", `/api/pr/${pr.id}/issue-po`, {
      paymentTerms: "monthly",
      paymentTermsDays: 30,
      vendorName: "文具商",
    });
    assert.equal(monthly.status, 200, JSON.stringify(monthly.body));
    assert.equal(monthly.body.paymentTerms, "monthly");
    assert.equal(monthly.body.paymentTermsDays, 30);
    assert.equal(monthly.body.status, "awaiting_receipt");
  } finally {
    await app.close();
  }
});

test("固资品类强制建卡，费用化接口拒绝", async () => {
  const { app } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const admin = await login(app, "uc-admin");
    const pr = await createSubmitted(app, applicant, {
      qty: 1,
      estUnitPrice: "100.00",
      category: "fixed_asset",
      purpose: "办公电脑",
    });
    assert.equal((await call(app, dept, "POST", `/api/pr/${pr.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, admin, "POST", `/api/pr/${pr.id}/rfq-waive`, { reasonCode: "LOW_AMOUNT" })).status, 200);
    const po = await call(app, admin, "POST", `/api/pr/${pr.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "电脑商",
    });
    assert.equal((await call(app, applicant, "POST", `/api/po/${po.body.id}/receive`, { result: "accepted" })).status, 200);
    assert.equal(po.body.id.length > 0, true);
    const reloaded = await call(app, admin, "GET", `/api/po/${po.body.id}`);
    assert.equal(reloaded.body.disposition, "asset");
    const expense = await call(app, admin, "POST", `/api/po/${po.body.id}/expense`);
    assert.equal(expense.status, 409);
    assert.equal(expense.body.error, "NEED_ASSET_CARD");
    const card = await call(app, admin, "POST", `/api/po/${po.body.id}/asset-card`, {
      custodianId: applicant.user.id,
      location: "前台",
      name: "办公电脑",
    });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    assert.equal(card.body.creatorId, admin.user.id);
    assert.equal(card.body.custodianId, applicant.user.id);
  } finally {
    await app.close();
  }
});

test("erp-pro stub 拒绝生产会话字段", async () => {
  const erp = new ErpProInboundStub();
  await assert.rejects(
    () =>
      erp.pushAdminInbound({
        sourceDocNo: "PO-1",
        companyCode: "SZ",
        lines: [{ itemName: "电阻", qty: 1, category: "production_material" as "consumable" }],
        sessionKind: "pcba_session" as "admin_inbound",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "ERP_SESSION_ISOLATION");
      return true;
    },
  );
  await assert.rejects(
    () =>
      erp.pushAdminInbound({
        sourceDocNo: "PO-1",
        companyCode: "SZ",
        lines: [{ itemName: "纸", qty: 1, category: "consumable" }],
        sessionKind: "admin_inbound",
        cookie: "pcba_session=1",
      } as never),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERP_SESSION_ISOLATION");
      return true;
    },
  );
  assert.equal(erp.calls.length, 0);
});
