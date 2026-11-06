import assert from "node:assert/strict";
import test from "node:test";
import { boot, call, issueTermsPo, loginActors } from "./helpers.js";

async function drafted(app: Awaited<ReturnType<typeof boot>>["app"]) {
  const people = await loginActors(app);
  const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay" });
  const created = await call(app, people.admin, "POST", "/api/prepay", {
    poId: po.id,
    amount: "40.00",
    proforma: { invoiceNo: `PF-${po.id}`, amount: "40.00", tax: "0.00" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const submitted = await call(app, people.admin, "POST", `/api/prepay/${created.body.id}/submit`);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return { people, prepayId: created.body.id as string };
}

test("TC-①-P5-S5-reject 预付申请人不能批自己的预付", async () => {
  const { app, handle } = await boot();
  try {
    const { people, prepayId } = await drafted(app);
    const grant = await call(app, people.admin, "POST", `/api/users/${people.admin.user.id}/roles`, {
      roles: ["admin", "finance"],
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${prepayId}/dept-approve`)).status, 200);
    const rejected = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/payment-approve`);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "SOD_VIOLATION");
    assert.equal(rejected.body.sodViolationCode, "S5");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "dept_approved");
    assert.equal(handle.store.prepays.get(prepayId)?.paymentApproverId, null);
  } finally {
    await app.close();
  }
});

test("TC-①-P6-S5-reject 预付审批人不能付预付款", async () => {
  const { app, handle } = await boot();
  try {
    const { people, prepayId } = await drafted(app);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${prepayId}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${prepayId}/payment-approve`)).status, 200);
    const grant = await call(app, people.admin, "POST", `/api/users/${people.finance.user.id}/roles`, {
      roles: ["finance", "cashier"],
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    const rejected = await call(app, people.finance, "POST", `/api/prepay/${prepayId}/pay`, { bankRef: "BANK-S5" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.sodViolationCode, "S5");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "finance_payment_approved");
    assert.equal(handle.store.prepays.get(prepayId)?.payerId, null);
  } finally {
    await app.close();
  }
});

test("TC-①-P6-S5-reject 预付申请人不能付预付款", async () => {
  const { app, handle } = await boot();
  try {
    const { people, prepayId } = await drafted(app);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${prepayId}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${prepayId}/payment-approve`)).status, 200);
    assert.equal((await call(app, people.admin, "POST", `/api/users/${people.admin.user.id}/roles`, {
      roles: ["admin", "cashier"],
    })).status, 200);
    const rejected = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/pay`, { bankRef: "BANK-S5B" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.sodViolationCode, "S5");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "finance_payment_approved");
    assert.equal(handle.store.prepays.get(prepayId)?.payerId, null);
  } finally {
    await app.close();
  }
});

test("TC-①-P2-S3-reject 预付申请人不能部门自批", async () => {
  const { app, handle } = await boot();
  try {
    const { people, prepayId } = await drafted(app);
    assert.equal((await call(app, people.admin, "POST", `/api/users/${people.admin.user.id}/roles`, {
      roles: ["admin", "dept"],
    })).status, 200);
    const rejected = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/dept-approve`);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.sodViolationCode, "S3");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "submitted");
  } finally {
    await app.close();
  }
});
