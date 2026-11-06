import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { DEMO_USERS } from "./auth/demo-users.js";
import { emptyPrepayPolicy } from "./domain/thresholds.js";
import type { ModuleHandle, ModuleOptions } from "./host.js";
import { registerRoutes } from "./http/routes.js";
import { ErpProInboundStub } from "./erp/inbound.js";
import { ProcurementService } from "./procurement/service.js";
import { MemoryStore } from "./store/memory.js";

export type { ModuleHandle, ModuleOptions } from "./host.js";

/**
 * 可嵌入入口。宿主创建自己的 Fastify（或包一层适配）后调用本函数。
 * 不探测、不调用 KEMI One / Canvas 的工作流、待办或权限接口。
 */
export async function registerAdminProcurement(
  app: FastifyInstance,
  options: ModuleOptions,
): Promise<ModuleHandle> {
  if (!options.sessionSecret || options.sessionSecret.length < 16) {
    throw new Error("sessionSecret 至少 16 字符");
  }
  const store = new MemoryStore();
  const erp = options.erp ?? new ErpProInboundStub();
  const service = new ProcurementService({
    store,
    thresholds: options.thresholds,
    prepayPolicy: options.prepayPolicy ?? emptyPrepayPolicy(),
    erp,
    clock: options.clock,
  });
  if (options.seedDemoUsers) {
    const now = (options.clock ?? (() => new Date()))().toISOString();
    for (const demo of DEMO_USERS) {
      const id = store.nextId("USR");
      store.addUser({
        id,
        ucUserId: demo.ucUserId,
        displayName: demo.displayName,
        email: null,
        username: demo.ucUserId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      store.replaceRoles(id, demo.roles, "seed", now);
    }
  }
  const handle: ModuleHandle = {
    store,
    service,
    erp,
    demoUsers: options.seedDemoUsers ? DEMO_USERS.map((row) => ({ ...row, roles: [...row.roles] })) : [],
    sessions: new Map(),
  };
  await app.register(cookie, { secret: options.sessionSecret });
  const prefix = options.routePrefix ?? "";
  await app.register(
    async (instance) => {
      await registerRoutes(instance, options, handle);
    },
    { prefix },
  );
  return handle;
}
