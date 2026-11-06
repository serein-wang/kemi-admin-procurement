import assert from "node:assert/strict";
import test from "node:test";
import { createKemiOidcClient, type OidcClient, type TokenResponse } from "../src/oidc/client.js";
import { boot } from "./helpers.js";

function cookieNamed(raw: string | string[] | undefined, name: string): string {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((item) => item.startsWith(`${name}=`));
  assert.ok(found, `missing ${name}`);
  return found.split(";")[0] ?? "";
}

test("授权地址不含 client_secret，换票走服务端且按 sub upsert", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth/token")) {
      const payload: TokenResponse = {
        access_token: "atk-1",
        token_type: "Bearer",
        expires_in: 3600,
        user: { sub: "12", nickname: "演示", username: "demo", email: "a@example.com" },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ sub: "12", nickname: "演示更新" }), { status: 200 });
  };
  const client = createKemiOidcClient({
    clientId: "cid",
    clientSecret: "super-secret",
    redirectUri: "http://127.0.0.1:3000/auth/callback",
    ucApi: "https://kemi.example/usercenter",
    fetchImpl,
  });
  const authorize = client.buildAuthorizeUrl("state-1");
  assert.match(authorize, /response_type=code/);
  assert.match(authorize, /scope=openid\+profile|scope=openid%20profile/);
  assert.equal(authorize.includes("super-secret"), false);
  assert.match(authorize, /\/oauth\/authorize/);

  const token = await client.exchangeCode("one-time-code");
  assert.equal(token.access_token, "atk-1");
  const tokenCall = calls[0];
  assert.ok(tokenCall);
  assert.match(tokenCall.url, /\/oauth\/token$/);
  const sent = String(tokenCall.init?.body);
  assert.match(sent, /grant_type=authorization_code/);
  assert.match(sent, /client_secret=super-secret/);
  assert.match(sent, /redirect_uri=/);
  assert.equal(tokenCall.init?.headers && JSON.stringify(tokenCall.init.headers).includes("super-secret"), false);

  const profile = await client.fetchUserInfo("atk-1");
  assert.equal(profile.sub, "12");
  const infoHeaders = calls[1]?.init?.headers as Record<string, string> | undefined;
  assert.match(infoHeaders?.authorization ?? "", /Bearer atk-1/);
});

test("回调校验 state，并用 sub 建立本地用户且不覆盖已授予角色", async () => {
  let tokenCalls = 0;
  const oidc: OidcClient = {
    buildAuthorizeUrl(state: string) {
      return `https://kemi.example/oauth/authorize?state=${encodeURIComponent(state)}&response_type=code`;
    },
    async exchangeCode(code: string) {
      tokenCalls += 1;
      assert.equal(code, "auth-code");
      return {
        access_token: "server-token",
        token_type: "Bearer",
        expires_in: 100,
        user: { sub: "12", nickname: "演示", username: "demo" },
      };
    },
    async fetchUserInfo() {
      return { sub: "12", nickname: "不应被调用" };
    },
  };
  const { app, handle } = await boot({ oidc, allowDevLogin: true });
  try {
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    assert.equal(start.statusCode, 302);
    const location = String(start.headers.location);
    assert.equal(location.includes("client_secret"), false);
    const state = new URL(location).searchParams.get("state");
    assert.ok(state);
    const setCookie = start.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0];

    const bad = await app.inject({
      method: "GET",
      url: `/auth/callback?code=auth-code&state=wrong`,
      headers: { cookie },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(tokenCalls, 0);

    const ok = await app.inject({
      method: "GET",
      url: `/auth/callback?code=auth-code&state=${state}`,
      headers: { cookie },
    });
    assert.equal(ok.statusCode, 302);
    assert.equal(tokenCalls, 1);
    const sessionCookie = cookieNamed(ok.headers["set-cookie"], "ap_session");
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: sessionCookie } });
    assert.equal(me.statusCode, 200);
    const user = me.json().user;
    assert.equal(user.ucUserId, "12");
    assert.equal(user.status, "pending");
    assert.deepEqual(user.roles, []);

    const admin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { ucUserId: "uc-admin" },
    });
    const adminCookie = (Array.isArray(admin.headers["set-cookie"]) ? admin.headers["set-cookie"][0] : admin.headers["set-cookie"])!
      .split(";")[0];
    const granted = await app.inject({
      method: "POST",
      url: `/api/users/${user.id}/roles`,
      headers: { cookie: adminCookie },
      payload: { roles: ["applicant"] },
    });
    assert.equal(granted.statusCode, 200);

    const againStart = await app.inject({ method: "GET", url: "/auth/login" });
    const againState = new URL(String(againStart.headers.location)).searchParams.get("state");
    const againCookie = (Array.isArray(againStart.headers["set-cookie"])
      ? againStart.headers["set-cookie"][0]
      : againStart.headers["set-cookie"])!.split(";")[0];
    const again = await app.inject({
      method: "GET",
      url: `/auth/callback?code=auth-code&state=${againState}`,
      headers: { cookie: againCookie },
    });
    assert.equal(again.statusCode, 302);
    const stored = [...handle.store.users.values()].find((row) => row.ucUserId === "12");
    assert.ok(stored);
    assert.deepEqual(handle.store.rolesOf(stored.id), ["applicant"]);
    assert.equal([...handle.store.users.values()].filter((row) => row.ucUserId === "12").length, 1);
  } finally {
    await app.close();
  }
});
