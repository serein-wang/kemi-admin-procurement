import { parseCategory } from "../domain/categories.js";
import { DomainError } from "../domain/errors.js";
import { addAmount, compareAmount, lineAmount, parseAmount } from "../domain/money.js";
import { isRole, type Role } from "../domain/roles.js";
import {
  approvalBand,
  thresholdKey,
  type CurrencyCode,
  type ThresholdConfig,
  type ThresholdKind,
} from "../domain/thresholds.js";
import type {
  AssetCard,
  AuditLog,
  CompanyCode,
  CreatePrInput,
  Grn,
  InvoiceRegister,
  MatchSheet,
  Payment,
  PaymentTermsInput,
  Phase1PaymentTerms,
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
  erp: ErpProInboundPort;
  clock?: () => Date;
}

/**
 * 路径①货到付款 / 月结。状态以 docs/02、docs/06 为准。
 * SoD 在迁移前拒绝，不提供绕过。
 * 阶段 1 不做预付、报销、金蝶回写。
 */
export class ProcurementService {
  private readonly store: MemoryStore;
  private readonly thresholds: ThresholdConfig;
  private readonly erp: ErpProInboundPort;
  private readonly clock: () => Date;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.thresholds = deps.thresholds;
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
      this.fail("INVALID_TERMS", "货到付款不填写账期天数");
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
    po.status = "awaiting_receipt";
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: "issued",
      toStatus: "awaiting_receipt",
      actorId: actor.id,
      comment: `D6=${terms}，阶段 1 不进入预付`,
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
    if (this.store.invoiceByPo(po.id)) this.fail("INVALID_STATE", "该采购单已登记发票", 409);
    const invoiceNo = this.requiredText(input.invoiceNo, "发票号码");
    for (const existing of this.store.invoices.values()) {
      if (existing.invoiceNo === invoiceNo) this.fail("DUPLICATE_INVOICE", "发票号码已存在", 409);
    }
    const invoiceType = input.invoiceType === "special" || input.invoiceType === "general"
      ? input.invoiceType
      : null;
    if (!invoiceType) this.fail("INVALID_INVOICE", "发票类型仅为 special 或 general");
    parseAmount(input.tax);
    const amount = formatStored(input.amount);
    if (compareAmount(amount, po.amount) !== 0) {
      this.fail("MATCH_AMOUNT_MISMATCH", "发票金额必须等于采购单金额。本期不设容差阈值", 422);
    }
    const now = this.now();
    const id = this.store.nextId("INV");
    const invoice: InvoiceRegister = {
      id,
      docNo: id,
      invoiceNo,
      invoiceType,
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
      comment: "①-9 登记进项发票",
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
    if (!invoice) this.fail("INVALID_STATE", "尚未登记发票", 409);
    const grns = this.confirmedGrns(po);
    if (grns.length !== 1) this.fail("INVALID_STATE", "阶段 1 匹配需要恰好一张已确认收货单", 409);
    if (compareAmount(invoice.amount, po.amount) !== 0) {
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
      comment: "①-10 三单匹配通过；匹配人记为记账人",
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
    if (po.status !== "matched") this.fail("INVALID_STATE", "须三单匹配后才能发起付款", 409);
    if (this.store.paymentByPo(po.id)) this.fail("INVALID_STATE", "付款申请已存在", 409);
    const match = this.store.matchByPo(po.id);
    if (!match) this.fail("INVALID_STATE", "缺少匹配单", 409);
    const now = this.now();
    const id = this.store.nextId("PAY");
    const payment: Payment = {
      id,
      docNo: id,
      sourceType: "po_balance",
      poId: po.id,
      matchId: match.id,
      companyCode: po.companyCode,
      currency: po.currency,
      amount: po.amount,
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
      comment: "①-11 发起付款申请",
      skipped: false,
    });
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "payment_pending",
      actorId: actor.id,
      comment: "采购单待付款",
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
      comment: "①-12 财务批准付款。总经理是否复用请购高额档仍待确认，本期不另加节点",
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
    this.audit({
      entity: "PAY",
      entityId: payment.id,
      fromStatus: "finance_approved",
      toStatus: "paid",
      actorId: actor.id,
      comment: "①-13 出纳付款",
      skipped: false,
    });
    this.audit({
      entity: "PO",
      entityId: po.id,
      fromStatus: from,
      toStatus: "paid",
      actorId: actor.id,
      comment: "采购单已付款",
      skipped: false,
    });
    return clone(payment);
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
      assets: [...this.store.assets.values()].map((row) => clone(row)),
      audits: this.store.audits.map((row) => clone(row)),
    };
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
  }

  private receiptResult(raw: string): "accepted" | "concession" | "rejected" {
    if (raw === "accepted" || raw === "concession" || raw === "rejected") return raw;
    this.fail("INVALID_RESULT", "验收结果仅为 accepted、concession 或 rejected");
  }

  private paymentTerms(raw: string): Phase1PaymentTerms {
    const value = raw as PaymentTermsInput;
    if (value === "prepay") {
      this.fail("PREPAY_NOT_IN_SCOPE", "阶段 1 不做先款后货。D6 仅 after_delivery 或 monthly", 422);
    }
    if (value === "after_delivery" || value === "monthly") return value;
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
    code: "S1" | "S2" | "S3",
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

function formatStored(raw: string): string {
  const minor = parseAmount(raw);
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
