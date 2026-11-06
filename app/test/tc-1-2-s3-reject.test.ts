import assert from "node:assert/strict";
import test from "node:test";
import { auditsOf, boot, call, createSubmitted, login } from "./helpers.js";

test("TC-①-2-S3-reject 申请人不得部门自批", async () => {
  const { app, handle } = await boot();
  try {
    const applicant = await login(app, "uc-applicant");
    const admin = await login(app, "uc-admin");
    const granted = await call(app, admin, "POST", `/api/users/${applicant.user.id}/roles`, {
      roles: ["applicant", "dept"],
    });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.body.user.roles, ["applicant", "dept"]);

    const pr = await createSubmitted(app, applicant);
    const rejected = await call(app, applicant, "POST", `/api/pr/${pr.id}/dept-approve`);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "SOD_VIOLATION");
    assert.equal(rejected.body.sodViolationCode, "S3");

    const stored = handle.store.prs.get(pr.id);
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.deptApproverId, null);
    const violation = auditsOf(handle, "PR", pr.id).find((row) => row.sodViolationCode === "S3");
    assert.ok(violation);
    assert.equal(violation?.fromStatus, "submitted");
    assert.equal(violation?.toStatus, "submitted");
  } finally {
    await app.close();
  }
});
