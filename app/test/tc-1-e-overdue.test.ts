import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, FIXTURE_PREPAY_POLICY, issueTermsPo, loginActors } from "./helpers.js";

const START = new Date("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;

function clockAt(start: Date) {
  const state = { at: new Date(start.getTime()) };
  return {
    state,
    clock: () => new Date(state.at.getTime()),
    advanceDays(days: number) {
      state.at = new Date(state.at.getTime() + days * DAY);
    },
  };
}

async function paidAwaiting(
  app: Awaited<ReturnType<typeof boot>>["app"],
  suffix: string,
) {
  const people = await loginActors(app);
  const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: `超期 ${suffix}` });
  const created = await call(app, people.admin, "POST", "/api/prepay", {
    poId: po.id,
    amount: "40.00",
    proforma: { invoiceNo: `PF-${suffix}`, amount: "40.00", tax: "0.00" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id as string;
  assert.equal((await call(app, people.admin, "POST", `/api/prepay/${id}/submit`)).status, 200);
  assert.equal((await call(app, people.dept, "POST", `/api/prepay/${id}/dept-approve`)).status, 200);
  assert.equal((await call(app, people.finance, "POST", `/api/prepay/${id}/payment-approve`)).status, 200);
  assert.equal((await call(app, people.cashier, "POST", `/api/prepay/${id}/pay`, { bankRef: `BANK-${suffix}` })).status, 200);
  assert.equal((await call(app, people.finance, "POST", `/api/prepay/${id}/accrue`, { voucherRef: `VCH-${suffix}` })).status, 200);
  return { people, po, prepayId: id };
}

test("TC-①-E1 未超期不进清单，已付未挂账也会列出但不改状态", async () => {
  const time = clockAt(START);
  const { app, handle } = await boot({ clock: time.clock });
  try {
    const people = await loginActors(app);
    const po = await issueTermsPo(app, people, { unitPrice: "100.00", paymentTerms: "prepay", purpose: "仅付款" });
    const created = await call(app, people.admin, "POST", "/api/prepay", {
      poId: po.id,
      amount: "40.00",
      contractNo: "CT-PAID",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;
    assert.equal((await call(app, people.admin, "POST", `/api/prepay/${id}/submit`)).status, 200);
    assert.equal((await call(app, people.dept, "POST", `/api/prepay/${id}/dept-approve`)).status, 200);
    assert.equal((await call(app, people.finance, "POST", `/api/prepay/${id}/payment-approve`)).status, 200);
    assert.equal((await call(app, people.cashier, "POST", `/api/prepay/${id}/pay`, { bankRef: "BANK-PAID" })).status, 200);
    assert.equal(handle.store.prepays.get(id)?.status, "paid");

    time.advanceDays(29);
    const early = await call(app, people.finance, "POST", "/api/prepay-overdue/scan");
    assert.equal(early.status, 200, JSON.stringify(early.body));
    assert.equal(early.body.items.length, 0);
    assert.equal(handle.store.prepays.get(id)?.status, "paid");

    time.advanceDays(1);
    const listed = await call(app, people.finance, "POST", "/api/prepay-overdue/scan");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.overdueDays, 30);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].prepayId, id);
    assert.equal(listed.body.items[0].ageDays, 30);
    assert.equal(listed.body.items[0].flagged, false);
    assert.equal(listed.body.flagged.length, 0);
    assert.equal(handle.store.prepays.get(id)?.status, "paid");
    const denied = await call(app, people.admin, "POST", "/api/prepay-overdue/scan");
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});

test("TC-①-E* 超期清单、跟催、追索退款闭环", async () => {
  const time = clockAt(START);
  const { app, handle } = await boot({ clock: time.clock });
  try {
    const { people, po, prepayId } = await paidAwaiting(app, "E-LOOP");
    time.advanceDays(30);
    const missingDays = await boot({
      clock: time.clock,
      prepayPolicy: { ...FIXTURE_PREPAY_POLICY, overdueDays: null },
    });
    try {
      const finance = await loginActors(missingDays.app).then((rows) => rows.finance);
      const blocked = await call(missingDays.app, finance, "POST", "/api/prepay-overdue/scan");
      assert.equal(blocked.status, 422);
      assert.equal(blocked.body.error, "THRESHOLD_NOT_CONFIGURED");
    } finally {
      await missingDays.app.close();
    }

    const scan = await call(app, people.finance, "POST", "/api/prepay-overdue/scan");
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.deepEqual(scan.body.flagged, [prepayId]);
    assert.equal(scan.body.items[0].status, "overdue_flagged");
    assert.equal(scan.body.items[0].flagged, true);
    assert.equal(handle.store.prepays.get(prepayId)?.overdueFlag, true);
    const again = await call(app, people.finance, "POST", "/api/prepay-overdue/scan");
    assert.equal(again.body.flagged.length, 0);
    assert.equal(
      auditsOf(handle, "PREPAY", prepayId).filter((row) => row.toStatus === "overdue_flagged").length,
      1,
    );

    const noNote = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/chase`, { outcome: "no_result" });
    assert.equal(noNote.status, 400);
    assert.equal(handle.store.prepays.get(prepayId)?.status, "overdue_flagged");
    const chased = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/chase`, {
      outcome: "no_result",
      note: "供应商失联",
    });
    assert.equal(chased.status, 200, JSON.stringify(chased.body));
    assert.equal(chased.body.outcome, "no_result");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "chasing");

    const reclaim = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/reclaim`);
    assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
    assert.equal(reclaim.body.amount, "40.00");
    assert.equal(reclaim.body.status, "requested");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "reclaim_requested");
    const receiveBlocked = await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" });
    assert.equal(receiveBlocked.status, 409);
    assert.equal(receiveBlocked.body.error, "PREPAY_RECLAIM_OPEN");

    const granted = await call(app, people.admin, "POST", `/api/users/${people.admin.user.id}/roles`, {
      roles: ["admin", "cashier"],
    });
    assert.equal(granted.status, 200);
    const self = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/reclaim/execute`, {
      outcome: "reclaimed",
      bankRef: "BANK-SELF",
      reversalVoucherRef: "REV-SELF",
    });
    assert.equal(self.status, 409);
    assert.equal(self.body.error, "RECLAIM_EXECUTOR_CONFLICT");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "reclaim_requested");
    assert.equal(handle.store.reclaims.get(reclaim.body.id)?.executorId, null);

    const settled = await call(app, people.cashier, "POST", `/api/prepay/${prepayId}/reclaim/execute`, {
      outcome: "reclaimed",
      bankRef: "BANK-RECLAIM",
      reversalVoucherRef: "REV-LOCAL-1",
    });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.status, "reclaimed");
    assert.equal(settled.body.reversalVoucherRef, "REV-LOCAL-1");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "reclaimed");
    assert.equal(handle.store.pos.get(po.id)?.status, "closed");
    assert.equal(handle.store.payments.size, 0);
    const closedList = await call(app, people.finance, "GET", "/api/prepay-overdue");
    assert.equal(closedList.body.items.length, 0);
    assert.ok(
      auditsOf(handle, "RECLAIM", reclaim.body.id).some((row) => row.comment.includes("不回写金蝶")),
    );
  } finally {
    await app.close();
  }
});

test("TC-①-E2 承诺未到期不能追索，到期后可以挂纠纷", async () => {
  const time = clockAt(START);
  const { app, handle } = await boot({ clock: time.clock });
  try {
    const { people, po, prepayId } = await paidAwaiting(app, "E-PROMISE");
    time.advanceDays(30);
    assert.equal((await call(app, people.finance, "POST", "/api/prepay-overdue/scan")).status, 200);
    const chased = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/chase`, {
      outcome: "promised",
      note: "下周到货",
      promisedDeliveryDate: "2026-02-15",
    });
    assert.equal(chased.status, 200, JSON.stringify(chased.body));
    assert.equal(handle.store.prepays.get(prepayId)?.promisedDeliveryDate, "2026-02-15");
    const early = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/reclaim`);
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "PROMISE_OPEN");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "chasing");

    time.state.at = new Date("2026-02-15T00:00:00.000Z");
    const still = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/reclaim`);
    assert.equal(still.status, 409);
    assert.equal(still.body.error, "PROMISE_OPEN");

    time.state.at = new Date("2026-02-16T00:00:00.000Z");
    const reclaim = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/reclaim`);
    assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
    const missing = await call(app, people.cashier, "POST", `/api/prepay/${prepayId}/reclaim/execute`, {
      outcome: "disputed",
    });
    assert.equal(missing.status, 400);
    assert.equal(handle.store.prepays.get(prepayId)?.status, "reclaim_requested");
    const disputed = await call(app, people.cashier, "POST", `/api/prepay/${prepayId}/reclaim/execute`, {
      outcome: "disputed",
      disputeReason: "VENDOR_DENY",
    });
    assert.equal(disputed.status, 200, JSON.stringify(disputed.body));
    assert.equal(disputed.body.status, "disputed");
    assert.equal(handle.store.prepays.get(prepayId)?.status, "disputed");
    assert.equal(handle.store.pos.get(po.id)?.status, "awaiting_receipt");
    const received = await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" });
    assert.equal(received.status, 409);
    assert.equal(received.body.error, "PREPAY_RECLAIM_OPEN");
  } finally {
    await app.close();
  }
});

test("TC-①-E 到货退出跟催，之后不再进入超期清单", async () => {
  const time = clockAt(START);
  const { app, handle } = await boot({ clock: time.clock });
  try {
    const { people, po, prepayId } = await paidAwaiting(app, "E-ARRIVE");
    time.advanceDays(30);
    assert.equal((await call(app, people.finance, "POST", "/api/prepay-overdue/scan")).body.flagged[0], prepayId);
    const chased = await call(app, people.admin, "POST", `/api/prepay/${prepayId}/chase`, {
      outcome: "promised",
      note: "改期",
      promisedDeliveryDate: "2026-03-01",
    });
    assert.equal(chased.status, 200, JSON.stringify(chased.body));
    const received = await call(app, people.applicant, "POST", `/api/po/${po.id}/receive`, { result: "accepted" });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(handle.store.prepays.get(prepayId)?.status, "awaiting_delivery");
    assert.equal(handle.store.prepays.get(prepayId)?.overdueFlag, false);
    const list = await call(app, people.finance, "GET", "/api/prepay-overdue");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.items.length, 0);
    assert.equal(handle.store.chases.size, 1);
  } finally {
    await app.close();
  }
});
