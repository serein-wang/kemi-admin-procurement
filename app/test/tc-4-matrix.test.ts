import assert from "node:assert/strict";
import test from "node:test";
import { emptyThresholds, THRESHOLD_KEYS } from "../src/domain/thresholds.js";
import { loadThresholds } from "../src/config.js";
import { boot, call, loginActors } from "./helpers.js";

test("SZ 与 HK 阈值占位互不填充", () => {
  const empty = loadThresholds({});
  for (const key of THRESHOLD_KEYS) assert.equal(empty[key], null);
  const hkdOnly = loadThresholds({
    THR_HKD_FIN: "3.00",
    THR_HKD_CEO: "9.00",
    THR_CNY_FIN: "PLACEHOLDER",
  });
  assert.equal(hkdOnly.THR_HKD_FIN, "3.00");
  assert.equal(hkdOnly.THR_HKD_CEO, "9.00");
  assert.equal(hkdOnly.THR_CNY_FIN, null);
  assert.equal(hkdOnly.THR_CNY_CEO, null);
  assert.equal(hkdOnly.THR_CNY_RFQ, null);
  assert.equal(hkdOnly.THR_HKD_RFQ, null);
});

test("TC-Q4 同一金额在 SZ/CNY 与 HK/HKD 矩阵走不同档，配置数字不进 meta", async () => {
  const thresholds = {
    ...emptyThresholds(),
    THR_CNY_FIN: "1000.00",
    THR_CNY_CEO: "5000.00",
    THR_CNY_RFQ: "50000.00",
    THR_CNY_CAPEX: "90000.00",
    THR_HKD_FIN: "100.00",
    THR_HKD_CEO: "400.00",
    THR_HKD_RFQ: "50.00",
    THR_HKD_CAPEX: "90000.00",
  };
  const { app } = await boot({ thresholds });
  try {
    const people = await loginActors(app);
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    const body = meta.json();
    assert.equal(body.matrices.SZ.currency, "CNY");
    assert.equal(body.matrices.SZ.companyCode, "SZ");
    assert.equal(body.matrices.HK.currency, "HKD");
    assert.equal(body.matrices.HK.companyCode, "HK");
    assert.equal(body.matrices.SZ.configured.fin, true);
    assert.equal(body.matrices.HK.configured.ceo, true);
    assert.equal(body.kingdeeWriteback, "deferred");
    const text = JSON.stringify(body);
    assert.equal(text.includes("1000.00"), false);
    assert.equal(text.includes("400.00"), false);
    assert.equal(text.includes("50000.00"), false);

    const sz = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-SZ",
      purpose: "深圳低额",
      lines: [{ itemName: "插座", qty: 1, estUnitPrice: "800.00", category: "consumable" }],
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${sz.body.id}/submit`)).status, 200);
    const szApproved = await call(app, people.dept, "POST", `/api/pr/${sz.body.id}/dept-approve`);
    assert.equal(szApproved.status, 200, JSON.stringify(szApproved.body));
    assert.equal(szApproved.body.status, "sourcing");
    assert.equal(szApproved.body.financeGate, "skipped");
    assert.equal(szApproved.body.ceoGate, "skipped");
    assert.equal(szApproved.body.rfqRequired, false);

    const hk = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "HK",
      currency: "HKD",
      deptId: "D-HK",
      purpose: "香港高额",
      lines: [{ itemName: "插座", qty: 1, estUnitPrice: "800.00", category: "consumable" }],
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${hk.body.id}/submit`)).status, 200);
    const hkApproved = await call(app, people.dept, "POST", `/api/pr/${hk.body.id}/dept-approve`);
    assert.equal(hkApproved.status, 200, JSON.stringify(hkApproved.body));
    assert.equal(hkApproved.body.status, "dept_approved");
    assert.equal(hkApproved.body.financeGate, "required");
    assert.equal(hkApproved.body.ceoGate, "required");
    assert.equal(hkApproved.body.currency, "HKD");
    assert.equal(hkApproved.body.companyCode, "HK");

    const crossed = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "HKD",
      deptId: "D-SZ",
      purpose: "交叉币种",
      lines: [{ itemName: "插座", qty: 1, estUnitPrice: "800.00", category: "consumable" }],
    });
    assert.equal(crossed.status, 422);
    assert.equal(crossed.body.error, "COMPANY_CURRENCY_MISMATCH");
    const crossedBack = await call(app, people.applicant, "POST", "/api/pre", {
      companyCode: "HK",
      currency: "CNY",
      deptId: "D-HK",
      purpose: "交叉币种",
      amount: "800.00",
    });
    assert.equal(crossedBack.status, 422);
    assert.equal(crossedBack.body.error, "COMPANY_CURRENCY_MISMATCH");
  } finally {
    await app.close();
  }
});

test("只注入一边阈值时，另一边矩阵仍是占位", async () => {
  const thresholds = {
    ...emptyThresholds(),
    THR_CNY_FIN: "11.00",
    THR_HKD_CEO: "22.00",
  };
  const { app } = await boot({ thresholds });
  try {
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    const body = meta.json();
    assert.equal(body.matrices.SZ.configured.fin, true);
    assert.equal(body.matrices.SZ.configured.ceo, false);
    assert.equal(body.matrices.SZ.configured.rfq, false);
    assert.equal(body.matrices.HK.configured.fin, false);
    assert.equal(body.matrices.HK.configured.ceo, true);
    assert.equal(body.matrices.HK.configured.reim, false);
    assert.equal(body.thresholdReady.CNY, false);
    assert.equal(body.thresholdReady.HKD, false);
    const text = JSON.stringify(body);
    assert.equal(text.includes("11.00"), false);
    assert.equal(text.includes("22.00"), false);
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.json().kingdeeWriteback, "deferred");
    assert.equal(health.json().phase, 4);
    const writeback = await app.inject({ method: "POST", url: "/api/kingdee/writeback", payload: {} });
    assert.equal(writeback.statusCode, 404);
  } finally {
    await app.close();
  }
});
