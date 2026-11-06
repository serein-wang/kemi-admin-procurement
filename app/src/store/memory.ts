import type { Role } from "../domain/roles.js";
import type {
  AssetCard,
  AuditLog,
  Grn,
  InvoiceRegister,
  MatchSheet,
  Payment,
  PurchaseOrder,
  PurchaseRequisition,
  QuoteCompare,
  RoleAssignment,
  User,
  Vendor,
} from "../domain/types.js";

/** 进程内存储。嵌入宿主时可以换成同一套仓储接口，不绑定 Canvas。 */
export class MemoryStore {
  readonly users = new Map<string, User>();
  readonly userIdByUc = new Map<string, string>();
  readonly prs = new Map<string, PurchaseRequisition>();
  readonly pos = new Map<string, PurchaseOrder>();
  readonly grns = new Map<string, Grn>();
  readonly invoices = new Map<string, InvoiceRegister>();
  readonly matches = new Map<string, MatchSheet>();
  readonly payments = new Map<string, Payment>();
  readonly assets = new Map<string, AssetCard>();
  readonly vendors = new Map<string, Vendor>();
  readonly quotes = new Map<string, QuoteCompare>();
  readonly audits: AuditLog[] = [];
  roleAssignments: RoleAssignment[] = [];
  private seq = 0;

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  addUser(user: User): void {
    if (this.userIdByUc.has(user.ucUserId)) {
      throw new Error(`duplicate uc_user_id ${user.ucUserId}`);
    }
    this.users.set(user.id, user);
    this.userIdByUc.set(user.ucUserId, user.id);
  }

  replaceRoles(userId: string, roles: Role[], assignedBy: string | null, at: string): void {
    this.roleAssignments = this.roleAssignments.filter((row) => row.userId !== userId);
    for (const role of roles) {
      this.roleAssignments.push({
        id: this.nextId("ROLE"),
        userId,
        role,
        assignedBy,
        assignedAt: at,
      });
    }
  }

  rolesOf(userId: string): Role[] {
    return this.roleAssignments.filter((row) => row.userId === userId).map((row) => row.role);
  }

  upsertVendor(name: string): Vendor {
    for (const vendor of this.vendors.values()) {
      if (vendor.name === name) return vendor;
    }
    const vendor = { id: this.nextId("VEN"), name };
    this.vendors.set(vendor.id, vendor);
    return vendor;
  }

  quoteByPr(prId: string): QuoteCompare | undefined {
    for (const quote of this.quotes.values()) {
      if (quote.prId === prId) return quote;
    }
    return undefined;
  }

  grnsByPo(poId: string): Grn[] {
    return [...this.grns.values()].filter((row) => row.poId === poId);
  }

  invoiceByPo(poId: string): InvoiceRegister | undefined {
    for (const invoice of this.invoices.values()) {
      if (invoice.poId === poId) return invoice;
    }
    return undefined;
  }

  matchByPo(poId: string): MatchSheet | undefined {
    for (const match of this.matches.values()) {
      if (match.poId === poId) return match;
    }
    return undefined;
  }

  paymentByPo(poId: string): Payment | undefined {
    for (const payment of this.payments.values()) {
      if (payment.poId === poId) return payment;
    }
    return undefined;
  }
}
