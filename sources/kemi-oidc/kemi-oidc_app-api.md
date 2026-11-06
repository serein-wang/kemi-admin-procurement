# KEMI 账号 · 通用应用接入

自建登录 / 改密 / 改昵称等界面时，直接调用 UserCenter **HTTP API**。适用于 Flutter、原生 Android / iOS、桌面端等任意能发 HTTPS 的客户端。

与 [网页接入](/docs/kemi-oidc/web)、[Android SDK 接入](/docs/kemi-oidc/android) 的区别：

| 方式 | 界面 | 凭证 | 适用 |
|------|------|------|------|
| 网页接入 | UC 网页授权页 | `client_id` + **`client_secret`（仅服务端）** | 有后端的 Web / H5 |
| Android SDK | SDK 原生 UI | 公开客户端 + **PKCE**（包内仅 `client_id`） | 想用官方登录页 |
| **通用应用接入（本文）** | **完全自建** | **不强制** `client_id`；拿到 UC `access_token` | 自定义 UI |

本文接口均为**加性**能力，不改变现有商城 / SDK / 网页行为。

---

## 正式环境

| 项 | 值 |
|----|-----|
| API 基址 | `https://kemi.newlinksz.com/usercenter` |
| 内容类型 | `Content-Type: application/json` |
| 鉴权头 | `Authorization: Bearer <token>`（需登录的接口） |

统一响应：

```json
{ "status": 200, "msg": "success", "data": { } }
```

`status !== 200` 表示失败（业务错误时 HTTP 仍可能为 200，以 JSON 的 `status` / `msg` 为准；未登录多为 HTTP 401）。

---

## 安全说明（必读）

1. **传输**：正式环境必须 HTTPS。  
2. **`client_id` 不是密钥**：公开标识可被复制；**不要**把 `client_secret` 打进安装包。  
3. **本路径不强制 `client_id`**：`/api/auth/login` 等与现网一致，有账号凭证即可发 token。若业务需要「仅登记应用可换票」，请改走 OAuth + PKCE（见 Android / 网页文档），不要误以为「传了 client_id 就绑定了应用」。  
4. **Token**：落盘用系统安全存储；勿打日志；退出调用 logout，可踢设备。  
5. **短信**：有限频与日限额；正式环境发码接口**不回传**验证码。  
6. **仅验码接口**：校验成功后**立即消费**验证码，同一码不能再用于登录 / 重置密码。需要登录请直接调 `sms-login` / `code-login`。

---

## 密码规则（现网）

适用于注册设密、已登录改密（`set-password`）、忘记密码重置（`reset-password`）以及管理端重置：

| 项 | 规则 |
|----|------|
| 最短 | **至少 6 个字符**（按字符串长度计，UTF-8 下 1 个汉字算 1 位） |
| 最长 | **最多 64 个字符**（超出返回「密码最多64位」/「新密码最多64位」） |
| 字符集 | **无格式要求**：不必含大小写 / 数字 / 特殊符号；空格等可提交（不推荐） |
| 登录 | `/login` 只校验账号与哈希是否匹配，**不**再校验密码形态 |

不满足长度时常见错误文案：`密码至少6位` / `密码最多64位` / `新密码至少6位` / `新密码最多64位`。

---

## 1. 账号密码登录

```http
POST /api/auth/login
```

```json
{
  "account": "手机号或用户名或邮箱",
  "password": "密码",
  "device_id": "可选，稳定设备标识",
  "device_name": "可选，如 MyApp/Android"
}
```

成功 `data`：

```json
{
  "token": "<access_token>",
  "device_id": "...",
  "expires_in": 604800,
  "user": {
    "user_id": 1,
    "username": "u12345678",
    "phone": "135****8559",
    "email": null,
    "nickname": "昵称",
    "avatar": null,
    "role": 2,
    "status": 1,
    "has_password": true,
    "created_at": "..."
  }
}
```

后续请求带：`Authorization: Bearer <token>`。

---

## 2. 短信：发码 / 仅验码 / 登录

### 发短信验证码

```http
POST /api/auth/send-sms-code
```

```json
{ "phone": "13800138000", "scene": "login" }
```

`scene` 仅作业务标记，可选。成功时正式环境只有 `tip`，**无** `code` 字段。

也可用统一发码（手机或邮箱）：

```http
POST /api/auth/send-code
```

```json
{ "account": "13800138000", "scene": "login" }
```

### 仅校验短信码（不登录）

用于自有业务确认「手机号持有人」，**不发 token**。

```http
POST /api/auth/verify-sms-code
```

```json
{ "phone": "13800138000", "code": "123456" }
```

```json
{ "status": 200, "msg": "验证通过", "data": { "valid": true } }
```

错误或过期时仍为 `status: 200`，`data.valid === false`（便于客户端分支）。**通过后验证码已删除。**

### 短信验证码登录（未注册自动开户）

```http
POST /api/auth/sms-login
```

```json
{
  "phone": "13800138000",
  "code": "123456",
  "device_id": "可选",
  "device_name": "可选"
}
```

成功形态同密码登录（含 `token` + `user`）。

手机或邮箱统一验证码登录：`POST /api/auth/code-login`，body `{ "account", "code", ... }`。

---

## 3. 当前用户信息

```http
GET /api/auth/me
Authorization: Bearer <token>
```

`data` 为用户对象（同登录返回的 `user` 字段）。

---

## 4. 修改昵称 / 头像

`avatar` 即**头像**，库内存的是 **HTTPS URL 字符串**（最长约 512 字符），不是文件本体。

```http
POST /api/auth/profile
Authorization: Bearer <token>
```

```json
{ "nickname": "新昵称", "avatar": "可选，头像图片 URL" }
```

- `nickname`：可选；非空、最长 32 字符。  
- `avatar`：可选；传入完整可访问的图片 URL 即可写入；不传则不改头像。  
- 两个字段都可只传其中一个。

### 头像图怎么来

UserCenter **不提供**文件上传；先把图存到可公网访问的地址，再把 URL 写入 `avatar`。

推荐使用开发者平台 **开放图片上传**（七牛图床，RSA 信封鉴权，说明见 [开放图片上传](/docs/image-upload)）：

1. `POST https://kemi.newlinksz.com/kd-api/api/open/images/upload` 上传图片，拿到返回的 `url`  
2. `POST /api/auth/profile`，body 带 `"avatar": "<上一步的 url>"`  
3. 可选：`GET /api/auth/me` 确认 `avatar` 已更新  

也可用你们自有 CDN / 对象存储上的 HTTPS 图链，只要最终能被客户端直接打开即可。

---

## 5. 已登录改密

```http
POST /api/auth/set-password
Authorization: Bearer <token>
```

```json
{
  "old_password": "有密码时必填",
  "new_password": "新密码（6～64 位，见上方「密码规则」）"
}
```

无密码用户（纯验证码开户）可省略 `old_password`，直接设密。`new_password` 须为 6～64 位。

改密成功后，当前设备保持登录；其他已登录设备会退出，需使用新密码重新登录。

---

## 6. 忘记密码（验证码重置）

免登录：

```http
POST /api/auth/reset-password
```

```json
{
  "account": "手机号或邮箱",
  "code": "验证码",
  "new_password": "新密码（6～64 位，见「密码规则」）",
  "device_id": "可选",
  "device_name": "可选"
}
```

成功会**直接登录**并返回 `token`（与登录接口相同）。若账号原先已有登录，其他设备会退出，需使用新密码重新登录。

---

## 7. 绑定 / 换绑手机与邮箱

均需 `Authorization: Bearer <token>`。

**换绑**：没有单独「改邮箱」接口，流程为 **先解绑 → 再绑定新地址**。  
已绑定过时，直接调绑定接口会返回「请先解绑后再绑定」。

### 绑定前发码（发到**目标**手机/邮箱）

校验目标号/邮箱未被其他账号占用；若本人已绑定同类型（已有手机或已有邮箱），会拒绝。

```http
POST /api/auth/bind/send-code
```

```json
{ "account": "新手机号或新邮箱" }
```

成功 `data` 含 `tip`、`channel`（`sms` | `email`）。正式环境**不回传**验证码。

### 绑定手机

```http
POST /api/auth/bind-phone
```

```json
{ "phone": "13800138000", "code": "123456" }
```

成功返回更新后的用户对象（同 `/me`）。

### 绑定邮箱

```http
POST /api/auth/bind-email
```

```json
{ "email": "user@example.com", "code": "123456" }
```

成功返回更新后的用户对象。

### 解绑前发码（发到**当前已绑定**的手机/邮箱）

```http
POST /api/auth/unbind/send-code
```

```json
{ "type": "phone" }
```

或

```json
{ "type": "email" }
```

成功 `data` 含 `tip`、`channel`、以及脱敏后的 `masked`。

### 解绑手机

```http
POST /api/auth/unbind-phone
```

```json
{ "code": "123456" }
```

### 解绑邮箱

```http
POST /api/auth/unbind-email
```

```json
{ "code": "123456" }
```

### 换绑邮箱示例

1. `POST /api/auth/unbind/send-code` `{ "type": "email" }` → 旧邮箱收码  
2. `POST /api/auth/unbind-email` `{ "code": "旧邮箱验证码" }`  
3. `POST /api/auth/bind/send-code` `{ "account": "new@example.com" }` → 新邮箱收码  
4. `POST /api/auth/bind-email` `{ "email": "new@example.com", "code": "新邮箱验证码" }`  
5. 可选：`GET /api/auth/me` 确认 `email` 已更新  

首次绑定（当前 `email` 为空）只需步骤 3～4。

账号中心 Web（`/uc/`）已提供手机/邮箱的「绑定 / 换绑」入口，内部即调用上述接口。

---

## 7.1 注销账号

用户确认身份后即可注销。注销立即生效：原账号不能再登录；原手机号 / 邮箱可以重新注册。

验证方式建议优先使用已绑定的手机，其次邮箱，都没有时再用登录密码。

### 注销前发码

使用手机或邮箱验证时，先发码：

```http
POST /api/auth/delete-account/send-code
Authorization: Bearer <token>
```

```json
{ "method": "phone" }
```

或 `{ "method": "email" }`。成功 `data` 含 `tip`、`channel`、脱敏 `masked`。

### 确认注销

```http
POST /api/auth/delete-account
Authorization: Bearer <token>
```

```json
{ "method": "phone", "code": "123456" }
```

或

```json
{ "method": "email", "code": "123456" }
```

或

```json
{ "method": "password", "password": "当前登录密码" }
```

成功后当前登录立即失效，客户端应清空本地 token 并回到登录页。

账号中心 Web（`/uc/`）已提供「注销账号」入口。

---

## 8. 退出与设备

```http
POST /api/auth/logout
Authorization: Bearer <token>
```

```http
GET /api/auth/devices
Authorization: Bearer <token>
```

```http
POST /api/auth/devices/kick
Authorization: Bearer <token>
```

```json
{ "device_id": "要踢下线的设备 id" }
```

---

## 9. （可选）密码加密传输

若不想明文密码过链路，可先取公钥再加密后作为 `password` 字段提交（与现网 Web 一致）：

```http
GET /api/auth/public-key
```

返回 RSA 公钥；客户端用公钥加密密码字符串后再调用 `/login` 等。若服务端未启用解密，仍可按明文对接（以现网配置为准）。

---

## 最小对接流程（推荐）

1. `POST /api/auth/login`（或短信登录）→ 保存 `token`  
2. `GET /api/auth/me` → 展示个人信息  
3. 需要时 `POST /api/auth/profile` / `set-password`  
4. 需要绑邮箱 / 换绑：按第 7 节「解绑 → 绑定」  
5. 退出 `POST /api/auth/logout`

独立短信校验场景：`send-sms-code` → `verify-sms-code`（仅 `valid`，无 token）。

---

## 与 OAuth / client_id 的关系

- **只要账号能力、自建 UI**：按本文 Auth API 即可，**不必**配置 `client_id`。  
- **要走授权码、应用绑定、SDK 同款换票**：请用网页或 Android 文档；公开客户端包内仅 `client_id` + PKCE。  
- 两种路径拿到的会话都是 UC Bearer token，可访问 `/api/auth/me` 等（OAuth 换得的 token 亦兼容用户信息类接口，以现网为准）。

---

## 联调检查清单

- [ ] 基址为 `https://kemi.newlinksz.com/usercenter`  
- [ ] 登录后请求带 `Authorization: Bearer ...`  
- [ ] Token 存安全存储，未写入日志  
- [ ] 未把 `client_secret` 打进客户端  
- [ ] 仅验码与登录不要共用同一条已消费验证码  
- [ ] 换绑邮箱走「解绑旧邮箱 → 绑定新邮箱」，不要期望单接口改邮箱  
- [ ] 设密 / 改密 / 重置密码均满足 6～64 位（无其它字符格式要求）  
