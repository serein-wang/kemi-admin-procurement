import type { AdminCategory } from "./categories.js";
import type { Role } from "./roles.js";
import type { CurrencyCode } from "./thresholds.js";

export type CompanyCode = "SZ" | "HK";
export type { CurrencyCode, Role, AdminCategory };

/** 阶段 1 只接受前两个。prepay 在入口直接拒绝。 */
export type PaymentTermsInput = "after_delivery" | "monthly" | "prepay";
export type Phase1PaymentTerms = "after_delivery" | "monthly";

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
  | "awaiting_receipt"
  | "partially_received"
  | "fully_received"
  | "matched"
  | "payment_pending"
  | "paid"
  | "closed"
  | "cancelled";

export type Gate = "pending" | "required" | "skipped" | "approved";
export type ReserveStatus = "none" | "soft" | "hard" | "released";
export type RfqWaiverKind = "below_threshold" | "low_value";

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

export interface PrLine {
  itemName: string;
  spec: string;
  qty: number;
  estUnitPrice: string;
  estAmount: string;
  category: AdminCategory;
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
  paymentTerms: Phase1PaymentTerms;
  paymentTermsDays: number | null;
  lines: PrLine[];
  /** D4。unset 表示尚未收齐。 */
  disposition: "unset" | "asset" | "expense";
  dispositionDone: boolean;
  /** ①-8b stub 回执。无真实 erp-pro 调用。 */
  erpInboundRefs: string[];
  reserveStatus: "hard";
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
  invoiceType: "special" | "general";
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
  matchResult: "matched";
  /** 记账人，供 S2：voucher.creator ≠ payment.payer。 */
  matchedBy: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  docNo: string;
  sourceType: "po_balance";
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

export interface AssetCard {
  id: string;
  docNo: string;
  assetNo: string;
  name: string;
  poId: string;
  grnId: string;
  custodianId: string;
  location: string;
  /** S4 与保管人分离的细则待定，本期只记录不拦截。 */
  creatorId: string;
  capitalizedAmount: string;
  status: "active";
  createdAt: string;
}

export interface AuditLog {
  id: string;
  entity: "PR" | "PO" | "GRN" | "INV" | "MATCH" | "PAY" | "ASSET" | "USER";
  entityId: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorId: string;
  at: string;
  comment: string;
  skipped: boolean;
  skippedReason?: string;
  sodViolationCode?: "S1" | "S2" | "S3";
}

export interface CreatePrInput {
  companyCode: string;
  currency: string;
  deptId: string;
  purpose: string;
  capexHint?: boolean;
  budgetId?: string | null;
  lines: Array<{
    itemName: string;
    spec?: string;
    qty: number;
    estUnitPrice: string;
    category: string;
  }>;
}

export interface QuoteInput {
  vendorName: string;
  amount: string;
  leadTimeDays: number;
  selected: boolean;
}
