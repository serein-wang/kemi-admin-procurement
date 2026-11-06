import assert from "node:assert/strict";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { emptyThresholds, type ThresholdConfig } from "../src/domain/thresholds.js";
import type { ModuleHandle } from "../src/host.js";
import { registerAdminProcurement } from "../src/module.js";
import type { OidcClient } from "../src/oidc/client.js";
import { ErpProInboundStub } from "../src/erp/inbound.js";

/**
 * 夹具数字只用于断言审批路由，不是业务阈值，也不是程序默认值。
 * 低额 < 10000；高额 ≥ 50000；比价 ≥ 1000；资本化 ≥ 8000。
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
};

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
  allowDevLogin?: boolean;
  oidc?: OidcClient;
  seedDemoUsers?: boolean;
}) {
  const app = Fastify({ logger: false });
  const erp = new ErpProInboundStub();
  const handle = await registerAdminProcurement(app, {
    thresholds: options?.thresholds ?? FIXTURE_THRESHOLDS,
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
