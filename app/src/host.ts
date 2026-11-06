import type { PrepayPolicy, ThresholdConfig } from "./domain/thresholds.js";
import type { ErpProInboundPort } from "./erp/inbound.js";
import type { OidcClient } from "./oidc/client.js";
import type { ProcurementService } from "./procurement/service.js";
import type { MemoryStore } from "./store/memory.js";

/**
 * 宿主只调用 registerAdminProcurement。
 * 本模块不读取 KEMI One / Canvas 的页面、待办或权限 API。
 */
export interface ModuleOptions {
  thresholds: ThresholdConfig;
  /** 缺省为全部未配置，且不允许全额预付。 */
  prepayPolicy?: PrepayPolicy;
  oidc: OidcClient;
  allowDevLogin: boolean;
  seedDemoUsers: boolean;
  /** 保留给会话签名扩展。当前会话 id 为随机串，仍要求足够长度，避免空配置上线。 */
  sessionSecret: string;
  erp?: ErpProInboundPort;
  /** 挂到宿主路径下，例如 /apps/admin-procurement。独立运行时为空。 */
  routePrefix?: string;
  clock?: () => Date;
}

export interface SessionRecord {
  userId: string;
  accessToken: string | null;
  expiresAt: number;
}

export interface DemoUser {
  ucUserId: string;
  displayName: string;
  roles: string[];
}

export interface ModuleHandle {
  store: MemoryStore;
  service: ProcurementService;
  erp: ErpProInboundPort;
  demoUsers: DemoUser[];
  sessions: Map<string, SessionRecord>;
}
