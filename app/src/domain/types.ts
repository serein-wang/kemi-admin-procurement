import type { AdminCategory } from "./categories.js";
import type { Role } from "./roles.js";
import type { CurrencyCode } from "./thresholds.js";

export type CompanyCode = "SZ" | "HK";
export type { CurrencyCode, Role, AdminCategory };

/** D6。prepay 走 ①-P*，到货后复用 ①-7 / ①-9 / ①-10。 */
export type PaymentTerms = "after_delivery" | "monthly" | "prepay";

export type PrStatus =
  | "draft"
  | "submitted"
  | "dept_approved"
  | "finance_approved"
  | "ceo_approved"
  | "sourcing"
  | "ready_for_po"
  | "closed_converted"
  | "rejected"
  | "cancelled";

export type PoStatus =
  | "issued"
  | "awaiting_prepay"
  | "awaiting_receipt"
  | "partially_received"
  | "fully_received"
  | "matched"
  | "payment_pending"
  | "paid"
  | "closed"
  | "cancelled";

export type Gate = "pending" | "required" | "skipped" | "approved";
export type Dp2Result = "equal" | "short" | "over";
export type PrepayStatus =
  | "draft"
  | "submitted"
  | "dept_approved"
  | "finance_cosigned"
  | "ceo_approved"
  | "finance_payment_approved"
  | "paid"
  | "accrued"
  | "awaiting_delivery"
  | "settling"
  | "settled_equal"
  | "settled_with_balance"
  | "settled_with_refund"
  | "overdue_flagged"
  | "chasing"
  | "reclaim_requested"
  | "reclaimed"
  | "disputed"
  | "rejected"
  | "cancelled";
export type ChaseOutcome = "promised" | "no_result";
export type ReclaimStatus = "requested" | "reclaimed" | "disputed";
export type PreStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "consumed_by_expense"
  | "rejected"
  | "cancelled"
  | "expired";
export type ExpenseStatus =
  | "draft"
  | "submitted"
  | "dept_approved"
  | "ticket_checked"
  | "finance_cosigned"
  | "payment_approved"
  | "paid"
  | "rejected"
  | "cancelled";
export type RefundMode = "refund" | "suspense";
export type RefundStatus = "requested" | "finance_approved" | "executed";
export type ReserveStatus = "none" | "soft" | "hard" | "released";
export type RfqWaiverKind = "below_threshold" | "low_value";
/** Q7。低值易耗仍走路径①，不另开第三路径。 */
export type PrDocType = "standard" | "low_value";
export type AssetStatus = "active" | "transferred" | "retired";
export type BudgetHoldKind = "soft" | "hard";
export type BudgetHoldStatus = "open" | "released" | "converted";
export type BudgetReleaseReason =
  | "pr_rejected"
  | "pr_cancelled"
  | "converted_to_hard"
  | "po_cancelled"
  | "po_closed";

export interface User {
  id: string;
  /** 对应 OIDC userinfo.sub，唯一。 */
  ucUserId: string;
  displayName: string;
  email: string | null;
  username: string | null;
  status: "active" | "pending";
  createdAt: string;
  updatedAt: string;
}

/** 角色表。权限只存在本模块，不写回 KEMI。 */
export interface RoleAssignment {
  id: string;
  userId: string;
  role: Role;
  assignedBy: string | null;
  assignedAt: string;
}

export interface PublicUser {
  id: string;
  ucUserId: string;
  displayName: string;
  email: string | null;
  username: string | null;
  status: "active" | "pending";
  roles: Role[];
}

/** 请购行贴图。字节在仓储里，接口只带元数据，页面用附件路由取图。 */
export interface PrLineImage {
  id: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name: string;
  byteLength: number;
}

export interface PrLine {
  itemName: string;
  spec: string;
  /** 购买链接。可空。 */
  purchaseUrl: string;
  qty: number;
  estUnitPrice: string;
  estAmount: string;
  category: AdminCategory;
  images: PrLineImage[];
}

export interface PurchaseRequisition {
  id: string;
  docNo: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  status: PrStatus;
  applicantId: string;
  deptId: string;
  purpose: string;
  /** 申请人勾选。D4 仍以品类与 THR_*_CAPEX 为准，不单独放行。 */
  capexHint: boolean;
  budgetId: string | null;
  reserveStatus: ReserveStatus;
  deptApproverId: string | null;
  financeApproverId: string | null;
  ceoApproverId: string | null;
  financeGate: Gate;
  ceoGate: Gate;
  rfqRequired: boolean | null;
  rfqWaiverKind: RfqWaiverKind | null;
  rfqWaived: boolean;
  waiveReason: string | null;
  /** 行全部为 low_value 时为低值易耗单据（Q7）。 */
  docType: PrDocType;
  procurementClass: "admin_non_production";
  lines: PrLine[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface Vendor {
  id: string;
  name: string;
}

export interface VendorQuote {
  vendorName: string;
  amount: string;
  leadTimeDays: number;
  selected: boolean;
}

export interface QuoteCompare {
  id: string;
  prId: string;
  quotes: VendorQuote[];
  selectedVendorId: string;
  comparerId: string;
  createdAt: string;
}

export interface PurchaseOrder {
  id: string;
  docNo: string;
  prId: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  status: PoStatus;
  applicantId: string;
  /** S1：下单人。 */
  issuerId: string;
  vendorId: string;
  paymentTerms: PaymentTerms;
  paymentTermsDays: number | null;
  lines: PrLine[];
  /** D4。unset 表示尚未收齐。 */
  disposition: "unset" | "asset" | "expense";
  dispositionDone: boolean;
  /** ①-8b stub 回执。无真实 erp-pro 调用。 */
  erpInboundRefs: string[];
  reserveStatus: ReserveStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface Grn {
  id: string;
  docNo: string;
  poId: string;
  accepterId: string | null;
  proxyReceiverId: string | null;
  receivedAt: string | null;
  result: "accepted" | "concession" | "rejected" | null;
  status: "draft" | "confirmed" | "rejected";
  qtyReceived: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface InvoiceRegister {
  id: string;
  docNo: string;
  invoiceNo: string;
  /** special/general 为正式进项票。proforma 只能启动预付（Q13）。 */
  invoiceType: "special" | "general" | "proforma";
  kind: "formal" | "proforma";
  /** 正式票替换形式票时保留关联。无形式票则为 null。 */
  formalOf: string | null;
  amount: string;
  tax: string;
  poId: string;
  createdBy: string;
  createdAt: string;
}

export interface MatchSheet {
  id: string;
  docNo: string;
  poId: string;
  grnId: string;
  invoiceId: string;
  prepayId: string | null;
  /** 匹配时核对的已付预付额。非预付为 null。 */
  prepayAmount: string | null;
  matchResult: "matched";
  /** 记账人，供 S2：voucher.creator ≠ payment.payer。 */
  matchedBy: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  docNo: string;
  sourceType: "po_balance" | "prepay_tail";
  poId: string;
  matchId: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  status: "submitted" | "finance_approved" | "paid" | "rejected";
  requestedBy: string;
  financeApproverId: string | null;
  payerId: string | null;
  voucherCreatorId: string;
  paidAt: string | null;
  bankRef: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/**
 * docs/06 资产卡草案字段，加单据公共头。
 * S4：creatorId 不得等于 custodianId。基本流转为 active → transferred → retired。
 */
export interface AssetCard {
  id: string;
  docNo: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  /** 公共头金额，等于 capitalizedAmount。 */
  amount: string;
  status: AssetStatus;
  /** 请购申请人。 */
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assetNo: string;
  name: string;
  poId: string;
  grnId: string;
  custodianId: string;
  location: string;
  /** S4 建卡人，必须与保管人分离。 */
  creatorId: string;
  capitalizedAmount: string;
}

/** Q8。请购软占用、采购单硬占用。驳回、取消或关闭时释放。不是金蝶预算。 */
export interface BudgetHold {
  id: string;
  budgetId: string | null;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  kind: BudgetHoldKind;
  status: BudgetHoldStatus;
  sourceEntity: "PR" | "PO";
  sourceId: string;
  linkedPrId: string;
  releasedAt: string | null;
  releaseReason: BudgetReleaseReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrepayAttachment {
  kind: "po" | "contract" | "proforma";
  ref: string;
}

export interface PrepayRequest {
  id: string;
  docNo: string;
  poId: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  /** 占 PO 的比例，提交时写入。 */
  ratio: string | null;
  status: PrepayStatus;
  applicantId: string;
  deptApproverId: string | null;
  financeCosignerId: string | null;
  ceoApproverId: string | null;
  /** S5 预付审批人（①-P5），不是 ①-P3 加签人。 */
  paymentApproverId: string | null;
  /** S5 预付付款人（①-P6）。 */
  payerId: string | null;
  bankRef: string | null;
  paidAt: string | null;
  overdueFlag: boolean;
  promisedDeliveryDate: string | null;
  accrualBy: string | null;
  /** 本地预付挂账凭证号。不回写金蝶。 */
  accrualVoucherRef: string | null;
  financeGate: Gate;
  ceoGate: Gate;
  /** Q10：金额等于 PO 且允许全额时为 true，D-P1 强制高额档。 */
  fullPrepay: boolean;
  attachments: PrepayAttachment[];
  contractNo: string | null;
  proformaInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface PrepaySettle {
  id: string;
  docNo: string;
  prepayId: string;
  invoiceId: string;
  matchId: string;
  dp2Result: Dp2Result;
  tailPayId: string | null;
  refundId: string | null;
  createdAt: string;
  createdBy: string;
}

export interface PrepayRefund {
  id: string;
  docNo: string;
  prepayId: string;
  settleId: string;
  mode: RefundMode;
  amount: string;
  status: RefundStatus;
  requestedBy: string;
  financeApproverId: string | null;
  executorId: string | null;
  reasonCode: string | null;
  bankRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OverdueListItem {
  prepayId: string;
  docNo: string;
  poId: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  paidAt: string;
  ageDays: number;
  overdueDays: number;
  status: PrepayStatus;
  flagged: boolean;
}

export interface OverdueChase {
  id: string;
  docNo: string;
  prepayId: string;
  outcome: ChaseOutcome;
  note: string;
  promisedDeliveryDate: string | null;
  actorId: string;
  createdAt: string;
}

export interface PrepayReclaim {
  id: string;
  docNo: string;
  prepayId: string;
  amount: string;
  status: ReclaimStatus;
  requestedBy: string;
  executorId: string | null;
  bankRef: string | null;
  /** ①-E3b 本地冲预付凭证号。不回写金蝶。 */
  reversalVoucherRef: string | null;
  disputeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreApproval {
  id: string;
  docNo: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  status: PreStatus;
  applicantId: string;
  deptId: string;
  purpose: string;
  deptApproverId: string | null;
  consumedByExpenseId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface ExpenseClaim {
  id: string;
  docNo: string;
  companyCode: CompanyCode;
  currency: CurrencyCode;
  amount: string;
  status: ExpenseStatus;
  applicantId: string;
  deptId: string;
  purpose: string;
  /** Q5。提交时必须指向已批准 PRE。 */
  preApprovalId: string;
  invoiceNos: string[];
  employeeAccount: string;
  deptApproverId: string | null;
  ticketCheckerId: string | null;
  financeCosignerId: string | null;
  payerId: string | null;
  financeGate: Gate;
  paidAt: string | null;
  bankRef: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface AuditLog {
  id: string;
  entity:
    | "PR"
    | "PO"
    | "GRN"
    | "INV"
    | "MATCH"
    | "PAY"
    | "ASSET"
    | "USER"
    | "PREPAY"
    | "SETTLE"
    | "REFUND"
    | "CHASE"
    | "RECLAIM"
    | "PRE"
    | "EXP"
    | "BUDGET";
  entityId: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorId: string;
  at: string;
  comment: string;
  skipped: boolean;
  skippedReason?: string;
  sodViolationCode?: "S1" | "S2" | "S3" | "S4" | "S5";
}

export interface CreatePrInput {
  /** 省略时按币种推导：CNY→SZ，HKD→HK。 */
  companyCode?: string;
  currency: string;
  deptId: string;
  purpose: string;
  capexHint?: boolean;
  budgetId?: string | null;
  lines: Array<{
    itemName: string;
    spec?: string;
    purchaseUrl?: string;
    qty: number;
    estUnitPrice: string;
    category: string;
    images?: Array<{ name?: string; dataUrl?: string }>;
  }>;
}

export interface QuoteInput {
  vendorName: string;
  amount: string;
  leadTimeDays: number;
  selected: boolean;
}
