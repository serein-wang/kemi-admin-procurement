import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import {
  companyForCurrency,
  prepayThresholdKey,
  reimburseThresholdKey,
  thresholdKey,
  type CurrencyCode,
} from "../domain/thresholds.js";
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
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 0;
    if (statusCode === 413) {
      return reply.status(413).send({ error: "PAYLOAD_TOO_LARGE", message: "请求体过大" });
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

  function rejectReason(request: FastifyRequest): string {
    const input = body(request);
    return text(input.reason ?? input.comment);
  }

  app.get("/health", async () => ({ ok: true, module: "admin-procurement", phase: 4, kingdeeWriteback: "deferred" }));

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(page);
  });

  app.get("/api/meta", async () => {
    const ready = (currency: CurrencyCode) =>
      (["fin", "ceo", "rfq", "capex"] as const).every((kind) => options.thresholds[thresholdKey(currency, kind)] != null);
    const matrix = (currency: CurrencyCode) => ({
      companyCode: companyForCurrency(currency),
      currency,
      configured: {
        fin: options.thresholds[thresholdKey(currency, "fin")] != null,
        ceo: options.thresholds[thresholdKey(currency, "ceo")] != null,
        rfq: options.thresholds[thresholdKey(currency, "rfq")] != null,
        capex: options.thresholds[thresholdKey(currency, "capex")] != null,
        prepayFin: options.thresholds[prepayThresholdKey(currency, "fin")] != null,
        prepayCeo: options.thresholds[prepayThresholdKey(currency, "ceo")] != null,
        prepayContract: options.thresholds[prepayThresholdKey(currency, "contract")] != null,
        reim: options.thresholds[reimburseThresholdKey(currency)] != null,
      },
    });
    return {
      devLogin: options.allowDevLogin,
      demoUsers: options.allowDevLogin ? handle.demoUsers : [],
      thresholdReady: { CNY: ready("CNY"), HKD: ready("HKD") },
      reimburseReady: {
        CNY: options.thresholds.THR_CNY_REIM != null,
        HKD: options.thresholds.THR_HKD_REIM != null,
      },
      prepayOverdueDaysConfigured: options.prepayPolicy?.overdueDays != null,
      matrices: { SZ: matrix("CNY"), HK: matrix("HKD") },
      kingdeeWriteback: "deferred",
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

  app.get("/api/todos", async (request) => {
    const session = requireSession(request);
    return { todos: handle.service.listTodos(session.userId) };
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

  app.post("/api/pr", { bodyLimit: 14 * 1024 * 1024 }, async (request) => {
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

  app.get("/api/attachments/:id", async (request, reply) => {
    requireSession(request);
    const image = handle.service.readLineImage((request.params as { id: string }).id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("Content-Disposition", `inline; filename="${image.filename}"`);
    return reply.type(image.mime).send(image.bytes);
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
    return handle.service.rejectDept(session.userId, (request.params as { id: string }).id, rejectReason(request));
  });

  app.post("/api/pr/:id/finance-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectFinance(session.userId, (request.params as { id: string }).id, rejectReason(request));
  });

  app.post("/api/pr/:id/ceo-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectCeo(session.userId, (request.params as { id: string }).id, rejectReason(request));
  });

  app.post("/api/pr/:id/cancel", async (request) => {
    const session = requireSession(request);
    return handle.service.cancelPr(session.userId, (request.params as { id: string }).id);
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

  app.post("/api/po/:id/cancel", async (request) => {
    const session = requireSession(request);
    return handle.service.cancelPo(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/po/:id/close", async (request) => {
    const session = requireSession(request);
    return handle.service.closePaidPo(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/po/:id/receive-batch", async (request) => {
    const session = requireSession(request);
    return handle.service.receiveBatch(session.userId, (request.params as { id: string }).id, {
      result: text(body(request).result),
    });
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

  app.get("/api/assets/:id", async (request) => {
    requireSession(request);
    return handle.service.getAsset((request.params as { id: string }).id);
  });

  app.post("/api/assets/:id/transfer", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.transferAsset(session.userId, (request.params as { id: string }).id, {
      custodianId: text(input.custodianId),
      location: text(input.location),
    });
  });

  app.post("/api/assets/:id/retire", async (request) => {
    const session = requireSession(request);
    return handle.service.retireAsset(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.get("/api/budget-holds", async (request) => {
    requireSession(request);
    return { holds: handle.service.listBudgetHolds() };
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

  app.post("/api/prepay", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    const proforma = input.proforma;
    const proformaBody = proforma && typeof proforma === "object" && !Array.isArray(proforma)
      ? proforma as Record<string, unknown>
      : null;
    return handle.service.createPrepay(session.userId, {
      poId: text(input.poId),
      amount: text(input.amount),
      contractNo: text(input.contractNo),
      proforma: proformaBody
        ? {
            invoiceNo: text(proformaBody.invoiceNo),
            amount: text(proformaBody.amount),
            tax: text(proformaBody.tax) || "0.00",
          }
        : null,
    });
  });

  app.get("/api/prepay/:id", async (request) => {
    requireSession(request);
    return handle.service.getPrepay((request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/submit", async (request) => {
    const session = requireSession(request);
    return handle.service.submitPrepay(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/dept-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePrepayDept(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/prepay/:id/dept-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectPrepayDept(
      session.userId,
      (request.params as { id: string }).id,
      rejectReason(request),
    );
  });

  app.post("/api/prepay/:id/finance-cosign", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePrepayFinance(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/prepay/:id/ceo-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePrepayCeo(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/prepay/:id/payment-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePrepayPayment(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/pay", async (request) => {
    const session = requireSession(request);
    return handle.service.payPrepay(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).bankRef),
    );
  });

  app.post("/api/prepay/:id/accrue", async (request) => {
    const session = requireSession(request);
    return handle.service.accruePrepay(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).voucherRef),
    );
  });

  app.post("/api/prepay/:id/settle", async (request) => {
    const session = requireSession(request);
    return handle.service.settlePrepay(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/refund", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.requestPrepayRefund(session.userId, (request.params as { id: string }).id, {
      mode: text(input.mode),
      reasonCode: text(input.reasonCode),
    });
  });

  app.post("/api/prepay/:id/refund/approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePrepayRefund(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/refund/execute", async (request) => {
    const session = requireSession(request);
    return handle.service.executePrepayRefund(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).bankRef),
    );
  });

  app.get("/api/prepay-overdue", async (request) => {
    requireSession(request);
    return handle.service.listPrepayOverdue();
  });

  app.post("/api/prepay-overdue/scan", async (request) => {
    const session = requireSession(request);
    return handle.service.scanPrepayOverdue(session.userId);
  });

  app.post("/api/prepay/:id/chase", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.recordPrepayChase(session.userId, (request.params as { id: string }).id, {
      outcome: text(input.outcome),
      note: text(input.note),
      promisedDeliveryDate: text(input.promisedDeliveryDate),
    });
  });

  app.post("/api/prepay/:id/reclaim", async (request) => {
    const session = requireSession(request);
    return handle.service.requestPrepayReclaim(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/prepay/:id/reclaim/execute", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.executePrepayReclaim(session.userId, (request.params as { id: string }).id, {
      outcome: text(input.outcome),
      bankRef: text(input.bankRef),
      reversalVoucherRef: text(input.reversalVoucherRef),
      disputeReason: text(input.disputeReason),
    });
  });

  app.post("/api/pre", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.createPreApproval(session.userId, {
      companyCode: text(input.companyCode),
      currency: text(input.currency),
      deptId: text(input.deptId),
      purpose: text(input.purpose),
      amount: text(input.amount),
    });
  });

  app.get("/api/pre/:id", async (request) => {
    requireSession(request);
    return handle.service.getPreApproval((request.params as { id: string }).id);
  });

  app.post("/api/pre/:id/submit", async (request) => {
    const session = requireSession(request);
    return handle.service.submitPreApproval(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/pre/:id/dept-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approvePreApproval(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/pre/:id/dept-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectPreApproval(
      session.userId,
      (request.params as { id: string }).id,
      rejectReason(request),
    );
  });

  app.post("/api/pre/:id/cancel", async (request) => {
    const session = requireSession(request);
    return handle.service.cancelPreApproval(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/exp", async (request) => {
    const session = requireSession(request);
    const input = body(request);
    return handle.service.createExpense(session.userId, {
      preApprovalId: text(input.preApprovalId),
      purpose: text(input.purpose),
      amount: text(input.amount),
      invoiceNos: input.invoiceNos,
      employeeAccount: text(input.employeeAccount),
    });
  });

  app.get("/api/exp/:id", async (request) => {
    requireSession(request);
    return handle.service.getExpense((request.params as { id: string }).id);
  });

  app.post("/api/exp/:id/submit", async (request) => {
    const session = requireSession(request);
    return handle.service.submitExpense(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/exp/:id/dept-approve", async (request) => {
    const session = requireSession(request);
    return handle.service.approveExpenseDept(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/exp/:id/dept-reject", async (request) => {
    const session = requireSession(request);
    return handle.service.rejectExpenseDept(
      session.userId,
      (request.params as { id: string }).id,
      rejectReason(request),
    );
  });

  app.post("/api/exp/:id/cancel", async (request) => {
    const session = requireSession(request);
    return handle.service.cancelExpense(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/exp/:id/ticket-check", async (request) => {
    const session = requireSession(request);
    return handle.service.checkExpenseTicket(session.userId, (request.params as { id: string }).id);
  });

  app.post("/api/exp/:id/finance-cosign", async (request) => {
    const session = requireSession(request);
    return handle.service.cosignExpense(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).comment),
    );
  });

  app.post("/api/exp/:id/pay", async (request) => {
    const session = requireSession(request);
    return handle.service.payExpense(
      session.userId,
      (request.params as { id: string }).id,
      text(body(request).bankRef),
    );
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
