import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { thresholdKey, type CurrencyCode } from "../domain/thresholds.js";
import type { ModuleHandle, ModuleOptions, SessionRecord } from "../host.js";

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/index.html"), "utf8");
const SESSION_COOKIE = "ap_session";
const STATE_COOKIE = "ap_oidc_state";
const SESSION_MS = 8 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

export async function registerRoutes(
  app: FastifyInstance,
  options: ModuleOptions,
  handle: ModuleHandle,
): Promise<void> {
  const sessions = handle.sessions;
  const states = new Map<string, number>();

  const prefix = options.routePrefix ?? "";
  const page = PAGE.replaceAll("__PREFIX__", prefix);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.httpStatus).send({
        error: error.code,
        message: error.message,
        sodViolationCode: error.sodViolationCode ?? null,
      });
    }
    request.log.error({ err: error }, "unhandled");
    return reply.status(500).send({ error: "INTERNAL", message: "服务器错误" });
  });

  function cookieOptions() {
    return { httpOnly: true, sameSite: "lax" as const, path: "/" };
  }

  function readSession(request: FastifyRequest): SessionRecord | null {
    const id = request.cookies[SESSION_COOKIE];
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  function requireSession(request: FastifyRequest): SessionRecord {
    const session = readSession(request);
    if (!session) throw new DomainError("UNAUTHENTICATED", "未登录", 401);
    return session;
  }

  function startSession(reply: FastifyReply, userId: string, accessToken: string | null): void {
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { userId, accessToken, expiresAt: Date.now() + SESSION_MS });
    reply.setCookie(SESSION_COOKIE, id, { ...cookieOptions(), maxAge: SESSION_MS / 1000 });
  }

  function body(request: FastifyRequest): Record<string, unknown> {
    if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
      return request.body as Record<string, unknown>;
    }
    return {};
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  app.get("/health", async () => ({ ok: true, module: "admin-procurement", phase: 1 }));

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(page);
  });

  app.get("/api/meta", async () => {
    const ready = (currency: CurrencyCode) =>
      (["fin", "ceo", "rfq", "capex"] as const).every((kind) => options.thresholds[thresholdKey(currency, kind)] != null);
    return {
      devLogin: options.allowDevLogin,
      demoUsers: options.allowDevLogin ? handle.demoUsers : [],
      thresholdReady: { CNY: ready("CNY"), HKD: ready("HKD") },
    };
  });

  app.get("/auth/login", async (_request, reply) => {
    const state = randomBytes(16).toString("hex");
    states.set(state, Date.now() + STATE_MS);
    reply.setCookie(STATE_COOKIE, state, { ...cookieOptions(), maxAge: STATE_MS / 1000 });
    return reply.redirect(options.oidc.buildAuthorizeUrl(state));
  });

  app.get("/auth/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const state = query.state ?? "";
    const cookieState = request.cookies[STATE_COOKIE] ?? "";
    const expires = states.get(state);
    states.delete(state);
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (!state || state !== cookieState || !expires || expires < Date.now()) {
      throw new DomainError("OIDC_STATE", "登录 state 无效或已过期", 400);
    }
    const token = await options.oidc.exchangeCode(query.code ?? "");
    const profile = token.user?.sub ? token.user : await options.oidc.fetchUserInfo(token.access_token);
    const user = handle.service.upsertFromOidc(profile);
    startSession(reply, user.id, token.access_token);
    return reply.redirect(`${prefix}/`);
  });

  app.post("/auth/dev-login", async (request, reply) => {
    if (!options.allowDevLogin) {
      throw new DomainError("DEV_LOGIN_DISABLED", "开发登录未开启", 404);
    }
    const ucUserId = text(body(request).ucUserId);
    const user = handle.service.userByUc(ucUserId);
    if (user.status !== "active") {
      throw new DomainError("USER_PENDING", "账号尚未授予本模块角色", 403);
    }
    startSession(reply, user.id, null);
    return { ok: true, user: handle.service.publicUser(user) };
  });

  app.post("/auth/logout", async (request, reply) => {
    const id = request.cookies[SESSION_COOKIE];
    if (id) sessions.delete(id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const session = requireSession(request);
    const user = handle.store.users.get(session.userId);
    if (!user) throw new DomainError("UNAUTHENTICATED", "会话用户不存在", 401);
    return { user: handle.service.publicUser(user) };
  });

  app.get("/auth/userinfo", async (request) => {
    const session = requireSession(request);
    if (!session.accessToken) {
      throw new DomainError("NO_ACCESS_TOKEN", "当前会话没有 KEMI access_token", 400);
    }
    const profile = await options.oidc.fetchUserInfo(session.accessToken);
    const user = handle.service.upsertFromOidc(profile);
    return { user: handle.service.publicUser(user), profile };
  });

  app.get("/api/workspace", async (request) => {
    requireSession(request);
    return handle.service.workspace();
  });

  app.get("/api/audit", async (request) => {
    requireSession(request);
    const query = request.query as { entity?: string; entityId?: string };
    return { audits: handle.service.listAudit({ entity: query.entity, entityId: query.entityId }) };
  });

  app.post("/api/users/:id/roles", async (request) => {
    const session = requireSession(request);
    const params = request.params as { id: string };
    const roles = body(request).roles;
    if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
      throw new DomainError("INVALID_ROLE", "roles 必须是字符串数组");
    }
    return { user: handle.service.setRoles(session.userId, params.id, roles) };
  });

  app.post("/api/pr", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.createPr(session.userId, {
      companyCode: text(input.companyCode),
      currency: text(input.currency),
      deptId: text(input.deptId),
      purpose: text(input.purpose),
      capexHint: Boolean(input.capexHint),
      budgetId: typeof input.budgetId === "string" ? input.budgetId : null,
      lines: Array.isArray(input.lines) ? input.lines as never : [],
    });
  });

  app.get("/api/pr/:id", async (request) => {
    requireSession(request);
    return handle.service.getPr((request.params as { id: string }).id);
  });

  app.post("/api/pr/:id/submit", async (request) => {
    const session = requireSession(request);
    return handle.service.submitPr(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/pr/:id/dept-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approveDept(session.userId, (request.params as { id: string }).id, text(body(request).comment));
  });

  app.post("/api/pr/:id/dept-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectDept(session.userId, (request.params as { id: string }).id, text(body(request).comment));
  });

  app.post("/api/pr/:id/finance-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approveFinance(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/pr/:id/ceo-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approveCeo(session.userId, (request.params as { id: string }).id, text(body(request).comment));
  });

  app.post("/api/pr/:id/rfq", async (request) => {
    const session = requireSession(request);
    const quotes = body(request).quotes;
    if (!Array.isArray(quotes)) throw new DomainError("RFQ_QUOTES", "quotes 必须是数组", 422);
    return handle.service.recordRfq(session.userId, (request.params as { id: string }).id, quotes as never);
  });

  app.post("/api/pr/:id/rfq-waive", async (request) => {
    const session = requireSession(request);
    return handle.service.waiveRfq(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).reasonCode),
    );
  });

  app.post("/api/pr/:id/issue-po", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    const days = input.paymentTermsDays;
    return handle.service.issuePo(session.userId, (request.params as { id: string }).id, {
      paymentTerms: text(input.paymentTerms),
      paymentTermsDays: typeof days === "number" ? days : null,
      vendorName: text(input.vendorName),
    });
  });

  app.get("/api/po/:id", async (request) => {
    requireSession(request);
    return handle.service.getPo((request.params as { id: string }).id);
  });

  app.post("/api/po/:id/receive", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.receive(session.userId, (request.params as { id: string }).id, {
      result: text(input.result),
      qtyReceived: typeof input.qtyReceived === "number" ? input.qtyReceived : undefined,
    });
  });

  app.post("/api/po/:id/proxy-receipt", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.openProxyReceipt(session.userId, (request.params as { id: string }).id, {
      qtyReceived: typeof input.qtyReceived === "number" ? input.qtyReceived : undefined,
    });
  });

  app.post("/api/grn/:id/confirm", async (request) => {
    const session = requireSession(request);
    return handle.service.confirmGrn(session.userId, (request.params as { id: string }).id, {
      result: text(body(request).result),
    });
  });

  app.post("/api/po/:id/expense", async (request) => {
    const session = requireSession(request);
    return handle.service.postExpense(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/po/:id/asset-card", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.createAssetCard(session.userId, (request.params as { id: string }).id, {
      custodianId: text(input.custodianId),
      location: text(input.location),
      name: text(input.name),
    });
  });

  app.post("/api/invoices", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.registerInvoice(session.userId, {
      poId: text(input.poId),
      invoiceNo: text(input.invoiceNo),
      invoiceType: text(input.invoiceType),
      amount: text(input.amount),
      tax: text(input.tax),
    });
  });

  app.post("/api/matches", async (request) => {
    const session = requireSession(request);
    return handle.service.matchThreeWay(session.userId, text(body(request).poId));
  });

  app.post("/api/payments", async (request) => {
    const session = requireSession(request);
    return handle.service.requestPayment(session.userId, text(body(request).poId));
  });

  app.get("/api/payments/:id", async (request) => {
    requireSession(request);
    return handle.service.getPayment((request.params as { id: string }).id);
  });

  app.post("/api/payments/:id/finance-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePayment(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/payments/:id/pay", async (request) => {
    const session = requireSession(request);
    return handle.service.pay(session.userId, (request.params as { id: string }).id, text(body(request).bankRef));
  });
}
