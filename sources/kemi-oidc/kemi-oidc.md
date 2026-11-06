# KEMI 账号授权登录 · 概览

用 **KEMI 账号**为网页或移动 / 桌面应用提供统一登录。按接入端选择文档（**各文档独立完整，发对应链接即可对接**）：


| 文档                                      | 适用场景                                           |
| --------------------------------------- | ---------------------------------------------- |
| [网页接入](/docs/kemi-oidc/web)             | 浏览器 / H5：服务端持有 secret，授权码换票；站间免登约定 `/kemi/sso` |
| [Android 应用接入](/docs/kemi-oidc/android) | 原生 App：官方 SDK UI + 公开客户端 PKCE                  |
| [通用应用接入](/docs/kemi-oidc/app-api)       | 自建 UI：直接调 Auth HTTP API（Flutter / iOS / 桌面等）   |


概览仅作索引；对接请直接打开上表对应页面。

---

## 开始之前

1. 在 [开发者平台](https://kemi.newlinksz.com/kd) 注册并登录
2. 打开对应文档；Android 另需下载 SDK（见 Android 文档页）
3. 在 **控制台 → 应用管理** 创建应用：


| 类型         | 说明                                                    |
| ---------- | ----------------------------------------------------- |
| **Web 应用** | 登记授权登录；自动生成 `client_id` / `client_secret`；回调可创建时或之后填写 |
| **安卓应用**   | 走市场上架；创建时自动开通授权，回调为 `{包名}://oauth/callback`           |


---



## 怎么分工


| 能力               | 由谁负责                              |
| ---------------- | --------------------------------- |
| 账号、登录、全局昵称       | UserCenter（KEMI 账号）               |
| 应用凭证 `client_id` | 你在开发者平台为自己的产品创建                   |
| 产品内权限、站内昵称       | 你的业务库（建议 `uc_user_id` 关联 KEMI 用户） |


网页与 Android 均为：**授权码换取** `access_token`**，再用 Bearer 访问用户信息**。  
`access_token` 过期后重新走授权流程。

---



## 正式环境地址


| 服务             | 地址                                                                             | 用途                   |
| -------------- | ------------------------------------------------------------------------------ | -------------------- |
| UserCenter API | [https://kemi.newlinksz.com/usercenter](https://kemi.newlinksz.com/usercenter) | 授权 / 换票 / 用户信息       |
| UserCenter Web | [https://kemi.newlinksz.com/uc](https://kemi.newlinksz.com/uc)                 | 用户登录与选账号（浏览器打开）      |
| 开发者平台          | [https://kemi.newlinksz.com/kd](https://kemi.newlinksz.com/kd)                 | 创建应用、查阅文档            |
| 开发者平台 API      | [https://kemi.newlinksz.com/kd-api](https://kemi.newlinksz.com/kd-api)         | 商店 / 控制台后端（App 商店基址） |


本机联调仍可用局域网 `172.21.16.10:8401/8402/8411/8412`（见仓库开发配置）。

```http
GET https://kemi.newlinksz.com/usercenter/.well-known/openid-configuration
```

---



## 用户信息与账号中心

```http
GET https://kemi.newlinksz.com/usercenter/oauth/userinfo
Authorization: Bearer <access_token>
```

打开账号中心（修改手机 / 邮箱 / 全局昵称）：

```text
https://kemi.newlinksz.com/uc/sso?token=<access_token>&next=/account
```

---



## 本地用户表示例

```text
user_id         本地主键
uc_user_id      唯一，对应 userinfo.sub
display_name    站内昵称
role / status   本产品权限
```

---



## 安全要点

- Web：`client_secret` 仅保存在服务端  
- Android：使用 PKCE，勿将 secret 打进安装包  
- `redirect_uri` 必须与登记值完全一致  
- 授权请求携带随机 `state`  
- 只使用自己名下应用的凭证

---



## 注意事项

**特别说明：KEMI 账号只负责登录身份，不负责你的网站 / 应用内的访问权限。**

KEMI 登录成功只说明「用户是谁」；能否进入站点、开放哪些页面或功能，由业务方自行决定。

若不想对所有人开放，或部分页面仅限授权用户，请自行搭建账号 / 权限管理系统，并明确告知：未获本产品授权的账号，无权登录或使用该网站 / 应用。