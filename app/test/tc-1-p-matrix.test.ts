import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, FIXTURE_PREPAY_POLICY, FIXTURE_THRESHOLDS, issueTermsPo, loginActors } from "./helpers.js";

test("TC-①-P-matrix 中额跳过总经理，全额预付与比例、合同按占位策略拒绝", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const midPo = await issueTermsPo(app, people, { unitPrice: "10000.00", paymentTerms: "prepay", purpose: "中额预付" });
    const mid = await call(app, people.admin, "POST", "/api/prepay", {
      poId: midPo.id,
      amount: "4000.00",
      proforma: { invoiceNo: "PF-MID", amount: "4000.00", tax: "0.00" },
    });
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${mid.body.id}/submit`)).status, 200);
    const dept = await call(app, people.dept, "POST", `/api/prepay/${mid.body.id}/dept-approve`);
    assert.equal(dept.body.financeGate, "required");
    assert.equal(dept.body.ceoGate, "skipped");
    const cosign = await call(app, people.finance, "POST", `/api/prepay/${mid.body.id}/finance-cosign`);
    assert.equal(cosign.status, 200, JSON.stringify(cosign.body));
    assert.equal(cosign.body.status, "finance_cosigned");
    const midPay = await call(app, people.finance, "POST", `/api/prepay/${mid.body.id}/payment-approve`);
    assert.equal(midPay.status, 200, JSON.stringify(midPay.body));
    assert.equal(midPay.body.status, "finance_payment_approved");
    const skips = auditsOf(handle, "PREPAY", mid.body.id).filter((row) => row.skipped && row.skippedReason === "below_threshold");
    assert.equal(skips.length, 1);
    assert.equal(skips[0]?.comment.includes("①-P4"), true);

    const fullPo = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "全额预付" });
    const full = await call(app, people.admin, "POST", "/api/prepay", {
      poId: fullPo.id,
      amount: "100.00",
      contractNo: "CT-FULL",
    });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    const denied = await call(app, people.admin, "POST", `/api/prepay/${full.body.id}/submit`);
    assert.equal(denied.status, 422);
    assert.equal(denied.body.error, "FULL_PREPAY_NOT_ALLOWED");
    assert.equal(handle.store.prepays.get(full.body.id)?.status, "draft");

    const ratioPo = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "超比例" });
    const ratio = await call(app, people.admin, "POST", "/api/prepay", {
      poId: ratioPo.id,
      amount: "90.00",
      proforma: { invoiceNo: "PF-RATIO", amount: "90.00", tax: "0.00" },
    });
    const ratioDenied = await call(app, people.admin, "POST", `/api/prepay/${ratio.body.id}/submit`);
    assert.equal(ratioDenied.body.error, "PREPAY_RATIO_EXCEEDED");

    const contractPo = await issueTermsPo(app, people, { unitPrice: "20000.00", paymentTerms: "prepay", purpose: "强制合同" });
    const noContract = await call(app, people.admin, "POST", "/api/prepay", {
      poId: contractPo.id,
      amount: "8000.00",
      proforma: { invoiceNo: "PF-CONTRACT", amount: "8000.00", tax: "0.00" },
    });
    const contractDenied = await call(app, people.admin, "POST", `/api/prepay/${noContract.body.id}/submit`);
    assert.equal(contractDenied.body.error, "CONTRACT_REQUIRED");
    assert.equal(handle.store.prepays.get(noContract.body.id)?.status, "draft");
  } finally {
    await app.close();
  }
});

test("达合同阈值且已附合同时可以提交", async () => {
  const { app } = await boot();
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "20000.00", paymentTerms: "prepay", purpose: "有合同" });
    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "8000.00",
      contractNo: "CT-OK",
    });
    const submitted = await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.fullPrepay, false);
    assert.equal(submitted.body.contractNo, "CT-OK");
  } finally {
    await app.close();
  }
});

test("全额预付开启后强制高额档", async () => {
  const { app, handle } = await boot({
    prepayPolicy: { ...FIXTURE_PREPAY_POLICY, allowFullPrepay: true },
  });
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "100.00",
      contractNo: "CT-HIGH",
    });
    const submitted = await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.fullPrepay, true);
    const dept = await call(app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`);
    assert.equal(dept.body.financeGate, "required");
    assert.equal(dept.body.ceoGate, "required");
    assert.equal(dept.body.status, "dept_approved");
    const skips = auditsOf(handle, "PREPAY", created.body.id).filter((row) => row.skipped);
    assert.equal(skips.length, 0);
    const cosign = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/finance-cosign`);
    assert.equal(cosign.body.status, "finance_cosigned");
    const ceo = await call(app, people.ceo, "POST", `/api/prepay/${created.body.id}/ceo-approve`);
    assert.equal(ceo.status, 200, JSON.stringify(ceo.body));
    assert.equal(ceo.body.status, "ceo_approved");
    const pay = await call(app, people.finance, "POST", `/api/prepay/${created.body.id}/payment-approve`);
    assert.equal(pay.body.status, "finance_payment_approved");
  } finally {
    await app.close();
  }
});

test("预付阈值未配置时拒绝部门审批；继承请购矩阵时改读请购档", async () => {
  const thresholds = {
    ...FIXTURE_THRESHOLDS,
    THR_CNY_PREPAY_FIN: null,
    THR_CNY_PREPAY_CEO: null,
    THR_HKD_PREPAY_FIN: null,
    THR_HKD_PREPAY_CEO: null,
  };
  const missing = await boot({ thresholds });
  try {
    const people = await loginActors(missing.app);
    const po = await issueTermsPo(missing.app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
    const created = await call(missing.app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-MISS", amount: "40.00", tax: "0.00" },
    });
    assert.equal((await call(missing.app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`)).status, 200);
    const rejected = await call(missing.app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`);
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, "THRESHOLD_NOT_CONFIGURED");
    assert.equal(missing.handle.store.prepays.get(created.body.id)?.status, "submitted");
  } finally {
    await missing.app.close();
  }

  const inherited = await boot({
    thresholds,
    prepayPolicy: { ...FIXTURE_PREPAY_POLICY, inheritPrMatrix: true },
  });
  try {
    const people = await loginActors(inherited.app);
    const po = await issueTermsPo(inherited.app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "继承矩阵" });
    const created = await call(inherited.app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      proforma: { invoiceNo: "PF-INHERIT", amount: "40.00", tax: "0.00" },
    });
    assert.equal((await call(inherited.app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`)).status, 200);
    const dept = await call(inherited.app, people.dept, "POST", `/api/prepay/${created.body.id}/dept-approve`);
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    assert.equal(dept.body.financeGate, "skipped");
    assert.equal(dept.body.ceoGate, "skipped");
  } finally {
    await inherited.app.close();
  }
});
