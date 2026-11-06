import { parseCategory } from "../domain/categories.js";
import { DomainError } from "../domain/errors.js";
import {
  addAmount,
  compareAmount,
  formatRatio,
  lineAmount,
  parseAmount,
  subtractAmount,
  withinRatio,
} from "../domain/money.js";
import { isRole, type Role } from "../domain/roles.js";
import {
  approvalBand,
  prepayThresholdKey,
  reimburseThresholdKey,
  thresholdKey,
  type ApprovalBand,
  type CurrencyCode,
  type PrepayPolicy,
  type PrepayThresholdKind,
  type ThresholdConfig,
  type ThresholdKind,
} from "../domain/thresholds.js";
import type {
  AssetCard,
  AuditLog,
  ChaseOutcome,
  CompanyCode,
  CreatePrInput,
  Dp2Result,
  ExpenseClaim,
  Grn,
  InvoiceRegister,
  MatchSheet,
  OverdueChase,
  OverdueListItem,
  Payment,
  PaymentTerms,
  PreApproval,
  PrepayAttachment,
  PrepayReclaim,
  PrepayRefund,
  PrepayRequest,
  PrepaySettle,
  PrLine,
  PublicUser,
  PurchaseOrder,
  PurchaseRequisition,
  QuoteInput,
  User,
} from "../domain/types.js";
import type { ErpProInboundPort } from "../erp/inbound.js";
import { displayNameFromProfile, type OidcUserProfile } from "../oidc/client.js";
import { MemoryStore } from "../store/memory.js";

export interface ServiceDeps {
  store: MemoryStore;
  thresholds: ThresholdConfig;
  prepayPolicy: PrepayPolicy;
  erp: ErpProInboundPort;
  clock?: () => Date;
}

/**
 * 路径①货到付款 / 月结 / 预付（①-P*）/ 例外（①-E*）与路径②报销。
 * 状态以 docs/02、docs/03、docs/04、docs/06 为准。
 * SoD 在迁移前拒绝，不提供绕过。
 * Q5：require_pre_approval 固定为 true，没有配置开关。
 * 不做金蝶回写。入库仍走行政物资 stub。
 */
export class ProcurementService {
  private readonly store: MemoryStore;
  private readonly thresholds: ThresholdConfig;
  private readonly prepayPolicy: PrepayPolicy;
  private readonly erp: ErpProInboundPort;
  private readonly clock: () => Date;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.thresholds = deps.thresholds;
    this.prepayPolicy = deps.prepayPolicy;
    this.erp = deps.erp;
    this.clock = deps.clock ?? (() => new Date());
  }

  upsertFromOidc(profile: OidcUserProfile): User {
    const ucUserId = String(profile.sub ?? "").trim();
    if (!ucUserId) this.fail("OIDC_INVALID_SUBJECT", "userinfo 缺少 sub", 400);
    const existingId = this.store.userIdByUc.get(ucUserId);
    const now = this.now();
    if (existingId) {
      const existing = this.store.users.get(existingId)!;
      existing.displayName = displayNameFromProfile(profile);
      existing.email = profile.email ?? existing.email;
      existing.username = profile.username ?? profile.preferred_username ?? existing.username;
      existing.updatedAt = now;
      return existing;
    }
    const user: User = {
      id: this.store.nextId("USR"),
      ucUserId,
      displayName: displayNameFromProfile(profile),
      email: profile.email ?? null,
      username: profile.username ?? profile.preferred_username ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.store.addUser(user);
    this.audit({
      entity: "USER",
      entityId: user.id,
      fromStatus: null,
      toStatus: "pending",
      actorId: user.id,
      comment: "OIDC 首次登录，等待应用内授予角色",
      skipped: false,
    });
    return user;
  }

  setRoles(actorId: string, targetUserId: string, roles: string[]): PublicUser {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "admin");
    const target = this.store.users.get(targetUserId);
    if (!target) this.fail("NOT_FOUND", "用户不存在", 404);
    const unique: Role[] = [];
    for (const role of roles) {
      if (!isRole(role)) this.fail("INVALID_ROLE", `未知角色 ${role}`);
      if (!unique.includes(role)) unique.push(role);
    }
    const now = this.now();
    this.store.replaceRoles(target.id, unique, actor.id, now);
    target.status = unique.length > 0 ? "active" : "pending";
    target.updatedAt = now;
    this.audit({
      entity: "USER",
      entityId: target.id,
      fromStatus: null,
      toStatus: target.status,
      actorId: actor.id,
      comment: `更新角色：${unique.join(",") || "（清空）"}`,
      skipped: false,
    });
    return this.publicUser(target);
  }

  publicUser(user: User): PublicUser {
    return {
      id: user.id,
      ucUserId: user.ucUserId,
      displayName: user.displayName,
      email: user.email,
      username: user.username,
      status: user.status,
      roles: this.store.rolesOf(user.id),
    };
  }

  listUsers(): PublicUser[] {
    return [...this.store.users.values()].map((user) => this.publicUser(user));
  }

  userByUc(ucUserId: string): User {
    const id = this.store.userIdByUc.get(ucUserId);
    if (!id) this.fail("NOT_FOUND", "本地用户不存在", 404);
    return this.store.users.get(id)!;
  }

  createPr(actorId: string, input: CreatePrInput): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "applicant");
    const companyCode = this.company(input.companyCode);
    const currency = this.currency(input.currency);
    const deptId = this.requiredText(input.deptId, "部门");
    const purpose = this.requiredText(input.purpose, "事由");
    if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) {
      this.fail("INVALID_LINES", "请购至少 1 行、至多 50 行");
    }
    const lines: PrLine[] = input.lines.map((line) => {
      const itemName = this.requiredText(line.itemName, "品名");
      const category = parseCategory(line.category);
      const qty = line.qty;
      const estAmount = lineAmount(qty, line.estUnitPrice);
      return {
        itemName,
        spec: (line.spec ?? "").trim(),
        qty,
        estUnitPrice: formatStored(line.estUnitPrice),
        estAmount,
        category,
      };
    });
    let amount = "0.00";
    for (const line of lines) amount = addAmount(amount, line.estAmount);
    const now = this.now();
    const id = this.store.nextId("PR");
    const pr: PurchaseRequisition = {
      id,
      docNo: id,
      companyCode,
      currency,
      amount,
      status: "draft",
      applicantId: actor.id,
      deptId,
      purpose,
      capexHint: Boolean(input.capexHint),
      budgetId: input.budgetId ?? null,
      reserveStatus: "none",
      deptApproverId: null,
      financeApproverId: null,
      ceoApproverId: null,
      financeGate: "pending",
      ceoGate: "pending",
      rfqRequired: null,
      rfqWaiverKind: null,
      rfqWaived: false,
      waiveReason: null,
      procurementClass: "admin_non_production",
      lines,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.prs.set(pr.id, pr);
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: null,
      toStatus: "draft",
      actorId: actor.id,
      comment: "①-1 创建请购草稿",
      skipped: false,
    });
    return clone(pr);
  }

  submitPr(actorId: string, prId: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.assertApplicant(actor, pr);
    this.assertStatus(pr.status, "draft", "请购");
    pr.status = "submitted";
    pr.reserveStatus = "soft";
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "draft",
      toStatus: "submitted",
      actorId: actor.id,
      comment: "①-1 提交请购；Q8 软占用",
      skipped: false,
    });
    return clone(pr);
  }

  approveDept(actorId: string, prId: string, comment?: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.assertStatus(pr.status, "submitted", "请购");
    this.requireRole(actor, "dept");
    if (actor.id === pr.applicantId) {
      this.sod(actor, "PR", pr.id, pr.status, "S3", "S3 申请人不得担任部门审批人");
    }
    const band = approvalBand(
      pr.amount,
      this.readThreshold(pr.currency, "fin"),
      this.readThreshold(pr.currency, "ceo"),
      thresholdKey(pr.currency, "fin"),
      thresholdKey(pr.currency, "ceo"),
    );
    // 低额会立刻进入比价判断，阈值缺失时不能先改状态。
    if (band === "low") this.readThreshold(pr.currency, "rfq");
    pr.deptApproverId = actor.id;
    pr.status = "dept_approved";
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "submitted",
      toStatus: "dept_approved",
      actorId: actor.id,
      comment: this.note("①-2 部门审批通过", comment),
      skipped: false,
    });
    if (band === "low") {
      pr.financeGate = "skipped";
      pr.ceoGate = "skipped";
      this.skipGate(pr, actor, "dept_approved", "finance_approved", "①-3 未达财务阈，跳过");
      this.skipGate(pr, actor, "finance_approved", "ceo_approved", "①-4 未达总经理阈，跳过");
      this.enterSourcing(pr, actor, "dept_approved");
    } else if (band === "mid") {
      pr.financeGate = "required";
      pr.ceoGate = "skipped";
    } else {
      pr.financeGate = "required";
      pr.ceoGate = "required";
    }
    return clone(pr);
  }

  rejectDept(actorId: string, prId: string, comment?: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.assertStatus(pr.status, "submitted", "请购");
    this.requireRole(actor, "dept");
    if (actor.id === pr.applicantId) {
      this.sod(actor, "PR", pr.id, pr.status, "S3", "S3 申请人不得担任部门审批人");
    }
    pr.status = "rejected";
    pr.reserveStatus = "released";
    pr.deptApproverId = actor.id;
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "submitted",
      toStatus: "rejected",
      actorId: actor.id,
      comment: this.note("①-2 部门驳回；释放软占用", comment),
      skipped: false,
    });
    return clone(pr);
  }

  approveFinance(actorId: string, prId: string, comment?: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.assertStatus(pr.status, "dept_approved", "请购");
    if (pr.financeGate !== "required") this.fail("INVALID_STATE", "当前请购不需要财务加签", 409);
    this.requireRole(actor, "finance");
    if (pr.ceoGate === "skipped") this.readThreshold(pr.currency, "rfq");
    pr.financeApproverId = actor.id;
    pr.financeGate = "approved";
    pr.status = "finance_approved";
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "dept_approved",
      toStatus: "finance_approved",
      actorId: actor.id,
      comment: this.note("①-3 财务加签通过", comment),
      skipped: false,
    });
    if (pr.ceoGate === "skipped") {
      this.skipGate(pr, actor, "finance_approved", "ceo_approved", "①-4 未达总经理阈，跳过");
      this.enterSourcing(pr, actor, "finance_approved");
    } else if (pr.ceoGate !== "required") {
      this.fail("INVALID_STATE", "总经理关卡状态异常", 409);
    }
    return clone(pr);
  }

  approveCeo(actorId: string, prId: string, comment?: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.assertStatus(pr.status, "finance_approved", "请购");
    if (pr.ceoGate !== "required") this.fail("INVALID_STATE", "当前请购不需要总经理审批", 409);
    this.requireRole(actor, "ceo");
    this.readThreshold(pr.currency, "rfq");
    pr.ceoApproverId = actor.id;
    pr.ceoGate = "approved";
    pr.status = "ceo_approved";
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "finance_approved",
      toStatus: "ceo_approved",
      actorId: actor.id,
      comment: this.note("①-4 总经理审批通过", comment),
      skipped: false,
    });
    this.enterSourcing(pr, actor, "ceo_approved");
    return clone(pr);
  }

  recordRfq(actorId: string, prId: string, quotes: QuoteInput[]): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.requireRole(actor, "admin");
    this.assertStatus(pr.status, "sourcing", "请购");
    if (pr.rfqRequired !== true) this.fail("INVALID_STATE", "未达比价门槛，请填写免比价原因码", 409);
    if (this.store.quoteByPr(pr.id)) this.fail("INVALID_STATE", "比价已登记", 409);
    if (!Array.isArray(quotes) || quotes.length < 3) {
      this.fail("RFQ_QUOTES", "达门槛时至少登记 3 家报价", 422);
    }
    const names = new Set<string>();
    let selected = 0;
    let selectedName = "";
    const normalized = quotes.map((quote) => {
      const vendorName = this.requiredText(quote.vendorName, "供应商");
      if (names.has(vendorName)) this.fail("RFQ_QUOTES", "供应商名称重复", 422);
      names.add(vendorName);
      if (!Number.isInteger(quote.leadTimeDays) || quote.leadTimeDays < 0) {
        this.fail("RFQ_QUOTES", "交期必须是非负整数天", 422);
      }
      parseAmount(quote.amount);
      if (quote.selected) {
        selected += 1;
        selectedName = vendorName;
      }
      return {
        vendorName,
        amount: formatStored(quote.amount),
        leadTimeDays: quote.leadTimeDays,
        selected: Boolean(quote.selected),
      };
    });
    if (selected !== 1) this.fail("RFQ_QUOTES", "必须且只能选定 1 家供应商", 422);
    const vendor = this.store.upsertVendor(selectedName);
    const id = this.store.nextId("RFQ");
    this.store.quotes.set(id, {
      id,
      prId: pr.id,
      quotes: normalized,
      selectedVendorId: vendor.id,
      comparerId: actor.id,
      createdAt: this.now(),
    });
    const from = pr.status;
    pr.status = "ready_for_po";
    pr.updatedAt = this.now();
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: from,
      toStatus: "ready_for_po",
      actorId: actor.id,
      comment: `①-5 三家比价，选定 ${selectedName}`,
      skipped: false,
    });
    return clone(pr);
  }

  waiveRfq(actorId: string, prId: string, reasonCode: string): PurchaseRequisition {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.requireRole(actor, "admin");
    this.assertStatus(pr.status, "sourcing", "请购");
    if (pr.rfqRequired !== false || !pr.rfqWaiverKind) {
      this.fail("RFQ_REQUIRED", "已达比价门槛，不能免比价", 409);
    }
    const reason = this.requiredText(reasonCode, "免比价原因码");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(reason)) {
      this.fail("INVALID_REASON", "免比价原因码仅允许字母、数字、下划线和连字符");
    }
    pr.rfqWaived = true;
    pr.waiveReason = reason;
    const from = pr.status;
    pr.status = "ready_for_po";
    pr.updatedAt = this.now();
    const skippedReason = pr.rfqWaiverKind === "low_value" ? "low_value_waiver" : "below_threshold";
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: from,
      toStatus: "ready_for_po",
      actorId: actor.id,
      comment: `①-5 免比价，原因码 ${reason}`,
      skipped: true,
      skippedReason,
    });
    return clone(pr);
  }

  issuePo(
    actorId: string,
    prId: string,
    input: { paymentTerms: string; paymentTermsDays?: number | null; vendorName?: string },
  ): PurchaseOrder {
    const actor = this.requireUser(actorId);
    const pr = this.pr(prId);
    this.requireRole(actor, "admin");
    this.assertStatus(pr.status, "ready_for_po", "请购");
    const terms = this.paymentTerms(input.paymentTerms);
    let days: number | null = null;
    if (terms === "monthly") {
      const value = input.paymentTermsDays;
      if (!Number.isInteger(value) || value! < 1 || value! > 365) {
        this.fail("INVALID_TERMS", "月结必须填写 1 到 365 的账期天数");
      }
      days = value!;
    } else if (input.paymentTermsDays != null) {
      this.fail("INVALID_TERMS", "只有月结填写账期天数");
    }
    const quote = this.store.quoteByPr(pr.id);
    let vendorId: string;
    if (quote) {
      vendorId = quote.selectedVendorId;
    } else {
      const vendorName = this.requiredText(input.vendorName ?? "", "供应商");
      vendorId = this.store.upsertVendor(vendorName).id;
    }
    const now = this.now();
    const id = this.store.nextId("PO");
    const po: PurchaseOrder = {
      id,
      docNo: id,
      prId: pr.id,
      companyCode: pr.companyCode,
      currency: pr.currency,
      amount: pr.amount,
      status: "issued",
      applicantId: pr.applicantId,
      issuerId: actor.id,
      vendorId,
      paymentTerms: terms,
      paymentTermsDays: days,
      lines: pr.lines.map((line) => ({ ...line })),
      disposition: "unset",
      dispositionDone: false,
      erpInboundRefs: [],
      reserveStatus: "hard",
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.pos.set(po.id, po);
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: null,
      toStatus: "issued",
      actorId: actor.id,
      comment: "①-6 下行政采购单",
      skipped: false,
    });
    const parked = terms === "prepay" ? "awaiting_prepay" : "awaiting_receipt";
    po.status = parked;
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: "issued",
      toStatus: parked,
      actorId: actor.id,
      comment: terms === "prepay" ? "D6=prepay，进入待预付" : `D6=${terms}，待收货`,
      skipped: false,
    });
    pr.status = "closed_converted";
    pr.reserveStatus = "hard";
    pr.updatedAt = now;
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus: "ready_for_po",
      toStatus: "closed_converted",
      actorId: actor.id,
      comment: "请购转 PO；Q8 软占用转为硬占用",
      skipped: false,
    });
    return clone(po);
  }

  receive(
    actorId: string,
    poId: string,
    input: { result: string; qtyReceived?: number },
  ): Grn {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.assertReceivable(po);
    if (actor.id === po.issuerId) {
      this.sod(actor, "PO", po.id, po.status, "S1", "S1 下单人不得验收（PO.issuer ≠ GRN.accepter）");
    }
    if (actor.id !== po.applicantId) {
      this.fail("FORBIDDEN_ROLE", "①-7 默认由请购申请人验收", 403);
    }
    const qty = this.qtyOrRemaining(po, input.qtyReceived);
    const result = this.receiptResult(input.result);
    if (result !== "rejected") this.readThreshold(po.currency, "capex");
    return this.confirmNewGrn(actor, po, qty, result, null);
  }

  openProxyReceipt(actorId: string, poId: string, input: { qtyReceived?: number }): Grn {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.assertReceivable(po);
    if (actor.id === po.issuerId) {
      this.sod(actor, "PO", po.id, po.status, "S1", "S1 代收人不得为下单人");
    }
    this.requireRole(actor, "admin");
    const qty = this.qtyOrRemaining(po, input.qtyReceived);
    const now = this.now();
    const id = this.store.nextId("GRN");
    const grn: Grn = {
      id,
      docNo: id,
      poId: po.id,
      accepterId: null,
      proxyReceiverId: actor.id,
      receivedAt: null,
      result: null,
      status: "draft",
      qtyReceived: qty,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.grns.set(grn.id, grn);
    this.audit({
      entity: "GRN",
      entityId: grn.id,
      fromStatus: null,
      toStatus: "draft",
      actorId: actor.id,
      comment: "①-7 行政代收登记，待申请人确认",
      skipped: false,
    });
    return clone(grn);
  }

  confirmGrn(actorId: string, grnId: string, input: { result: string }): Grn {
    const actor = this.requireUser(actorId);
    const grn = this.grn(grnId);
    if (grn.status !== "draft") this.fail("INVALID_STATE", "收货单不是待确认", 409);
    const po = this.po(grn.poId);
    this.assertReceivable(po);
    if (actor.id === po.issuerId) {
      this.sod(actor, "GRN", grn.id, grn.status, "S1", "S1 下单人不得验收（PO.issuer ≠ GRN.accepter）");
    }
    if (actor.id !== po.applicantId) {
      this.fail("FORBIDDEN_ROLE", "①-7 须申请人确认验收", 403);
    }
    const result = this.receiptResult(input.result);
    if (result !== "rejected") this.readThreshold(po.currency, "capex");
    grn.accepterId = actor.id;
    grn.result = result;
    grn.receivedAt = this.now();
    grn.updatedAt = grn.receivedAt;
    if (result === "rejected") {
      grn.status = "rejected";
      this.audit({
        entity: "GRN",
        entityId: grn.id,
        fromStatus: "draft",
        toStatus: "rejected",
        actorId: actor.id,
        comment: "①-7 验收拒收",
        skipped: false,
      });
      return clone(grn);
    }
    grn.status = "confirmed";
    this.audit({
      entity: "GRN",
      entityId: grn.id,
      fromStatus: "draft",
      toStatus: "confirmed",
      actorId: actor.id,
      comment: `①-7 申请人确认代收，结果 ${result}`,
      skipped: false,
    });
    this.applyReceipt(po, actor);
    return clone(grn);
  }

  async postExpense(actorId: string, poId: string): Promise<PurchaseOrder> {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.requireRole(actor, "admin");
    if (po.status !== "fully_received") this.fail("INVALID_STATE", "须全部收货后才能费用化", 409);
    if (po.disposition !== "expense") this.fail("NEED_ASSET_CARD", "D4 判定为固定资产，请建卡", 409);
    if (po.dispositionDone) this.fail("INVALID_STATE", "费用化已完成", 409);
    const inboundLines = po.lines
      .filter((line) => line.category === "consumable" || line.category === "low_value")
      .map((line) => ({ itemName: line.itemName, qty: line.qty, category: line.category }));
    if (inboundLines.length > 0) {
      const ack = await this.erp.pushAdminInbound({
        sourceDocNo: po.docNo,
        companyCode: po.companyCode,
        lines: inboundLines,
        sessionKind: "admin_inbound",
      });
      po.erpInboundRefs.push(ack.ref);
    }
    po.dispositionDone = true;
    po.updatedAt = this.now();
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: po.status,
      toStatus: po.status,
      actorId: actor.id,
      comment: inboundLines.length > 0 ? "①-8b 费用化，并提交行政入库 stub" : "①-8b 费用化（纯服务，不入库）",
      skipped: false,
    });
    return clone(po);
  }

  createAssetCard(
    actorId: string,
    poId: string,
    input: { custodianId: string; location: string; name?: string },
  ): AssetCard {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.requireRole(actor, "admin");
    if (po.status !== "fully_received") this.fail("INVALID_STATE", "须全部收货后才能建卡", 409);
    if (po.disposition !== "asset") this.fail("NOT_CAPEX", "D4 判定为费用化，不建资产卡", 409);
    if (po.dispositionDone) this.fail("INVALID_STATE", "资产卡已建立", 409);
    const custodian = this.store.users.get(input.custodianId);
    if (!custodian) this.fail("NOT_FOUND", "保管人不存在", 404);
    const location = this.requiredText(input.location, "存放位置");
    const grn = this.confirmedGrns(po)[0];
    if (!grn) this.fail("INVALID_STATE", "缺少已确认收货单", 409);
    const now = this.now();
    const id = this.store.nextId("AST");
    const card: AssetCard = {
      id,
      docNo: id,
      assetNo: id,
      name: this.requiredText(input.name ?? po.lines[0]?.itemName ?? "资产", "资产名称"),
      poId: po.id,
      grnId: grn.id,
      custodianId: custodian.id,
      location,
      creatorId: actor.id,
      capitalizedAmount: po.amount,
      status: "active",
      createdAt: now,
    };
    this.store.assets.set(card.id, card);
    po.dispositionDone = true;
    po.updatedAt = now;
    this.audit({
      entity: "ASSET",
      entityId: card.id,
      fromStatus: null,
      toStatus: "active",
      actorId: actor.id,
      comment: "①-8a 固定资产建卡。S4 细则待定，本期不拦截建卡人与保管人",
      skipped: false,
    });
    return clone(card);
  }

  registerInvoice(
    actorId: string,
    input: { poId: string; invoiceNo: string; invoiceType: string; amount: string; tax: string },
  ): InvoiceRegister {
    const actor = this.requireUser(actorId);
    const po = this.po(input.poId);
    this.requireRole(actor, "finance");
    if (po.status !== "fully_received") this.fail("INVALID_STATE", "须完成收货且尚未匹配才能登记发票", 409);
    if (!po.dispositionDone) this.fail("DISPOSITION_PENDING", "请先完成 ①-8a 建卡或 ①-8b 费用化", 409);
    if (this.store.invoiceByPo(po.id)) this.fail("INVALID_STATE", "该采购单已登记正式发票", 409);
    const invoiceNo = this.requiredText(input.invoiceNo, "发票号码");
    this.assertInvoiceNoFree(invoiceNo);
    if (input.invoiceType === "proforma") {
      this.fail("PROFORMA_NOT_FOR_SETTLEMENT", "形式发票只能用于启动预付，不能作为①-9正式进项发票", 422);
    }
    const invoiceType = input.invoiceType === "special" || input.invoiceType === "general" ? input.invoiceType : null;
    if (!invoiceType) this.fail("INVALID_INVOICE", "发票类型仅为 special、general 或 proforma");
    parseAmount(input.tax);
    const amount = formatStored(input.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_AMOUNT", "发票金额必须大于 0");
    let formalOf: string | null = null;
    if (po.paymentTerms === "prepay") {
      const prepay = this.livePrepay(po.id);
      if (!prepay || prepay.status !== "awaiting_delivery") {
        this.fail("INVALID_STATE", "预付尚未挂账待到货，不能登记正式发票", 409);
      }
      formalOf = prepay.proformaInvoiceId;
    } else if (compareAmount(amount, po.amount) !== 0) {
      this.fail("MATCH_AMOUNT_MISMATCH", "发票金额必须等于采购单金额。本期不设容差阈值", 422);
    }
    const now = this.now();
    const id = this.store.nextId("INV");
    const invoice: InvoiceRegister = {
      id,
      docNo: id,
      invoiceNo,
      invoiceType,
      kind: "formal",
      formalOf,
      amount,
      tax: formatStored(input.tax),
      poId: po.id,
      createdBy: actor.id,
      createdAt: now,
    };
    this.store.invoices.set(invoice.id, invoice);
    this.audit({
      entity: "INV",
      entityId: invoice.id,
      fromStatus: null,
      toStatus: "registered",
      actorId: actor.id,
      comment: formalOf ? "①-9 登记正式进项发票，并保留形式发票关联" : "①-9 登记进项发票",
      skipped: false,
    });
    return clone(invoice);
  }

  matchThreeWay(actorId: string, poId: string): MatchSheet {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.requireRole(actor, "finance");
    if (po.status !== "fully_received") this.fail("INVALID_STATE", "采购单尚未处于可匹配状态", 409);
    if (!po.dispositionDone) this.fail("DISPOSITION_PENDING", "请先完成 ①-8a 或 ①-8b", 409);
    const invoice = this.store.invoiceByPo(po.id);
    if (!invoice) {
      if (po.paymentTerms === "prepay" && this.livePrepay(po.id)?.proformaInvoiceId) {
        this.fail("FORMAL_INVOICE_REQUIRED", "三单匹配与核销必须以正式进项发票为准", 422);
      }
      this.fail("INVALID_STATE", "尚未登记发票", 409);
    }
    if (invoice.kind !== "formal") {
      this.fail("FORMAL_INVOICE_REQUIRED", "三单匹配与核销必须以正式进项发票为准", 422);
    }
    const grns = this.confirmedGrns(po);
    if (grns.length !== 1) this.fail("INVALID_STATE", "匹配需要恰好一张已确认收货单", 409);
    let prepayId: string | null = null;
    let prepayAmount: string | null = null;
    if (po.paymentTerms === "prepay") {
      const prepay = this.livePrepay(po.id);
      if (!prepay || prepay.status !== "awaiting_delivery") {
        this.fail("INVALID_STATE", "预付尚未挂账待到货，不能匹配", 409);
      }
      prepayId = prepay.id;
      prepayAmount = prepay.amount;
    } else if (compareAmount(invoice.amount, po.amount) !== 0) {
      this.fail("MATCH_AMOUNT_MISMATCH", "三单金额不一致", 422);
    }
    const now = this.now();
    const id = this.store.nextId("MAT");
    const match: MatchSheet = {
      id,
      docNo: id,
      poId: po.id,
      grnId: grns[0]!.id,
      invoiceId: invoice.id,
      prepayId,
      prepayAmount,
      matchResult: "matched",
      matchedBy: actor.id,
      createdAt: now,
    };
    this.store.matches.set(match.id, match);
    const from = po.status;
    po.status = "matched";
    po.updatedAt = now;
    this.audit({
      entity: "MATCH",
      entityId: match.id,
      fromStatus: null,
      toStatus: "matched",
      actorId: actor.id,
      comment: prepayId
        ? "①-10 三单匹配通过；已核对预付额，正式发票。匹配人记为记账人"
        : "①-10 三单匹配通过；匹配人记为记账人",
      skipped: false,
    });
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "matched",
      actorId: actor.id,
      comment: "采购单进入已匹配",
      skipped: false,
    });
    return clone(match);
  }

  requestPayment(actorId: string, poId: string): Payment {
    const actor = this.requireUser(actorId);
    const po = this.po(poId);
    this.requireRole(actor, "admin");
    const live = this.livePrepay(po.id);
    if (po.paymentTerms === "prepay" || live) {
      return this.requestTailOrReject(actor, po, live);
    }
    if (po.status !== "matched") this.fail("INVALID_STATE", "须三单匹配后才能发起付款", 409);
    if (this.store.paymentByPo(po.id)) this.fail("INVALID_STATE", "付款申请已存在", 409);
    const match = this.store.matchByPo(po.id);
    if (!match) this.fail("INVALID_STATE", "缺少匹配单", 409);
    return this.openPayment(actor, po, match, "po_balance", po.amount, "①-11 发起付款申请");
  }

  private requestTailOrReject(
    actor: User,
    po: PurchaseOrder,
    live: PrepayRequest | undefined,
  ): Payment {
    const settle = live ? this.store.settleByPrepay(live.id) : undefined;
    const tailOk = live?.status === "settled_with_balance" && settle?.dp2Result === "short";
    if (!tailOk || !live || !settle) {
      this.fail(
        "FULL_PAYMENT_EXCLUSIVE",
        "预付与全款付款互斥。未核销为尾款前不能付款，也不能按采购单全额另付一笔",
        409,
      );
    }
    if (this.store.paymentByPo(po.id)) {
      this.fail("FULL_PAYMENT_EXCLUSIVE", "该采购单已有付款申请，不能重复支付", 409);
    }
    if (po.status !== "matched") this.fail("INVALID_STATE", "须三单匹配后才能发起尾款", 409);
    const invoice = this.store.invoiceByPo(po.id);
    const match = this.store.matchByPo(po.id);
    if (!invoice || !match) this.fail("INVALID_STATE", "缺少正式发票或匹配单", 409);
    const tail = subtractAmount(invoice.amount, live.amount);
    if (compareAmount(tail, "0.00") <= 0) {
      this.fail("FULL_PAYMENT_EXCLUSIVE", "没有应付尾款", 409);
    }
    const payment = this.openPayment(actor, po, match, "prepay_tail", tail, "①-P9 发起尾款（复用①-11）");
    settle.tailPayId = payment.id;
    return payment;
  }

  private openPayment(
    actor: User,
    po: PurchaseOrder,
    match: MatchSheet,
    sourceType: Payment["sourceType"],
    amount: string,
    comment: string,
  ): Payment {
    const now = this.now();
    const id = this.store.nextId("PAY");
    const payment: Payment = {
      id,
      docNo: id,
      sourceType,
      poId: po.id,
      matchId: match.id,
      companyCode: po.companyCode,
      currency: po.currency,
      amount,
      status: "submitted",
      requestedBy: actor.id,
      financeApproverId: null,
      payerId: null,
      voucherCreatorId: match.matchedBy,
      paidAt: null,
      bankRef: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.payments.set(payment.id, payment);
    const from = po.status;
    po.status = "payment_pending";
    po.updatedAt = now;
    this.audit({
      entity: "PAY",
      entityId: payment.id,
      fromStatus: null,
      toStatus: "submitted",
      actorId: actor.id,
      comment,
      skipped: false,
    });
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "payment_pending",
      actorId: actor.id,
      comment: sourceType === "prepay_tail" ? "采购单待付尾款" : "采购单待付款",
      skipped: false,
    });
    return clone(payment);
  }

  approvePayment(actorId: string, paymentId: string): Payment {
    const actor = this.requireUser(actorId);
    const payment = this.payment(paymentId);
    this.requireRole(actor, "finance");
    this.assertStatus(payment.status, "submitted", "付款");
    payment.financeApproverId = actor.id;
    payment.status = "finance_approved";
    payment.updatedAt = this.now();
    this.audit({
      entity: "PAY",
      entityId: payment.id,
      fromStatus: "submitted",
      toStatus: "finance_approved",
      actorId: actor.id,
      comment: payment.sourceType === "prepay_tail"
        ? "①-12 财务批准尾款（①-P9）。总经理是否复用请购高额档仍待确认，本期不另加节点"
        : "①-12 财务批准付款。总经理是否复用请购高额档仍待确认，本期不另加节点",
      skipped: false,
    });
    return clone(payment);
  }

  pay(actorId: string, paymentId: string, bankRef: string): Payment {
    const actor = this.requireUser(actorId);
    const payment = this.payment(paymentId);
    this.requireRole(actor, "cashier");
    this.assertStatus(payment.status, "finance_approved", "付款");
    if (actor.id === payment.voucherCreatorId) {
      this.sod(
        actor,
        "PAY",
        payment.id,
        payment.status,
        "S2",
        "S2 记账人不得付款（voucher.creator ≠ payment.payer）",
      );
    }
    const ref = this.requiredText(bankRef, "银行回单号");
    if (ref.length > 64) this.fail("INVALID_BANK_REF", "银行回单号过长");
    const po = this.po(payment.poId);
    payment.payerId = actor.id;
    payment.bankRef = ref;
    payment.paidAt = this.now();
    payment.status = "paid";
    payment.updatedAt = payment.paidAt;
    const from = po.status;
    po.status = "paid";
    po.updatedAt = payment.paidAt;
    const tail = payment.sourceType === "prepay_tail";
    this.audit({
      entity: "PAY",
      entityId: payment.id,
      fromStatus: "finance_approved",
      toStatus: "paid",
      actorId: actor.id,
      comment: tail ? "①-13 出纳付尾款（①-P9）" : "①-13 出纳付款",
      skipped: false,
    });
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "paid",
      actorId: actor.id,
      comment: tail ? "采购单尾款已付" : "采购单已付款",
      skipped: false,
    });
    return clone(payment);
  }

  createPrepay(
    actorId: string,
    input: {
      poId: string;
      amount: string;
      contractNo?: string | null;
      proforma?: { invoiceNo: string; amount: string; tax?: string } | null;
    },
  ): PrepayRequest {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "admin");
    const po = this.po(input.poId);
    if (po.paymentTerms !== "prepay") {
      this.fail("PREPAY_TERMS_REQUIRED", "只有 D6=prepay 的采购单可以提预付", 409);
    }
    if (po.status !== "awaiting_prepay") this.fail("INVALID_STATE", "采购单不在待预付", 409);
    if (this.livePrepay(po.id)) this.fail("PREPAY_OPEN", "该采购单已有未关闭的预付申请", 409);
    if (this.store.paymentByPo(po.id)) {
      this.fail("FULL_PAYMENT_EXCLUSIVE", "该采购单已有付款申请，不能再提预付", 409);
    }
    const amount = formatStored(input.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_AMOUNT", "预付金额必须大于 0");
    if (compareAmount(amount, po.amount) > 0) this.fail("PREPAY_EXCEEDS_PO", "预付金额不能超过采购单金额", 422);
    const contractNo = this.optionalText(input.contractNo, "合同号");
    const proforma = input.proforma ?? null;
    if (!contractNo && !proforma) {
      this.fail("ATTACHMENT_REQUIRED", "预付必须关联采购单，并附合同或形式发票之一", 422);
    }
    const now = this.now();
    let proformaInvoiceId: string | null = null;
    const attachments: PrepayAttachment[] = [{ kind: "po", ref: po.docNo }];
    if (contractNo) attachments.push({ kind: "contract", ref: contractNo });
    if (proforma) {
      proformaInvoiceId = this.addProforma(actor, po, proforma, now);
      const stored = this.store.invoices.get(proformaInvoiceId)!;
      attachments.push({ kind: "proforma", ref: stored.invoiceNo });
    }
    const id = this.store.nextId("PPY");
    const prepay: PrepayRequest = {
      id,
      docNo: id,
      poId: po.id,
      companyCode: po.companyCode,
      currency: po.currency,
      amount,
      ratio: null,
      status: "draft",
      applicantId: actor.id,
      deptApproverId: null,
      financeCosignerId: null,
      ceoApproverId: null,
      paymentApproverId: null,
      payerId: null,
      bankRef: null,
      paidAt: null,
      overdueFlag: false,
      promisedDeliveryDate: null,
      accrualBy: null,
      accrualVoucherRef: null,
      financeGate: "pending",
      ceoGate: "pending",
      fullPrepay: false,
      attachments,
      contractNo,
      proformaInvoiceId,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.prepays.set(prepay.id, prepay);
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: null,
      toStatus: "draft",
      actorId: actor.id,
      comment: "①-P1 创建预付申请草稿",
      skipped: false,
    });
    return clone(prepay);
  }

  submitPrepay(actorId: string, prepayId: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    const po = this.po(prepay.poId);
    if (actor.id !== prepay.applicantId) this.fail("FORBIDDEN_ROLE", "只有预付申请人可以提交", 403);
    this.assertStatus(prepay.status, "draft", "预付");
    const contractLine = this.readPrepayMoney(po.currency, "contract");
    if (compareAmount(prepay.amount, contractLine) >= 0 && !prepay.contractNo) {
      this.fail("CONTRACT_REQUIRED", "预付额已达合同阈值，必须附合同", 422);
    }
    if (!prepay.contractNo && !prepay.proformaInvoiceId) {
      this.fail("ATTACHMENT_REQUIRED", "预付必须附合同或形式发票之一", 422);
    }
    const full = compareAmount(prepay.amount, po.amount) === 0;
    if (full && !this.prepayPolicy.allowFullPrepay) {
      this.fail("FULL_PREPAY_NOT_ALLOWED", "未开启全额预付。预付额必须小于采购单", 422);
    }
    if (!full) {
      const ratio = this.prepayPolicy.ratioMax;
      if (ratio == null) this.fail("THRESHOLD_NOT_CONFIGURED", "PREPAY_RATIO_MAX 仍为占位符，未注入数值", 422);
      if (!withinRatio(prepay.amount, po.amount, ratio)) {
        this.fail("PREPAY_RATIO_EXCEEDED", "预付比例超过 PREPAY_RATIO_MAX", 422);
      }
    }
    prepay.fullPrepay = full;
    prepay.ratio = formatRatio(prepay.amount, po.amount);
    prepay.status = "submitted";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "draft",
      toStatus: "submitted",
      actorId: actor.id,
      comment: full ? "①-P1 提交全额预付" : "①-P1 提交预付申请",
      skipped: false,
    });
    return clone(prepay);
  }

  approvePrepayDept(actorId: string, prepayId: string, comment?: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "submitted", "预付");
    this.requireRole(actor, "dept");
    if (actor.id === prepay.applicantId) {
      this.sod(actor, "PREPAY", prepay.id, prepay.status, "S3", "S3 预付申请人不得担任部门审批人");
    }
    const band = this.prepayBand(prepay);
    prepay.deptApproverId = actor.id;
    prepay.status = "dept_approved";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "submitted",
      toStatus: "dept_approved",
      actorId: actor.id,
      comment: this.note("①-P2 部门审批通过", comment),
      skipped: false,
    });
    this.routePrepayBand(prepay, actor, band);
    return clone(prepay);
  }

  rejectPrepayDept(actorId: string, prepayId: string, comment?: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "submitted", "预付");
    this.requireRole(actor, "dept");
    if (actor.id === prepay.applicantId) {
      this.sod(actor, "PREPAY", prepay.id, prepay.status, "S3", "S3 预付申请人不得担任部门审批人");
    }
    prepay.deptApproverId = actor.id;
    prepay.status = "rejected";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "submitted",
      toStatus: "rejected",
      actorId: actor.id,
      comment: this.note("①-P2 部门驳回", comment),
      skipped: false,
    });
    return clone(prepay);
  }

  approvePrepayFinance(actorId: string, prepayId: string, comment?: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "dept_approved", "预付");
    if (prepay.financeGate !== "required") this.fail("INVALID_STATE", "当前预付不需要财务加签", 409);
    this.requireRole(actor, "finance");
    prepay.financeCosignerId = actor.id;
    prepay.financeGate = "approved";
    prepay.status = "finance_cosigned";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "dept_approved",
      toStatus: "finance_cosigned",
      actorId: actor.id,
      comment: this.note("①-P3 财务加签通过", comment),
      skipped: false,
    });
    if (prepay.ceoGate === "skipped") {
      this.skipPrepay(prepay, actor, "finance_cosigned", "ceo_approved", "①-P4 未达预付总经理阈，跳过");
    }
    return clone(prepay);
  }

  approvePrepayCeo(actorId: string, prepayId: string, comment?: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "finance_cosigned", "预付");
    if (prepay.ceoGate !== "required") this.fail("INVALID_STATE", "当前预付不需要总经理审批", 409);
    this.requireRole(actor, "ceo");
    prepay.ceoApproverId = actor.id;
    prepay.ceoGate = "approved";
    prepay.status = "ceo_approved";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "finance_cosigned",
      toStatus: "ceo_approved",
      actorId: actor.id,
      comment: this.note("①-P4 总经理审批通过", comment),
      skipped: false,
    });
    return clone(prepay);
  }

  approvePrepayPayment(actorId: string, prepayId: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertReadyForPrepayPayment(prepay);
    this.requireRole(actor, "finance");
    if (actor.id === prepay.applicantId) {
      this.sod(actor, "PREPAY", prepay.id, prepay.status, "S5", "S5 预付申请人不得担任预付审批人");
    }
    const from = prepay.status;
    prepay.paymentApproverId = actor.id;
    prepay.status = "finance_payment_approved";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: from,
      toStatus: "finance_payment_approved",
      actorId: actor.id,
      comment: "①-P5 批准预付待付",
      skipped: false,
    });
    return clone(prepay);
  }

  payPrepay(actorId: string, prepayId: string, bankRef: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "finance_payment_approved", "预付");
    this.requireRole(actor, "cashier");
    if (!prepay.paymentApproverId) this.fail("INVALID_STATE", "缺少预付审批人", 409);
    if (actor.id === prepay.applicantId || actor.id === prepay.paymentApproverId) {
      this.sod(actor, "PREPAY", prepay.id, prepay.status, "S5", "S5 预付申请人、预付审批人、预付付款人必须互不相同");
    }
    const ref = this.requiredText(bankRef, "银行回单号");
    if (ref.length > 64) this.fail("INVALID_BANK_REF", "银行回单号过长");
    prepay.payerId = actor.id;
    prepay.bankRef = ref;
    prepay.paidAt = this.now();
    prepay.status = "paid";
    prepay.updatedAt = prepay.paidAt;
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "finance_payment_approved",
      toStatus: "paid",
      actorId: actor.id,
      comment: "①-P6 出纳付预付款",
      skipped: false,
    });
    return clone(prepay);
  }

  accruePrepay(actorId: string, prepayId: string, voucherRef: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "paid", "预付");
    this.requireRole(actor, "finance");
    const ref = this.requiredText(voucherRef, "预付凭证号");
    if (ref.length > 64) this.fail("INVALID_INPUT", "预付凭证号过长");
    const po = this.po(prepay.poId);
    if (po.status !== "awaiting_prepay") this.fail("INVALID_STATE", "采购单不在待预付", 409);
    prepay.accrualBy = actor.id;
    prepay.accrualVoucherRef = ref;
    prepay.status = "accrued";
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "paid",
      toStatus: "accrued",
      actorId: actor.id,
      comment: "①-P7 记预付账款（本地凭证号，不回写金蝶）",
      skipped: false,
    });
    prepay.status = "awaiting_delivery";
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "accrued",
      toStatus: "awaiting_delivery",
      actorId: actor.id,
      comment: "预付已挂账，等待到货",
      skipped: false,
    });
    const from = po.status;
    po.status = "awaiting_receipt";
    po.updatedAt = prepay.updatedAt;
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "awaiting_receipt",
      actorId: actor.id,
      comment: "预付完成，采购单转入待收货",
      skipped: false,
    });
    return clone(prepay);
  }

  settlePrepay(actorId: string, prepayId: string): PrepayRequest {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.requireRole(actor, "finance");
    this.assertStatus(prepay.status, "awaiting_delivery", "预付");
    if (this.store.settleByPrepay(prepay.id)) this.fail("INVALID_STATE", "预付已核销", 409);
    const po = this.po(prepay.poId);
    if (po.status !== "matched") this.fail("INVALID_STATE", "须三单匹配后才能核销预付", 409);
    const match = this.store.matchByPo(po.id);
    const invoice = this.store.invoiceByPo(po.id);
    if (!match || !invoice || invoice.kind !== "formal") {
      this.fail("FORMAL_INVOICE_REQUIRED", "核销必须以正式进项发票和三单匹配为准", 422);
    }
    if (match.prepayId !== prepay.id) this.fail("INVALID_STATE", "匹配单未核对这笔预付", 409);
    const result = this.dp2(prepay.amount, invoice.amount);
    const now = this.now();
    const settleId = this.store.nextId("STL");
    const settle: PrepaySettle = {
      id: settleId,
      docNo: settleId,
      prepayId: prepay.id,
      invoiceId: invoice.id,
      matchId: match.id,
      dp2Result: result,
      tailPayId: null,
      refundId: null,
      createdAt: now,
      createdBy: actor.id,
    };
    this.store.settles.set(settle.id, settle);
    prepay.status = "settling";
    prepay.updatedAt = now;
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "awaiting_delivery",
      toStatus: "settling",
      actorId: actor.id,
      comment: `①-P8 核销预付；D-P2=${result}`,
      skipped: false,
    });
    this.audit({
      entity: "SETTLE",
      entityId: settle.id,
      fromStatus: null,
      toStatus: result,
      actorId: actor.id,
      comment: "预付核销",
      skipped: false,
    });
    if (result === "equal") {
      prepay.status = "settled_equal";
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: "settling",
        toStatus: "settled_equal",
        actorId: actor.id,
        comment: "预付等于票额，无尾款",
        skipped: false,
      });
      this.closePo(po, actor, "预付与票额相等，采购单关闭");
    } else if (result === "short") {
      prepay.status = "settled_with_balance";
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: "settling",
        toStatus: "settled_with_balance",
        actorId: actor.id,
        comment: "预付小于票额，待①-P9尾款",
        skipped: false,
      });
    }
    return clone(prepay);
  }

  requestPrepayRefund(
    actorId: string,
    prepayId: string,
    input: { mode: string; reasonCode?: string },
  ): PrepayRefund {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "settling", "预付");
    const settle = this.store.settleByPrepay(prepay.id);
    if (!settle || settle.dp2Result !== "over") this.fail("INVALID_STATE", "只有溢付可以退款或挂账", 409);
    if (settle.refundId || this.store.refundByPrepay(prepay.id)) this.fail("INVALID_STATE", "溢付处理已存在", 409);
    const invoice = this.store.invoiceByPo(prepay.poId);
    if (!invoice) this.fail("INVALID_STATE", "缺少正式发票", 409);
    const amount = subtractAmount(prepay.amount, invoice.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_STATE", "没有溢付差额", 409);
    const now = this.now();
    const id = this.store.nextId("RFD");
    let mode: PrepayRefund["mode"];
    let status: PrepayRefund["status"];
    let financeApproverId: string | null = null;
    let reasonCode: string | null = null;
    if (input.mode === "refund") {
      this.requireRole(actor, "admin");
      mode = "refund";
      status = "requested";
    } else if (input.mode === "suspense") {
      this.requireRole(actor, "finance");
      mode = "suspense";
      reasonCode = this.reasonCode(input.reasonCode, "挂账原因码");
      status = "finance_approved";
      financeApproverId = actor.id;
    } else {
      this.fail("INVALID_INPUT", "溢付处理仅为 refund 或 suspense");
    }
    const refund: PrepayRefund = {
      id,
      docNo: id,
      prepayId: prepay.id,
      settleId: settle.id,
      mode,
      amount,
      status,
      requestedBy: actor.id,
      financeApproverId,
      executorId: null,
      reasonCode,
      bankRef: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.refunds.set(refund.id, refund);
    settle.refundId = refund.id;
    this.audit({
      entity: "REFUND",
      entityId: refund.id,
      fromStatus: null,
      toStatus: status,
      actorId: actor.id,
      comment: mode === "refund" ? "①-P10 行政发起退款" : `①-P10 财务负责人批准挂账，原因码 ${reasonCode}`,
      skipped: false,
    });
    return clone(refund);
  }

  approvePrepayRefund(actorId: string, prepayId: string): PrepayRefund {
    const actor = this.requireUser(actorId);
    const refund = this.refundOf(prepayId);
    this.requireRole(actor, "finance");
    if (refund.mode !== "refund") this.fail("INVALID_STATE", "挂账已由财务负责人批准", 409);
    this.assertStatus(refund.status, "requested", "退款");
    if (actor.id === refund.requestedBy) {
      this.fail("REFUND_SELF_APPROVAL", "退款申请人不得审批自己的退款", 409);
    }
    refund.financeApproverId = actor.id;
    refund.status = "finance_approved";
    refund.updatedAt = this.now();
    this.audit({
      entity: "REFUND",
      entityId: refund.id,
      fromStatus: "requested",
      toStatus: "finance_approved",
      actorId: actor.id,
      comment: "①-P10 财务批准退款",
      skipped: false,
    });
    return clone(refund);
  }

  executePrepayRefund(actorId: string, prepayId: string, bankRef?: string): PrepayRefund {
    const actor = this.requireUser(actorId);
    const prepay = this.prepay(prepayId);
    const refund = this.refundOf(prepay.id);
    this.assertStatus(refund.status, "finance_approved", "退款");
    this.assertStatus(prepay.status, "settling", "预付");
    if (!refund.financeApproverId) this.fail("INVALID_STATE", "缺少溢付审批人", 409);
    let ref: string | null = null;
    if (refund.mode === "refund") {
      this.requireRole(actor, "cashier");
      if (actor.id === refund.financeApproverId) {
        this.fail("REFUND_EXECUTOR_CONFLICT", "退款审批人不得执行收款", 409);
      }
      ref = this.requiredText(bankRef ?? "", "银行回单号");
      if (ref.length > 64) this.fail("INVALID_BANK_REF", "银行回单号过长");
    } else {
      this.requireRole(actor, "finance");
      if ((bankRef ?? "").trim()) this.fail("INVALID_INPUT", "挂账不填写银行回单号");
    }
    const po = this.po(prepay.poId);
    if (po.status !== "matched") this.fail("INVALID_STATE", "采购单不在可结清状态", 409);
    refund.executorId = actor.id;
    refund.bankRef = ref;
    refund.status = "executed";
    refund.updatedAt = this.now();
    prepay.status = "settled_with_refund";
    prepay.updatedAt = refund.updatedAt;
    this.audit({
      entity: "REFUND",
      entityId: refund.id,
      fromStatus: "finance_approved",
      toStatus: "executed",
      actorId: actor.id,
      comment: refund.mode === "refund" ? "①-P10 出纳执行退款" : "①-P10 确认挂账",
      skipped: false,
    });
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "settling",
      toStatus: "settled_with_refund",
      actorId: actor.id,
      comment: refund.mode === "refund" ? "溢付已退款" : "溢付已挂账",
      skipped: false,
    });
    this.closePo(po, actor, "溢付结清，采购单关闭");
    return clone(refund);
  }

  /**
   * ①-E1。财务按 PREPAY_OVERDUE_DAYS 列出已付未验收超期清单，并把仍在待到货的单据标成 overdue_flagged。
   * 天数未配置时拒绝，不套默认天数。
   */
  scanPrepayOverdue(actorId: string): {
    overdueDays: number;
    asOf: string;
    items: OverdueListItem[];
    flagged: string[];
  } {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "finance");
    const now = this.clock();
    const collected = this.collectOverdue(now);
    const flagged: string[] = [];
    for (const item of collected.items) {
      if (item.status !== "awaiting_delivery") continue;
      const prepay = this.prepay(item.prepayId);
      const from = prepay.status;
      prepay.overdueFlag = true;
      prepay.status = "overdue_flagged";
      prepay.updatedAt = now.toISOString();
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: from,
        toStatus: "overdue_flagged",
        actorId: actor.id,
        comment: `①-E1 超期清单：已付 ${item.ageDays} 天未验收，阈值 ${collected.overdueDays} 天`,
        skipped: false,
      });
      item.status = "overdue_flagged";
      item.flagged = true;
      flagged.push(prepay.id);
    }
    return { overdueDays: collected.overdueDays, asOf: now.toISOString(), items: collected.items, flagged };
  }

  listPrepayOverdue(): { overdueDays: number; asOf: string; items: OverdueListItem[] } {
    const now = this.clock();
    const collected = this.collectOverdue(now);
    return { overdueDays: collected.overdueDays, asOf: now.toISOString(), items: collected.items };
  }

  recordPrepayChase(
    actorId: string,
    prepayId: string,
    input: { outcome: string; note?: string; promisedDeliveryDate?: string },
  ): OverdueChase {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "admin");
    const prepay = this.prepay(prepayId);
    if (prepay.status !== "overdue_flagged" && prepay.status !== "chasing") {
      this.fail("INVALID_STATE", "只有超期清单中的预付可以跟催", 409);
    }
    const outcome = this.chaseOutcome(input.outcome);
    const note = this.requiredText(input.note ?? "", "跟催记录");
    let promisedDeliveryDate: string | null = null;
    if (outcome === "promised") {
      promisedDeliveryDate = this.isoDate(input.promisedDeliveryDate ?? "", "承诺交期");
      const today = utcDay(this.clock());
      if (promisedDeliveryDate <= today) {
        this.fail("INVALID_DATE", "承诺交期必须晚于今天", 422);
      }
    } else if ((input.promisedDeliveryDate ?? "").trim()) {
      this.fail("INVALID_INPUT", "无果跟催不填写承诺交期");
    }
    const now = this.now();
    const id = this.store.nextId("CHS");
    const chase: OverdueChase = {
      id,
      docNo: id,
      prepayId: prepay.id,
      outcome,
      note,
      promisedDeliveryDate,
      actorId: actor.id,
      createdAt: now,
    };
    this.store.chases.set(chase.id, chase);
    prepay.promisedDeliveryDate = promisedDeliveryDate;
    const from = prepay.status;
    if (from === "overdue_flagged") prepay.status = "chasing";
    prepay.updatedAt = now;
    if (from !== prepay.status) {
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: from,
        toStatus: prepay.status,
        actorId: actor.id,
        comment: outcome === "promised" ? `①-E2 跟催，供应商承诺 ${promisedDeliveryDate}` : "①-E2 跟催，无果",
        skipped: false,
      });
    }
    this.audit({
      entity: "CHASE",
      entityId: chase.id,
      fromStatus: null,
      toStatus: outcome,
      actorId: actor.id,
      comment: note,
      skipped: false,
    });
    return clone(chase);
  }

  requestPrepayReclaim(actorId: string, prepayId: string): PrepayReclaim {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "admin");
    const prepay = this.prepay(prepayId);
    this.assertStatus(prepay.status, "chasing", "预付");
    if (this.store.chasesByPrepay(prepay.id).length < 1) {
      this.fail("CHASE_REQUIRED", "追索前必须先有跟催记录", 409);
    }
    if (this.store.reclaimByPrepay(prepay.id)) this.fail("INVALID_STATE", "追索已存在", 409);
    const today = utcDay(this.clock());
    if (prepay.promisedDeliveryDate && prepay.promisedDeliveryDate >= today) {
      this.fail("PROMISE_OPEN", "供应商承诺交期未到，不能发起追索", 409);
    }
    const now = this.now();
    const id = this.store.nextId("RCL");
    const reclaim: PrepayReclaim = {
      id,
      docNo: id,
      prepayId: prepay.id,
      amount: prepay.amount,
      status: "requested",
      requestedBy: actor.id,
      executorId: null,
      bankRef: null,
      reversalVoucherRef: null,
      disputeReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.reclaims.set(reclaim.id, reclaim);
    prepay.status = "reclaim_requested";
    prepay.updatedAt = now;
    this.audit({
      entity: "RECLAIM",
      entityId: reclaim.id,
      fromStatus: null,
      toStatus: "requested",
      actorId: actor.id,
      comment: "①-E3 退款/追索申请",
      skipped: false,
    });
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: "chasing",
      toStatus: "reclaim_requested",
      actorId: actor.id,
      comment: "①-E3 追索启动",
      skipped: false,
    });
    return clone(reclaim);
  }

  executePrepayReclaim(
    actorId: string,
    prepayId: string,
    input: { outcome: string; bankRef?: string; reversalVoucherRef?: string; disputeReason?: string },
  ): PrepayReclaim {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "cashier");
    const prepay = this.prepay(prepayId);
    const reclaim = this.reclaimOf(prepay.id);
    this.assertStatus(prepay.status, "reclaim_requested", "预付");
    this.assertStatus(reclaim.status, "requested", "追索");
    if (actor.id === reclaim.requestedBy) {
      this.fail("RECLAIM_EXECUTOR_CONFLICT", "追索申请人不得执行收款", 409);
    }
    const po = this.po(prepay.poId);
    const now = this.now();
    if (input.outcome === "reclaimed") {
      const bankRef = this.requiredText(input.bankRef ?? "", "银行回单号");
      if (bankRef.length > 64) this.fail("INVALID_BANK_REF", "银行回单号过长");
      const reversalVoucherRef = this.requiredText(input.reversalVoucherRef ?? "", "冲预付凭证号");
      if (reversalVoucherRef.length > 64) this.fail("INVALID_INPUT", "冲预付凭证号过长");
      reclaim.bankRef = bankRef;
      reclaim.reversalVoucherRef = reversalVoucherRef;
      reclaim.status = "reclaimed";
      prepay.status = "reclaimed";
      this.audit({
        entity: "RECLAIM",
        entityId: reclaim.id,
        fromStatus: "requested",
        toStatus: "reclaimed",
        actorId: actor.id,
        comment: "①-E3b 出纳收款入账，并记本地冲预付凭证（不回写金蝶）",
        skipped: false,
      });
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: "reclaim_requested",
        toStatus: "reclaimed",
        actorId: actor.id,
        comment: "超期追索已结清",
        skipped: false,
      });
      this.closePo(po, actor, "①-E3b 追索结清，采购单关闭");
    } else if (input.outcome === "disputed") {
      if ((input.bankRef ?? "").trim() || (input.reversalVoucherRef ?? "").trim()) {
        this.fail("INVALID_INPUT", "挂纠纷不填写回单或冲预付凭证");
      }
      reclaim.disputeReason = this.reasonCode(input.disputeReason, "纠纷原因码");
      reclaim.status = "disputed";
      prepay.status = "disputed";
      this.audit({
        entity: "RECLAIM",
        entityId: reclaim.id,
        fromStatus: "requested",
        toStatus: "disputed",
        actorId: actor.id,
        comment: `①-E3b 挂纠纷，原因码 ${reclaim.disputeReason}`,
        skipped: false,
      });
      this.audit({
        entity: "PREPAY",
        entityId: prepay.id,
        fromStatus: "reclaim_requested",
        toStatus: "disputed",
        actorId: actor.id,
        comment: "超期追索挂纠纷，采购单不关闭",
        skipped: false,
      });
    } else {
      this.fail("INVALID_INPUT", "追索执行结果仅为 reclaimed 或 disputed");
    }
    reclaim.executorId = actor.id;
    reclaim.updatedAt = now;
    prepay.overdueFlag = false;
    prepay.updatedAt = now;
    return clone(reclaim);
  }

  createPreApproval(
    actorId: string,
    input: { companyCode: string; currency: string; deptId: string; purpose: string; amount: string },
  ): PreApproval {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "applicant");
    const companyCode = this.company(input.companyCode);
    const currency = this.currency(input.currency);
    const deptId = this.requiredText(input.deptId, "部门");
    const purpose = this.requiredText(input.purpose, "事由");
    const amount = formatStored(input.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_AMOUNT", "事前金额必须大于 0");
    const now = this.now();
    const id = this.store.nextId("PRE");
    const pre: PreApproval = {
      id,
      docNo: id,
      companyCode,
      currency,
      amount,
      status: "draft",
      applicantId: actor.id,
      deptId,
      purpose,
      deptApproverId: null,
      consumedByExpenseId: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.pres.set(pre.id, pre);
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: null,
      toStatus: "draft",
      actorId: actor.id,
      comment: "②-1 创建事前申请草稿",
      skipped: false,
    });
    return clone(pre);
  }

  submitPreApproval(actorId: string, preId: string): PreApproval {
    const actor = this.requireUser(actorId);
    const pre = this.preApproval(preId);
    if (actor.id !== pre.applicantId) this.fail("FORBIDDEN_ROLE", "只有事前申请人可以提交", 403);
    this.assertStatus(pre.status, "draft", "事前申请");
    pre.status = "submitted";
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: "draft",
      toStatus: "submitted",
      actorId: actor.id,
      comment: "②-1 提交事前申请",
      skipped: false,
    });
    return clone(pre);
  }

  approvePreApproval(actorId: string, preId: string, comment?: string): PreApproval {
    const actor = this.requireUser(actorId);
    const pre = this.preApproval(preId);
    this.assertStatus(pre.status, "submitted", "事前申请");
    this.requireRole(actor, "dept");
    if (actor.id === pre.applicantId) {
      this.sod(actor, "PRE", pre.id, pre.status, "S3", "S3 事前申请人不得担任部门审批人");
    }
    pre.deptApproverId = actor.id;
    pre.status = "approved";
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: "submitted",
      toStatus: "approved",
      actorId: actor.id,
      comment: this.note("②-2 事前审批通过", comment),
      skipped: false,
    });
    return clone(pre);
  }

  rejectPreApproval(actorId: string, preId: string, comment?: string): PreApproval {
    const actor = this.requireUser(actorId);
    const pre = this.preApproval(preId);
    this.assertStatus(pre.status, "submitted", "事前申请");
    this.requireRole(actor, "dept");
    if (actor.id === pre.applicantId) {
      this.sod(actor, "PRE", pre.id, pre.status, "S3", "S3 事前申请人不得担任部门审批人");
    }
    pre.deptApproverId = actor.id;
    pre.status = "rejected";
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: "submitted",
      toStatus: "rejected",
      actorId: actor.id,
      comment: this.note("②-2 事前驳回", comment),
      skipped: false,
    });
    return clone(pre);
  }

  cancelPreApproval(actorId: string, preId: string): PreApproval {
    const actor = this.requireUser(actorId);
    const pre = this.preApproval(preId);
    if (actor.id !== pre.applicantId) this.fail("FORBIDDEN_ROLE", "只有事前申请人可以取消", 403);
    if (pre.status !== "draft" && pre.status !== "submitted" && pre.status !== "approved") {
      this.fail("INVALID_STATE", "当前事前申请不能取消", 409);
    }
    if (pre.consumedByExpenseId) this.fail("PRE_ALREADY_CONSUMED", "事前申请已被报销占用", 409);
    const from = pre.status;
    pre.status = "cancelled";
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: from,
      toStatus: "cancelled",
      actorId: actor.id,
      comment: "申请人取消事前申请",
      skipped: false,
    });
    return clone(pre);
  }

  createExpense(
    actorId: string,
    input: {
      preApprovalId?: string;
      purpose: string;
      amount: string;
      invoiceNos: unknown;
      employeeAccount: string;
    },
  ): ExpenseClaim {
    const actor = this.requireUser(actorId);
    this.requireRole(actor, "applicant");
    const preApprovalId = (input.preApprovalId ?? "").trim();
    if (!preApprovalId) {
      this.fail("PRE_REQUIRED", "无事前申请不可提报销。require_pre_approval 固定为 true", 422);
    }
    const pre = this.store.pres.get(preApprovalId);
    if (!pre) this.fail("PRE_REQUIRED", "事前申请不存在，不可提报销", 422);
    if (pre.applicantId !== actor.id) this.fail("FORBIDDEN_ROLE", "只能报销自己的事前申请", 403);
    this.assertPreOpenForExpense(pre);
    const purpose = this.requiredText(input.purpose, "事由");
    const amount = formatStored(input.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_AMOUNT", "报销金额必须大于 0");
    const invoiceNos = this.invoiceNos(input.invoiceNos);
    this.assertExpenseInvoicesFree(invoiceNos);
    const employeeAccount = this.accountNo(input.employeeAccount);
    const now = this.now();
    const id = this.store.nextId("EXP");
    const expense: ExpenseClaim = {
      id,
      docNo: id,
      companyCode: pre.companyCode,
      currency: pre.currency,
      amount,
      status: "draft",
      applicantId: actor.id,
      deptId: pre.deptId,
      purpose,
      preApprovalId: pre.id,
      invoiceNos,
      employeeAccount,
      deptApproverId: null,
      ticketCheckerId: null,
      financeCosignerId: null,
      payerId: null,
      financeGate: "pending",
      paidAt: null,
      bankRef: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.expenses.set(expense.id, expense);
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: null,
      toStatus: "draft",
      actorId: actor.id,
      comment: `②-4 创建报销草稿，关联 ${pre.docNo}`,
      skipped: false,
    });
    return clone(expense);
  }

  submitExpense(actorId: string, expenseId: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    if (actor.id !== expense.applicantId) this.fail("FORBIDDEN_ROLE", "只有报销申请人可以提交", 403);
    this.assertStatus(expense.status, "draft", "报销");
    if (!expense.preApprovalId) {
      this.fail("PRE_REQUIRED", "无事前申请不可提报销。require_pre_approval 固定为 true", 422);
    }
    const pre = this.store.pres.get(expense.preApprovalId);
    if (!pre) this.fail("PRE_REQUIRED", "事前申请不存在，不可提交报销", 422);
    if (pre.applicantId !== expense.applicantId) {
      this.fail("PRE_NOT_APPROVED", "事前申请与报销申请人不一致", 409);
    }
    this.assertPreOpenForExpense(pre);
    this.consumePre(pre, expense.id, actor);
    expense.status = "submitted";
    expense.updatedAt = this.now();
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "draft",
      toStatus: "submitted",
      actorId: actor.id,
      comment: "②-4 提交报销，已占用事前申请",
      skipped: false,
    });
    return clone(expense);
  }

  approveExpenseDept(actorId: string, expenseId: string, comment?: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    this.assertStatus(expense.status, "submitted", "报销");
    this.requireRole(actor, "dept");
    if (actor.id === expense.applicantId) {
      this.sod(actor, "EXP", expense.id, expense.status, "S3", "S3 报销申请人不得担任部门审批人");
    }
    expense.deptApproverId = actor.id;
    expense.status = "dept_approved";
    expense.updatedAt = this.now();
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "submitted",
      toStatus: "dept_approved",
      actorId: actor.id,
      comment: this.note("②-5 部门审批通过", comment),
      skipped: false,
    });
    return clone(expense);
  }

  rejectExpenseDept(actorId: string, expenseId: string, comment?: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    this.assertStatus(expense.status, "submitted", "报销");
    this.requireRole(actor, "dept");
    if (actor.id === expense.applicantId) {
      this.sod(actor, "EXP", expense.id, expense.status, "S3", "S3 报销申请人不得担任部门审批人");
    }
    expense.deptApproverId = actor.id;
    expense.status = "rejected";
    expense.updatedAt = this.now();
    const pre = this.store.pres.get(expense.preApprovalId);
    if (pre) this.releasePre(pre, actor, "报销被部门驳回，事前申请恢复为已批准");
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "submitted",
      toStatus: "rejected",
      actorId: actor.id,
      comment: this.note("②-5 部门驳回", comment),
      skipped: false,
    });
    return clone(expense);
  }

  cancelExpense(actorId: string, expenseId: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    if (actor.id !== expense.applicantId) this.fail("FORBIDDEN_ROLE", "只有报销申请人可以取消", 403);
    if (expense.status !== "draft" && expense.status !== "submitted") {
      this.fail("INVALID_STATE", "当前报销不能取消", 409);
    }
    const from = expense.status;
    expense.status = "cancelled";
    expense.updatedAt = this.now();
    if (from === "submitted") {
      const pre = this.store.pres.get(expense.preApprovalId);
      if (pre) this.releasePre(pre, actor, "报销取消，事前申请恢复为已批准");
    }
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: from,
      toStatus: "cancelled",
      actorId: actor.id,
      comment: "申请人取消报销",
      skipped: false,
    });
    return clone(expense);
  }

  checkExpenseTicket(actorId: string, expenseId: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    this.assertStatus(expense.status, "dept_approved", "报销");
    this.requireRole(actor, "finance");
    const over = this.reimburseOver(expense.amount, expense.currency);
    expense.ticketCheckerId = actor.id;
    expense.status = "ticket_checked";
    expense.updatedAt = this.now();
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "dept_approved",
      toStatus: "ticket_checked",
      actorId: actor.id,
      comment: "②-6 财务审票通过。审票人记为记账人",
      skipped: false,
    });
    if (!over) {
      expense.financeGate = "skipped";
      expense.status = "payment_approved";
      this.audit({
        entity: "EXP",
        entityId: expense.id,
        fromStatus: "ticket_checked",
        toStatus: "payment_approved",
        actorId: actor.id,
        comment: "②-7 未超报销限额，跳过加签",
        skipped: true,
        skippedReason: "below_threshold",
      });
    } else {
      expense.financeGate = "required";
    }
    return clone(expense);
  }

  cosignExpense(actorId: string, expenseId: string, comment?: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    this.assertStatus(expense.status, "ticket_checked", "报销");
    if (expense.financeGate !== "required") this.fail("INVALID_STATE", "当前报销不需要财务加签", 409);
    this.requireRole(actor, "finance");
    expense.financeCosignerId = actor.id;
    expense.financeGate = "approved";
    expense.status = "finance_cosigned";
    expense.updatedAt = this.now();
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "ticket_checked",
      toStatus: "finance_cosigned",
      actorId: actor.id,
      comment: this.note("②-7 报销超额，财务加签", comment),
      skipped: false,
    });
    expense.status = "payment_approved";
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "finance_cosigned",
      toStatus: "payment_approved",
      actorId: actor.id,
      comment: "加签完成，待出纳付款",
      skipped: false,
    });
    return clone(expense);
  }

  payExpense(actorId: string, expenseId: string, bankRef: string): ExpenseClaim {
    const actor = this.requireUser(actorId);
    const expense = this.expense(expenseId);
    this.requireRole(actor, "cashier");
    this.assertStatus(expense.status, "payment_approved", "报销");
    if (!expense.ticketCheckerId) this.fail("INVALID_STATE", "缺少审票人", 409);
    if (actor.id === expense.ticketCheckerId) {
      this.sod(actor, "EXP", expense.id, expense.status, "S2", "S2 报销审票人不得担任付款人（记账人 ≠ 付款人）");
    }
    const ref = this.requiredText(bankRef, "银行回单号");
    if (ref.length > 64) this.fail("INVALID_BANK_REF", "银行回单号过长");
    expense.payerId = actor.id;
    expense.bankRef = ref;
    expense.paidAt = this.now();
    expense.status = "paid";
    expense.updatedAt = expense.paidAt;
    this.audit({
      entity: "EXP",
      entityId: expense.id,
      fromStatus: "payment_approved",
      toStatus: "paid",
      actorId: actor.id,
      comment: `②-8 出纳打款至员工账户 ${expense.employeeAccount}`,
      skipped: false,
    });
    return clone(expense);
  }

  getPrepay(id: string): {
    prepay: PrepayRequest;
    settle: PrepaySettle | null;
    refund: PrepayRefund | null;
    chases: OverdueChase[];
    reclaim: PrepayReclaim | null;
  } {
    const prepay = this.prepay(id);
    return {
      prepay: clone(prepay),
      settle: clone(this.store.settleByPrepay(prepay.id) ?? null),
      refund: clone(this.store.refundByPrepay(prepay.id) ?? null),
      chases: this.store.chasesByPrepay(prepay.id).map((row) => clone(row)),
      reclaim: clone(this.store.reclaimByPrepay(prepay.id) ?? null),
    };
  }

  getPreApproval(id: string): PreApproval {
    return clone(this.preApproval(id));
  }

  getExpense(id: string): ExpenseClaim {
    return clone(this.expense(id));
  }

  getPr(id: string): PurchaseRequisition {
    return clone(this.pr(id));
  }

  getPo(id: string): PurchaseOrder {
    return clone(this.po(id));
  }

  getPayment(id: string): Payment {
    return clone(this.payment(id));
  }

  listAudit(filter: { entity?: string; entityId?: string }): AuditLog[] {
    return this.store.audits
      .filter((row) => (filter.entity ? row.entity === filter.entity : true))
      .filter((row) => (filter.entityId ? row.entityId === filter.entityId : true))
      .map((row) => clone(row));
  }

  workspace(): {
    users: PublicUser[];
    prs: PurchaseRequisition[];
    pos: PurchaseOrder[];
    grns: Grn[];
    invoices: InvoiceRegister[];
    matches: MatchSheet[];
    payments: Payment[];
    prepays: PrepayRequest[];
    settles: PrepaySettle[];
    refunds: PrepayRefund[];
    chases: OverdueChase[];
    reclaims: PrepayReclaim[];
    pres: PreApproval[];
    expenses: ExpenseClaim[];
    assets: AssetCard[];
    audits: AuditLog[];
  } {
    return {
      users: this.listUsers(),
      prs: [...this.store.prs.values()].map((row) => clone(row)),
      pos: [...this.store.pos.values()].map((row) => clone(row)),
      grns: [...this.store.grns.values()].map((row) => clone(row)),
      invoices: [...this.store.invoices.values()].map((row) => clone(row)),
      matches: [...this.store.matches.values()].map((row) => clone(row)),
      payments: [...this.store.payments.values()].map((row) => clone(row)),
      prepays: [...this.store.prepays.values()].map((row) => clone(row)),
      settles: [...this.store.settles.values()].map((row) => clone(row)),
      refunds: [...this.store.refunds.values()].map((row) => clone(row)),
      chases: [...this.store.chases.values()].map((row) => clone(row)),
      reclaims: [...this.store.reclaims.values()].map((row) => clone(row)),
      pres: [...this.store.pres.values()].map((row) => clone(row)),
      expenses: [...this.store.expenses.values()].map((row) => clone(row)),
      assets: [...this.store.assets.values()].map((row) => clone(row)),
      audits: this.store.audits.map((row) => clone(row)),
    };
  }

  private livePrepay(poId: string): PrepayRequest | undefined {
    return this.store.livePrepayByPo(poId);
  }

  private prepay(id: string): PrepayRequest {
    const row = this.store.prepays.get(id);
    if (!row) this.fail("NOT_FOUND", "预付申请不存在", 404);
    return row;
  }

  private refundOf(prepayId: string): PrepayRefund {
    const refund = this.store.refundByPrepay(prepayId);
    if (!refund) this.fail("NOT_FOUND", "溢付处理不存在", 404);
    return refund;
  }

  private reclaimOf(prepayId: string): PrepayReclaim {
    const reclaim = this.store.reclaimByPrepay(prepayId);
    if (!reclaim) this.fail("NOT_FOUND", "追索不存在", 404);
    return reclaim;
  }

  private preApproval(id: string): PreApproval {
    const row = this.store.pres.get(id);
    if (!row) this.fail("NOT_FOUND", "事前申请不存在", 404);
    return row;
  }

  private expense(id: string): ExpenseClaim {
    const row = this.store.expenses.get(id);
    if (!row) this.fail("NOT_FOUND", "报销单不存在", 404);
    return row;
  }

  private collectOverdue(now: Date): { overdueDays: number; items: OverdueListItem[] } {
    const overdueDays = this.prepayPolicy.overdueDays;
    if (overdueDays == null) {
      this.fail("THRESHOLD_NOT_CONFIGURED", "PREPAY_OVERDUE_DAYS 仍为占位符，未注入数值", 422);
    }
    const items: OverdueListItem[] = [];
    for (const prepay of this.store.prepays.values()) {
      if (!prepay.paidAt) continue;
      if (!this.onOverdueWatch(prepay)) continue;
      if (this.prepayAccepted(prepay)) continue;
      const age = ageDays(prepay.paidAt, now);
      const openException =
        prepay.status === "overdue_flagged" || prepay.status === "chasing" || prepay.status === "reclaim_requested";
      if (!openException && age < overdueDays) continue;
      items.push({
        prepayId: prepay.id,
        docNo: prepay.docNo,
        poId: prepay.poId,
        companyCode: prepay.companyCode,
        currency: prepay.currency,
        amount: prepay.amount,
        paidAt: prepay.paidAt,
        ageDays: age,
        overdueDays,
        status: prepay.status,
        flagged: prepay.overdueFlag,
      });
    }
    items.sort((left, right) => left.docNo.localeCompare(right.docNo));
    return { overdueDays, items };
  }

  private onOverdueWatch(prepay: PrepayRequest): boolean {
    return (
      prepay.status === "paid" ||
      prepay.status === "accrued" ||
      prepay.status === "awaiting_delivery" ||
      prepay.status === "overdue_flagged" ||
      prepay.status === "chasing" ||
      prepay.status === "reclaim_requested"
    );
  }

  private prepayAccepted(prepay: PrepayRequest): boolean {
    const po = this.store.pos.get(prepay.poId);
    if (!po) return false;
    return this.confirmedGrns(po).length > 0;
  }

  private releaseOverdueOnArrival(po: PurchaseOrder, actor: User): void {
    const prepay = this.livePrepay(po.id);
    if (!prepay) return;
    if (prepay.status !== "overdue_flagged" && prepay.status !== "chasing") return;
    const from = prepay.status;
    prepay.status = "awaiting_delivery";
    prepay.overdueFlag = false;
    prepay.updatedAt = this.now();
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus: from,
      toStatus: "awaiting_delivery",
      actorId: actor.id,
      comment: "到货，退出①-E 跟催，回到待核销",
      skipped: false,
    });
  }

  private chaseOutcome(raw: string): ChaseOutcome {
    if (raw === "promised" || raw === "no_result") return raw;
    this.fail("INVALID_INPUT", "跟催结果仅为 promised 或 no_result");
  }

  private isoDate(raw: string, label: string): string {
    const text = this.requiredText(raw, label);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) this.fail("INVALID_DATE", `${label}须为 YYYY-MM-DD`);
    const parsed = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) {
      this.fail("INVALID_DATE", `${label}不是有效日期`);
    }
    return text;
  }

  private assertPreOpenForExpense(pre: PreApproval): void {
    if (pre.consumedByExpenseId || pre.status === "consumed_by_expense") {
      this.fail("PRE_ALREADY_CONSUMED", "事前申请已被报销占用", 409);
    }
    if (pre.status !== "approved") {
      this.fail("PRE_NOT_APPROVED", "报销必须关联已批准的事前申请", 409);
    }
  }

  private consumePre(pre: PreApproval, expenseId: string, actor: User): void {
    const from = pre.status;
    pre.status = "consumed_by_expense";
    pre.consumedByExpenseId = expenseId;
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: from,
      toStatus: "consumed_by_expense",
      actorId: actor.id,
      comment: `事前申请被报销 ${expenseId} 占用`,
      skipped: false,
    });
  }

  private releasePre(pre: PreApproval, actor: User, comment: string): void {
    if (pre.status !== "consumed_by_expense") return;
    pre.status = "approved";
    pre.consumedByExpenseId = null;
    pre.updatedAt = this.now();
    this.audit({
      entity: "PRE",
      entityId: pre.id,
      fromStatus: "consumed_by_expense",
      toStatus: "approved",
      actorId: actor.id,
      comment,
      skipped: false,
    });
  }

  private reimburseOver(amount: string, currency: CurrencyCode): boolean {
    const key = reimburseThresholdKey(currency);
    const value = this.thresholds[key];
    if (value == null) this.fail("THRESHOLD_NOT_CONFIGURED", `${key} 仍为占位符，未注入数值`, 422);
    return compareAmount(amount, value) >= 0;
  }

  private invoiceNos(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
      this.fail("INVALID_INPUT", "报销至少 1 张、至多 20 张发票");
    }
    const nos = raw.map((item) => this.requiredText(typeof item === "string" ? item : "", "发票号码"));
    if (new Set(nos).size !== nos.length) this.fail("DUPLICATE_INVOICE", "报销单内发票号码重复", 409);
    return nos;
  }

  /** 路径①与路径②的发票查重仍待财务确认，这里只拒绝未关闭报销之间的重号。 */
  private assertExpenseInvoicesFree(invoiceNos: string[]): void {
    for (const expense of this.store.expenses.values()) {
      if (expense.status === "rejected" || expense.status === "cancelled") continue;
      if (expense.invoiceNos.some((no) => invoiceNos.includes(no))) {
        this.fail("DUPLICATE_INVOICE", "发票号码已在其他报销单使用", 409);
      }
    }
  }

  private accountNo(raw: string): string {
    const text = this.requiredText(raw, "员工收款账户");
    if (text.length > 64) this.fail("INVALID_INPUT", "员工收款账户过长");
    return text;
  }

  private addProforma(
    actor: User,
    po: PurchaseOrder,
    input: { invoiceNo: string; amount: string; tax?: string },
    now: string,
  ): string {
    const invoiceNo = this.requiredText(input.invoiceNo, "形式发票号码");
    this.assertInvoiceNoFree(invoiceNo);
    const amount = formatStored(input.amount);
    if (compareAmount(amount, "0.00") <= 0) this.fail("INVALID_AMOUNT", "形式发票金额必须大于 0");
    const tax = formatStored(input.tax ?? "0.00");
    const id = this.store.nextId("INV");
    const invoice: InvoiceRegister = {
      id,
      docNo: id,
      invoiceNo,
      invoiceType: "proforma",
      kind: "proforma",
      formalOf: null,
      amount,
      tax,
      poId: po.id,
      createdBy: actor.id,
      createdAt: now,
    };
    this.store.invoices.set(invoice.id, invoice);
    this.audit({
      entity: "INV",
      entityId: invoice.id,
      fromStatus: null,
      toStatus: "proforma",
      actorId: actor.id,
      comment: "形式发票，仅用于启动预付，不能用于三单匹配或核销",
      skipped: false,
    });
    return id;
  }

  private assertInvoiceNoFree(invoiceNo: string): void {
    for (const existing of this.store.invoices.values()) {
      if (existing.invoiceNo === invoiceNo) this.fail("DUPLICATE_INVOICE", "发票号码已存在", 409);
    }
  }

  private prepayBand(prepay: PrepayRequest): ApprovalBand {
    if (prepay.fullPrepay) return "high";
    const po = this.po(prepay.poId);
    if (this.prepayPolicy.inheritPrMatrix) {
      return approvalBand(
        prepay.amount,
        this.readThreshold(po.currency, "fin"),
        this.readThreshold(po.currency, "ceo"),
        thresholdKey(po.currency, "fin"),
        thresholdKey(po.currency, "ceo"),
      );
    }
    return approvalBand(
      prepay.amount,
      this.readPrepayMoney(po.currency, "fin"),
      this.readPrepayMoney(po.currency, "ceo"),
      prepayThresholdKey(po.currency, "fin"),
      prepayThresholdKey(po.currency, "ceo"),
    );
  }

  private routePrepayBand(prepay: PrepayRequest, actor: User, band: ApprovalBand): void {
    if (band === "low") {
      prepay.financeGate = "skipped";
      prepay.ceoGate = "skipped";
      this.skipPrepay(prepay, actor, "dept_approved", "finance_cosigned", "①-P3 未达预付财务阈，跳过");
      this.skipPrepay(prepay, actor, "finance_cosigned", "ceo_approved", "①-P4 未达预付总经理阈，跳过");
      return;
    }
    if (band === "mid") {
      prepay.financeGate = "required";
      prepay.ceoGate = "skipped";
      return;
    }
    prepay.financeGate = "required";
    prepay.ceoGate = "required";
  }

  private skipPrepay(prepay: PrepayRequest, actor: User, fromStatus: string, toStatus: string, comment: string): void {
    this.audit({
      entity: "PREPAY",
      entityId: prepay.id,
      fromStatus,
      toStatus,
      actorId: actor.id,
      comment,
      skipped: true,
      skippedReason: "below_threshold",
    });
  }

  private assertReadyForPrepayPayment(prepay: PrepayRequest): void {
    const financeDone = prepay.financeGate === "skipped" || prepay.financeGate === "approved";
    const ceoDone = prepay.ceoGate === "skipped" || prepay.ceoGate === "approved";
    if (!financeDone || !ceoDone) this.fail("INVALID_STATE", "预付加签尚未完成", 409);
    if (prepay.status !== "dept_approved" && prepay.status !== "finance_cosigned" && prepay.status !== "ceo_approved") {
      this.fail("INVALID_STATE", `预付状态是 ${prepay.status}，不能批准付款`, 409);
    }
  }

  private dp2(prepayAmount: string, invoiceAmount: string): Dp2Result {
    const cmp = compareAmount(prepayAmount, invoiceAmount);
    if (cmp === 0) return "equal";
    if (cmp < 0) return "short";
    return "over";
  }

  private closePo(po: PurchaseOrder, actor: User, comment: string): void {
    const from = po.status;
    po.status = "closed";
    po.updatedAt = this.now();
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "closed",
      actorId: actor.id,
      comment,
      skipped: false,
    });
  }

  private readPrepayMoney(currency: CurrencyCode, kind: PrepayThresholdKind): string {
    const key = prepayThresholdKey(currency, kind);
    const value = this.thresholds[key];
    if (value == null) this.fail("THRESHOLD_NOT_CONFIGURED", `${key} 仍为占位符，未注入数值`, 422);
    return value;
  }

  private reasonCode(raw: string | undefined, label: string): string {
    const reason = this.requiredText(raw ?? "", label);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(reason)) {
      this.fail("INVALID_REASON", `${label}仅允许字母、数字、下划线和连字符`);
    }
    return reason;
  }

  private optionalText(raw: string | null | undefined, label: string): string | null {
    const text = (raw ?? "").trim();
    if (!text) return null;
    if (text.length > 200) this.fail("INVALID_INPUT", `${label}过长`);
    return text;
  }

  private enterSourcing(pr: PurchaseRequisition, actor: User, fromStatus: PurchaseRequisition["status"]): void {
    const rfq = this.readThreshold(pr.currency, "rfq");
    const below = compareAmount(pr.amount, rfq) < 0;
    const lowValueOnly = pr.lines.every((line) => line.category === "low_value");
    if (below) {
      pr.rfqRequired = false;
      pr.rfqWaiverKind = "below_threshold";
    } else if (lowValueOnly) {
      pr.rfqRequired = false;
      pr.rfqWaiverKind = "low_value";
    } else {
      pr.rfqRequired = true;
      pr.rfqWaiverKind = null;
    }
    pr.status = "sourcing";
    pr.updatedAt = this.now();
    const hint = pr.rfqRequired ? "进入 ①-5，须三家比价" : "未强制比价，须填写免比价原因码后进入下单";
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus,
      toStatus: "sourcing",
      actorId: actor.id,
      comment: hint,
      skipped: false,
    });
  }

  private skipGate(
    pr: PurchaseRequisition,
    actor: User,
    fromStatus: string,
    toStatus: string,
    comment: string,
  ): void {
    this.audit({
      entity: "PR",
      entityId: pr.id,
      fromStatus,
      toStatus,
      actorId: actor.id,
      comment,
      skipped: true,
      skippedReason: "below_threshold",
    });
  }

  private applyReceipt(po: PurchaseOrder, actor: User): void {
    const ordered = po.lines.reduce((sum, line) => sum + line.qty, 0);
    const received = this.confirmedGrns(po).reduce((sum, row) => sum + row.qtyReceived, 0);
    if (received > ordered) this.fail("OVER_RECEIPT", "收货数量超过采购数量", 422);
    const from = po.status;
    if (received === ordered) {
      po.status = "fully_received";
      po.disposition = this.decideDisposition(po);
    } else {
      po.status = "partially_received";
    }
    po.updatedAt = this.now();
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: po.status,
      actorId: actor.id,
      comment: po.status === "fully_received" ? `收齐。D4=${po.disposition}` : "部分收货",
      skipped: false,
    });
    this.releaseOverdueOnArrival(po, actor);
  }

  private decideDisposition(po: PurchaseOrder): "asset" | "expense" {
    if (po.lines.some((line) => line.category === "fixed_asset")) return "asset";
    const capex = this.readThreshold(po.currency, "capex");
    if (compareAmount(po.amount, capex) >= 0) return "asset";
    return "expense";
  }

  private confirmNewGrn(
    actor: User,
    po: PurchaseOrder,
    qty: number,
    result: "accepted" | "concession" | "rejected",
    proxyReceiverId: string | null,
  ): Grn {
    const now = this.now();
    const id = this.store.nextId("GRN");
    const grn: Grn = {
      id,
      docNo: id,
      poId: po.id,
      accepterId: actor.id,
      proxyReceiverId,
      receivedAt: now,
      result,
      status: result === "rejected" ? "rejected" : "confirmed",
      qtyReceived: qty,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    };
    this.store.grns.set(grn.id, grn);
    this.audit({
      entity: "GRN",
      entityId: grn.id,
      fromStatus: null,
      toStatus: grn.status,
      actorId: actor.id,
      comment: `①-7 验收结果 ${result}`,
      skipped: false,
    });
    if (grn.status === "confirmed") this.applyReceipt(po, actor);
    return clone(grn);
  }

  private qtyOrRemaining(po: PurchaseOrder, requested: number | undefined): number {
    const ordered = po.lines.reduce((sum, line) => sum + line.qty, 0);
    const received = this.confirmedGrns(po).reduce((sum, row) => sum + row.qtyReceived, 0);
    const openDraft = this.store.grnsByPo(po.id).some((row) => row.status === "draft");
    if (openDraft) this.fail("INVALID_STATE", "已有待确认的代收单", 409);
    const remaining = ordered - received;
    if (remaining <= 0) this.fail("INVALID_STATE", "采购单已收齐", 409);
    const qty = requested ?? remaining;
    if (!Number.isInteger(qty) || qty <= 0 || qty > remaining) {
      this.fail("INVALID_QTY", "收货数量必须是不超过未收数量的正整数");
    }
    return qty;
  }

  private confirmedGrns(po: PurchaseOrder): Grn[] {
    return this.store.grnsByPo(po.id).filter((row) => row.status === "confirmed");
  }

  private assertReceivable(po: PurchaseOrder): void {
    if (po.status !== "awaiting_receipt" && po.status !== "partially_received") {
      this.fail("INVALID_STATE", "采购单当前不能收货", 409);
    }
    const prepay = this.livePrepay(po.id);
    if (
      prepay &&
      (prepay.status === "reclaim_requested" || prepay.status === "reclaimed" || prepay.status === "disputed")
    ) {
      this.fail("PREPAY_RECLAIM_OPEN", "预付已进入追索或纠纷，不能再按到货验收", 409);
    }
  }

  private receiptResult(raw: string): "accepted" | "concession" | "rejected" {
    if (raw === "accepted" || raw === "concession" || raw === "rejected") return raw;
    this.fail("INVALID_RESULT", "验收结果仅为 accepted、concession 或 rejected");
  }

  private paymentTerms(raw: string): PaymentTerms {
    if (raw === "after_delivery" || raw === "monthly" || raw === "prepay") return raw;
    this.fail("INVALID_TERMS", "付款条件无效");
  }

  private readThreshold(currency: CurrencyCode, kind: ThresholdKind): string {
    const key = thresholdKey(currency, kind);
    const value = this.thresholds[key];
    if (value == null) {
      this.fail("THRESHOLD_NOT_CONFIGURED", `${key} 仍为占位符，未注入数值`, 422);
    }
    return value;
  }

  private sod(
    actor: User,
    entity: AuditLog["entity"],
    entityId: string,
    status: string,
    code: "S1" | "S2" | "S3" | "S5",
    message: string,
  ): never {
    this.audit({
      entity,
      entityId,
      fromStatus: status,
      toStatus: status,
      actorId: actor.id,
      comment: message,
      skipped: false,
      sodViolationCode: code,
    });
    throw new DomainError("SOD_VIOLATION", message, 409, code);
  }

  private audit(entry: Omit<AuditLog, "id" | "at">): void {
    this.store.audits.push({
      ...entry,
      id: this.store.nextId("AUD"),
      at: this.now(),
    });
  }

  private assertApplicant(actor: User, pr: PurchaseRequisition): void {
    if (actor.id !== pr.applicantId) this.fail("FORBIDDEN_ROLE", "只有申请人本人可以提交该请购", 403);
  }

  private assertStatus(actual: string, expected: string, label: string): void {
    if (actual !== expected) this.fail("INVALID_STATE", `${label}状态是 ${actual}，不能从该状态执行此操作`, 409);
  }

  private requireRole(user: User, role: Role): void {
    if (!this.store.rolesOf(user.id).includes(role)) {
      this.fail("FORBIDDEN_ROLE", `当前用户缺少角色 ${role}`, 403);
    }
  }

  private requireUser(id: string): User {
    const user = this.store.users.get(id);
    if (!user) this.fail("UNAUTHENTICATED", "会话用户不存在", 401);
    return user;
  }

  private pr(id: string): PurchaseRequisition {
    const row = this.store.prs.get(id);
    if (!row) this.fail("NOT_FOUND", "请购单不存在", 404);
    return row;
  }

  private po(id: string): PurchaseOrder {
    const row = this.store.pos.get(id);
    if (!row) this.fail("NOT_FOUND", "采购单不存在", 404);
    return row;
  }

  private grn(id: string): Grn {
    const row = this.store.grns.get(id);
    if (!row) this.fail("NOT_FOUND", "收货单不存在", 404);
    return row;
  }

  private payment(id: string): Payment {
    const row = this.store.payments.get(id);
    if (!row) this.fail("NOT_FOUND", "付款单不存在", 404);
    return row;
  }

  private company(raw: string): CompanyCode {
    if (raw === "SZ" || raw === "HK") return raw;
    this.fail("INVALID_COMPANY", "公司代码仅为 SZ 或 HK");
  }

  private currency(raw: string): CurrencyCode {
    if (raw === "CNY" || raw === "HKD") return raw;
    this.fail("INVALID_CURRENCY", "币种仅为 CNY 或 HKD");
  }

  private requiredText(raw: string, label: string): string {
    const text = (raw ?? "").trim();
    if (!text) this.fail("INVALID_INPUT", `${label}不能为空`);
    if (text.length > 200) this.fail("INVALID_INPUT", `${label}过长`);
    return text;
  }

  private note(base: string, comment?: string): string {
    const extra = (comment ?? "").trim();
    if (!extra) return base;
    if (extra.length > 200) this.fail("INVALID_INPUT", "备注过长");
    return `${base}；${extra}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private fail(code: string, message: string, status = 400): never {
    throw new DomainError(code, message, status);
  }
}

const DAY_MS = 86_400_000;

function ageDays(paidAtIso: string, now: Date): number {
  const paid = Date.parse(paidAtIso);
  if (Number.isNaN(paid)) return 0;
  const delta = now.getTime() - paid;
  if (delta < 0) return 0;
  return Math.floor(delta / DAY_MS);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function formatStored(raw: string): string {
  const minor = parseAmount(raw);
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
