import { DomainError } from "../domain/errors.js";

/** 换票 / userinfo 里出现的身份字段。不使用 id_token。 */
export interface OidcUserProfile {
  sub: string;
  user_id?: number | string;
  username?: string | null;
  preferred_username?: string | null;
  nickname?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  user?: OidcUserProfile;
}

export interface OidcClient {
  buildAuthorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenResponse>;
  fetchUserInfo(accessToken: string): Promise<OidcUserProfile>;
}

export interface KemiOidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** 例如 https://kemi.newlinksz.com/usercenter ，无末尾斜杠。 */
  ucApi: string;
  fetchImpl?: typeof fetch;
}

function assertConfigured(config: KemiOidcConfig): void {
  if (!config.clientId || !config.clientSecret || !config.redirectUri || !config.ucApi) {
    throw new DomainError(
      "OIDC_NOT_CONFIGURED",
      "KEMI OIDC 未配置。需要 KEMI_CLIENT_ID、KEMI_CLIENT_SECRET、KEMI_REDIRECT_URI、KEMI_UC_API",
      503,
    );
  }
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * KEMI 网页授权码（sources/kemi-oidc/kemi-oidc_web.md）。
 * client_secret 只出现在服务端换票请求体里，不进浏览器，不进日志。
 * 不请求、不解析 id_token / refresh_token。
 */
export function createKemiOidcClient(config: KemiOidcConfig): OidcClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const ucApi = config.ucApi.replace(/\/$/, "");

  return {
    buildAuthorizeUrl(state: string): string {
      assertConfigured(config);
      const url = new URL("/oauth/authorize", `${ucApi}/`);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid profile");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code: string): Promise<TokenResponse> {
      assertConfigured(config);
      if (!code) {
        throw new DomainError("OIDC_INVALID_GRANT", "缺少授权码", 400);
      }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      const response = await fetchImpl(`${ucApi}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
      const payload = (await response.json().catch(() => ({}))) as TokenResponse & OAuthErrorBody;
      if (!response.ok || !payload.access_token) {
        throw new DomainError(
          "OIDC_TOKEN_FAILED",
          payload.error_description || payload.error || "换票失败",
          400,
        );
      }
      return payload;
    },

    async fetchUserInfo(accessToken: string): Promise<OidcUserProfile> {
      assertConfigured(config);
      const response = await fetchImpl(`${ucApi}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
      const payload = (await response.json().catch(() => ({}))) as OidcUserProfile & OAuthErrorBody;
      if (!response.ok || !payload.sub) {
        throw new DomainError(
          "OIDC_USERINFO_FAILED",
          payload.error_description || payload.error || "读取用户信息失败",
          400,
        );
      }
      return payload;
    },
  };
}

export function displayNameFromProfile(profile: OidcUserProfile): string {
  return profile.nickname || profile.name || profile.username || profile.preferred_username || profile.sub;
}
