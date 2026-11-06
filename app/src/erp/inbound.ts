import { parseCategory, type AdminCategory } from "../domain/categories.js";
import { DomainError } from "../domain/errors.js";
import type { CompanyCode } from "../domain/types.js";

export interface AdminInboundLine {
  itemName: string;
  qty: number;
  category: AdminCategory;
}

/**
 * 行政物资入库协同（选型 D）。
 * 契约里没有 cookie、没有生产料号审核会话。调用方无法通过本类型传入 pcba_session。
 */
export interface AdminInboundRequest {
  sourceDocNo: string;
  companyCode: CompanyCode;
  lines: AdminInboundLine[];
  sessionKind: "admin_inbound";
}

export interface AdminInboundAck {
  stub: true;
  ref: string;
  sessionKind: "admin_inbound";
}

export interface ErpProInboundPort {
  pushAdminInbound(request: AdminInboundRequest): Promise<AdminInboundAck>;
}

const FORBIDDEN_FIELDS = ["cookie", "cookies", "productionSession", "pcbaSession", "pcba_session"];

/**
 * 不访问 erp-pro，不读取浏览器 cookie。
 * 若调用方塞入生产会话字段，直接拒绝。
 */
export class ErpProInboundStub implements ErpProInboundPort {
  readonly calls: AdminInboundRequest[] = [];

  async pushAdminInbound(request: AdminInboundRequest): Promise<AdminInboundAck> {
    if (request.sessionKind !== "admin_inbound") {
      throw new DomainError("ERP_SESSION_ISOLATION", "erp-pro 仅接受行政入库会话 admin_inbound", 422);
    }
    const bag = request as AdminInboundRequest & Record<string, unknown>;
    for (const field of FORBIDDEN_FIELDS) {
      if (bag[field]) {
        throw new DomainError(
          "ERP_SESSION_ISOLATION",
          "erp-pro 入库 stub 拒绝会话 cookie 与生产料号审核会话",
          422,
        );
      }
    }
    if (request.lines.length === 0) {
      throw new DomainError("ERP_EMPTY_INBOUND", "没有可入库的行政物资行", 422);
    }
    for (const line of request.lines) {
      parseCategory(line.category);
    }
    this.calls.push(request);
    const ack: AdminInboundAck = {
      stub: true,
      ref: `ERP-STUB-${this.calls.length}`,
      sessionKind: "admin_inbound",
    };
    return ack;
  }
}
