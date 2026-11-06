import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, createSubmitted, login } from "./helpers.js";

test("中额跳过总经理，高额两关都必审", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const finance = await login(app, "uc-finance");
    const ceo = await login(app, "uc-ceo");

    const mid = await createSubmitted(app, applicant, { qty: 1, estUnitPrice: "10000.00", purpose: "中额" });
    const midApproved = await call(app, dept, "POST", `/api/pr/${mid.id}/dept-approve`);
    assert.equal(midApproved.body.status, "dept_approved");
    assert.equal(midApproved.body.financeGate, "required");
    assert.equal(midApproved.body.ceoGate, "skipped");
    assert.equal(auditsOf(handle, "PR", mid.id).some((row) => row.skipped), false);

    const afterFinance = await call(app, finance, "POST", `/api/pr/${mid.id}/finance-approve`);
    assert.equal(afterFinance.status, 200, JSON.stringify(afterFinance.body));
    assert.equal(afterFinance.body.status, "sourcing");
    const ceoSkip = auditsOf(handle, "PR", mid.id).find((row) => row.skipped && row.comment.includes("①-4"));
    assert.equal(ceoSkip?.skippedReason, "below_threshold");

    const high = await createSubmitted(app, applicant, { qty: 1, estUnitPrice: "50000.00", purpose: "高额" });
    const highDept = await call(app, dept, "POST", `/api/pr/${high.id}/dept-approve`);
    assert.equal(highDept.body.financeGate, "required");
    assert.equal(highDept.body.ceoGate, "required");
    assert.equal((await call(app, finance, "POST", `/api/pr/${high.id}/finance-approve`)).body.status, "finance_approved");
    const highCeo = await call(app, ceo, "POST", `/api/pr/${high.id}/ceo-approve`);
    assert.equal(highCeo.status, 200, JSON.stringify(highCeo.body));
    assert.equal(highCeo.body.status, "sourcing");
    assert.equal(highCeo.body.rfqRequired, true);
    assert.equal(auditsOf(handle, "PR", high.id).some((row) => row.skipped), false);
  } finally {
    await app.close();
  }
});
