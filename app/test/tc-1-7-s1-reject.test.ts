import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, createSubmitted, login } from "./helpers.js";

test("TC-①-7-S1-reject 下单人不得验收", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const dept = await login(app, "uc-dept");
    const admin = await login(app, "uc-admin");
    const pr = await createSubmitted(app, applicant, { qty: 1, estUnitPrice: "100.00" });
    const approved = await call(app, dept, "POST", `/api/pr/${pr.id}/dept-approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "sourcing");
    assert.equal(approved.body.rfqRequired, false);

    const waived = await call(app, admin, "POST", `/api/pr/${pr.id}/rfq-waive`, { reasonCode: "BELOW_RFQ" });
    assert.equal(waived.status, 200, JSON.stringify(waived.body));
    const po = await call(app, admin, "POST", `/api/pr/${pr.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "行政供应商",
    });
    assert.equal(po.status, 200, JSON.stringify(po.body));
    assert.equal(po.body.issuerId, admin.user.id);

    const rejected = await call(app, admin, "POST", `/api/po/${po.body.id}/receive`, { result: "accepted" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "SOD_VIOLATION");
    assert.equal(rejected.body.sodViolationCode, "S1");

    const storedPo = handle.store.pos.get(po.body.id);
    assert.equal(storedPo?.status, "awaiting_receipt");
    assert.equal([...handle.store.grns.values()].length, 0);
    const violation = auditsOf(handle, "PO", po.body.id).find((row) => row.sodViolationCode === "S1");
    assert.ok(violation);
  } finally {
    await app.close();
  }
});
