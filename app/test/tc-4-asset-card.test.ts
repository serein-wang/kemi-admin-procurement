import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, loginActors } from "./helpers.js";

test("TC-①-8a 资产卡全字段，S4 拒绝建卡人兼任保管人，调拨与停用可走完", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      companyCode: "SZ",
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "办公电脑",
      lines: [{ itemName: "笔记本", spec: "14 寸", qty: 1, estUnitPrice: "100.00", category: "fixed_asset" }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await call(app, people.applicant, "POST", `/api/pr/${created.body.id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/pr/${created.body.id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/pr/${created.body.id}/rfq-waive`, { reasonCode: "LOW_AMOUNT" })).status, 200);
    const po = await call(app, people.admin, "POST", `/api/pr/${created.body.id}/issue-po`, {
      paymentTerms: "after_delivery",
      vendorName: "电脑商",
    });
    assert.equal((await call(app, people.applicant, "POST", `/api/po/${po.body.id}/receive`, { result: "accepted" })).status, 200);
    assert.equal(handle.store.pos.get(po.body.id)?.disposition, "asset");

    const blocked = await call(app, people.admin, "POST", `/api/po/${po.body.id}/asset-card`, {
      custodianId: people.admin.user.id,
      location: "前台",
      name: "笔记本",
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "SOD_VIOLATION");
    assert.equal(blocked.body.sodViolationCode, "S4");
    assert.equal(handle.store.assets.size, 0);
    assert.equal(handle.store.pos.get(po.body.id)?.dispositionDone, false);
    assert.equal(handle.store.pos.get(po.body.id)?.status, "fully_received");
    const violation = auditsOf(handle, "PO", po.body.id).find((row) => row.sodViolationCode === "S4");
    assert.ok(violation);

    const card = await call(app, people.admin, "POST", `/api/po/${po.body.id}/asset-card`, {
      custodianId: people.applicant.user.id,
      location: "前台",
      name: "笔记本",
    });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    assert.equal(card.body.companyCode, "SZ");
    assert.equal(card.body.currency, "CNY");
    assert.equal(card.body.amount, "100.00");
    assert.equal(card.body.capitalizedAmount, "100.00");
    assert.equal(card.body.status, "active");
    assert.equal(card.body.applicantId, people.applicant.user.id);
    assert.equal(card.body.createdBy, people.admin.user.id);
    assert.equal(card.body.creatorId, people.admin.user.id);
    assert.equal(card.body.custodianId, people.applicant.user.id);
    assert.equal(card.body.location, "前台");
    assert.equal(card.body.name, "笔记本");
    assert.equal(card.body.poId, po.body.id);
    assert.equal(card.body.assetNo, card.body.id);
    assert.equal(card.body.docNo, card.body.id);
    assert.equal(typeof card.body.grnId, "string");
    assert.equal(typeof card.body.createdAt, "string");
    assert.equal(card.body.updatedAt, card.body.createdAt);
    assert.equal(handle.store.pos.get(po.body.id)?.dispositionDone, true);
    assert.equal("kingdee" in card.body, false);

    const loaded = await call(app, people.applicant, "GET", `/api/assets/${card.body.id}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.assetNo, card.body.assetNo);
    assert.equal(loaded.body.grnId, card.body.grnId);

    const selfTransfer = await call(app, people.admin, "POST", `/api/assets/${card.body.id}/transfer`, {
      custodianId: people.admin.user.id,
      location: "仓库",
    });
    assert.equal(selfTransfer.status, 409);
    assert.equal(selfTransfer.body.sodViolationCode, "S4");
    assert.equal(handle.store.assets.get(card.body.id)?.custodianId, people.applicant.user.id);
    assert.equal(handle.store.assets.get(card.body.id)?.status, "active");

    const transferred = await call(app, people.admin, "POST", `/api/assets/${card.body.id}/transfer`, {
      custodianId: people.dept.user.id,
      location: "财务室",
    });
    assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
    assert.equal(transferred.body.status, "transferred");
    assert.equal(transferred.body.custodianId, people.dept.user.id);
    assert.equal(transferred.body.location, "财务室");
    assert.equal(transferred.body.creatorId, people.admin.user.id);
    assert.notEqual(transferred.body.updatedAt, transferred.body.createdAt);

    const retired = await call(app, people.admin, "POST", `/api/assets/${card.body.id}/retire`, { comment: "报废" });
    assert.equal(retired.body.status, "retired");
    const after = await call(app, people.admin, "POST", `/api/assets/${card.body.id}/transfer`, {
      custodianId: people.finance.user.id,
      location: "库房",
    });
    assert.equal(after.status, 409);
    assert.equal(handle.store.assets.get(card.body.id)?.status, "retired");
    assert.equal(handle.store.assets.get(card.body.id)?.custodianId, people.dept.user.id);
  } finally {
    await app.close();
  }
});
