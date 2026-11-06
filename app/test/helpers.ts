import assert from "node:assert/strict";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { emptyPrepayPolicy, emptyThresholds, type PrepayPolicy, type ThresholdConfig } from "../src/domain/thresholds.js";
import type { ModuleHandle } from "../src/host.js";
import { registerAdminProcurement } from "../src/module.js";
import type { OidcClient } from "../src/oidc/client.js";
import { ErpProInboundStub } from "../src/erp/inbound.js";

/**
 * 夹具数字只用于断言审批路由，不是业务阈值，也不是程序默认值。
 * 请购：低额 < 10000；高额 ≥ 50000；比价 ≥ 1000；资本化 ≥ 8000。
 * 预付：低额 < 3000；高额 ≥ 20000；合同强制 ≥ 8000。比例上限 0.80。
 */
export const FIXTURE_THRESHOLDS: ThresholdConfig = {
  ...emptyThresholds(),
  THR_CNY_FIN: "10000.00",
  THR_CNY_CEO: "50000.00",
  THR_HKD_FIN: "10000.00",
  THR_HKD_CEO: "50000.00",
  THR_CNY_RFQ: "1000.00",
  THR_HKD_RFQ: "1000.00",
  THR_CNY_CAPEX: "8000.00",
  THR_HKD_CAPEX: "8000.00",
  THR_CNY_PREPAY_FIN: "3000.00",
  THR_CNY_PREPAY_CEO: "20000.00",
  THR_HKD_PREPAY_FIN: "3000.00",
  THR_HKD_PREPAY_CEO: "20000.00",
  THR_CNY_PREPAY_CONTRACT: "8000.00",
  THR_HKD_PREPAY_CONTRACT: "8000.00",
};

export const FIXTURE_PREPAY_POLICY: PrepayPolicy = {
  ratioMax: "0.80",
  allowFullPrepay: false,
  inheritPrMatrix: false,
};

export { emptyPrepayPolicy };

const fakeOidc: OidcClient = {
  buildAuthorizeUrl(state: string) {
    return `https://kemi.example/oauth/authorize?state=${state}`;
  },
  async exchangeCode() {
    return {
      access_token: "test-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      user: { sub: "42", nickname: "OIDC 用户", username: "oidc", email: "oidc@example.com" },
    };
  },
  async fetchUserInfo() {
    return { sub: "42", nickname: "OIDC 用户", username: "oidc" };
  },
};

export async function boot(options?: {
  thresholds?: ThresholdConfig;
  prepayPolicy?: PrepayPolicy;
  allowDevLogin?: boolean;
  oidc?: OidcClient;
  seedDemoUsers?: boolean;
}) {
  const app = Fastify({ logger: false });
  const erp = new ErpProInboundStub();
  const handle = await registerAdminProcurement(app, {
    thresholds: options?.thresholds ?? FIXTURE_THRESHOLDS,
    prepayPolicy: options?.prepayPolicy ?? FIXTURE_PREPAY_POLICY,
    oidc: options?.oidc ?? fakeOidc,
    allowDevLogin: options?.allowDevLogin ?? true,
    seedDemoUsers: options?.seedDemoUsers ?? true,
    sessionSecret: "test-session-secret-value",
    erp,
  });
  return { app, handle, erp };
}

export interface Session {
  cookie: string;
  user: { id: string; ucUserId: string; displayName: string; roles: string[]; status: string };
}

function cookiePair(response: LightMyRequestResponse): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(first, "missing set-cookie");
  return first.split(";")[0] ?? "";
}

export async function login(app: FastifyInstance, ucUserId: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/dev-login",
    payload: { ucUserId },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookiePair(response), user: response.json().user };
}

export async function call(
  app: FastifyInstance,
  session: Session,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown> | unknown[],
) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: session.cookie },
    payload,
  });
  return { status: response.statusCode, body: response.json() };
}

export async function createSubmitted(
  app: FastifyInstance,
  applicant: Session,
  input?: { qty?: number; estUnitPrice?: string; category?: string; currency?: string; purpose?: string },
) {
  const created = await call(app, applicant, "POST", "/api/pr", {
    companyCode: "SZ",
    currency: input?.currency ?? "CNY",
    deptId: "D-ADMIN",
    purpose: input?.purpose ?? "会议室显示器",
    lines: [
      {
        itemName: "显示器",
        qty: input?.qty ?? 2,
        estUnitPrice: input?.estUnitPrice ?? "1500.00",
        category: input?.category ?? "consumable",
      },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const submitted = await call(app, applicant, "POST", `/api/pr/${created.body.id}/submit`);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted.body as { id: string; amount: string; status: string };
}

export function auditsOf(handle: ModuleHandle, entity: string, entityId: string) {
  return handle.store.audits.filter((row) => row.entity === entity && row.entityId === entityId);
}

export async function loginActors(app: FastifyInstance) {
  return {
    applicant: await login(app, "uc-applicant"),
    dept: await login(app, "uc-dept"),
    admin: await login(app, "uc-admin"),
    finance: await login(app, "uc-finance"),
    ceo: await login(app, "uc-ceo"),
    cashier: await login(app, "uc-cashier"),
  };
}

export async function issueTermsPo(
  app: FastifyInstance,
  people: Awaited<ReturnType<typeof loginActors>>,
  input: { unitPrice: string; qty?: number; paymentTerms: "after_delivery" | "monthly" | "prepay"; purpose?: string },
) {
  const pr = await createSubmitted(app, people.applicant, {
    qty: input.qty ?? 1,
    estUnitPrice: input.unitPrice,
    purpose: input.purpose ?? "预付夹具",
  });
  let current = await call(app, people.dept, "POST", `/api/pr/${pr.id}/dept-approve`);
  assert.equal(current.status, 200, JSON.stringify(current.body));
  if (current.body.status === "dept_approved") {
    current = await call(app, people.finance, "POST", `/api/pr/${pr.id}/finance-approve`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
  }
  if (current.body.status === "finance_approved") {
    current = await call(app, people.ceo, "POST", `/api/pr/${pr.id}/ceo-approve`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
  }
  assert.equal(current.body.status, "sourcing", JSON.stringify(current.body));
  if (current.body.rfqRequired) {
    const quoted = await call(app, people.admin, "POST", `/api/pr/${pr.id}/rfq`, {
      quotes: [
        { vendorName: "供应商甲", amount: pr.amount, leadTimeDays: 3, selected: true },
        { vendorName: "供应商乙", amount: pr.amount, leadTimeDays: 4, selected: false },
        { vendorName: "供应商丙", amount: pr.amount, leadTimeDays: 5, selected: false },
      ],
    });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  } else {
    const waived = await call(app, people.admin, "POST", `/api/pr/${pr.id}/rfq-waive`, { reasonCode: "BELOW_RFQ" });
    assert.equal(waived.status, 200, JSON.stringify(waived.body));
  }
  const po = await call(app, people.admin, "POST", `/api/pr/${pr.id}/issue-po`, {
    paymentTerms: input.paymentTerms,
    vendorName: "夹具供应商",
  });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  return po.body as { id: string; amount: string; status: string; paymentTerms: string };
}
