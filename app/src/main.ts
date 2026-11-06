import Fastify from "fastify";
import { loadAppEnv, loadDotEnv } from "./config.js";
import { registerAdminProcurement } from "./module.js";
import { createKemiOidcClient } from "./oidc/client.js";

loadDotEnv();
const env = loadAppEnv();

const app = Fastify({ logger: true, disableRequestLogging: true });
await registerAdminProcurement(app, {
  thresholds: env.thresholds,
  oidc: createKemiOidcClient(env.oidc),
  allowDevLogin: env.allowDevLogin,
  seedDemoUsers: env.seedDemoUsers,
  sessionSecret: env.sessionSecret,
  routePrefix: "",
});

await app.listen({ port: env.port, host: env.host });
app.log.info({ port: env.port, host: env.host, devLogin: env.allowDevLogin }, "admin-procurement listening");
