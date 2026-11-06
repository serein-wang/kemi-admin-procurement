# 08 · KEMI One / Canvas 栈调研（行政采购嵌入）

> 调研日期：2026-11-06 Asia/Shanghai  
> 目的：选型 **A（嵌入 KEMI One / Canvas）+ D（erp-pro 入库/料号协同）** 后，摸清代码仓、工作流、权限，供阶段 1 接入。  
> 约束：只读检索；**未改**他人工程；凭据不进本包。  
> 身份权威：`sources/kemi-oidc/`（自 [KEMI 账号授权登录](https://kemi.newlinksz.com/kd/docs/kemi-oidc) / `kd-api` 拉取）。  
> **状态更新（2026-11-06 开工后）：** 宿主仓仍未找到。阶段 1 不阻塞于 Canvas：业务代码在本仓库 `app/`，作为可嵌入模块实现，不臆造宿主 API。下文检索结论保持为调研当时的记录。

---

## 1. 结论摘要（先读）

| 项 | 结论 |
|----|------|
| KEMI One / Canvas **源码仓** | **本轮未找到**（本机 Documents / D:\\Share / Mac / box / Origin 可见命名空间空；GitHub MCP 未授权） |
| 行政采购业务模块 | **不存在**既有工程；仅有本 Spec 包 |
| **身份 / 登录** | **已摸清**：走 **KEMI OIDC（网页授权码）**；**不另建账号体系** |
| **产品内权限 / SoD** | OIDC **只证明「是谁」**；角色与 SoD（S1–S5）须在 **行政采购应用内**授权 |
| 工作流引擎 | **未找到**可引用的引擎实现或文档；阶段 1 须向持仓人确认 Canvas 是否已有审批流能力 |
| 与 erp-pro | 同属 `*.newlinksz.com` 生态；erp-pro 为外围入库/料号，**不是**行政采购审批宿主 |

**对选型 A 的对齐一句话：** 行政采购作为 KEMI One/Canvas 内网页模块 → **OIDC 网页接入拿 `sub`** → 本地用户表 `uc_user_id` + **应用内角色/SoD**；阈值与矩阵仍配置注入。

---

## 2. 命中清单

### 2.1 直接相关

| 路径 / 仓 | 一句话 |
|-----------|--------|
| `C:\\Users\\serein\\Documents\\KemiOne-AdminProcurement\\`（及 box `/workspace/KemiOne-AdminProcurement/`） | 本 Spec 包；**唯一**「行政采购」工程痕迹 |
| `D:\\Users\\serein\\Desktop\\行政采购流程-讨论稿-v3.pdf` | 源稿 v3（流程/SoD/开放问题）；页脚「未改 KEMI One / Canvas」 |
| `sources/kemi-oidc/*.md` | KEMI OIDC 官方文档镜像（概览 / web / android / app-api） |
| https://kemi.newlinksz.com/kd/docs/kemi-oidc | OIDC 文档权威入口（开发者平台 SPA `/kd/`） |
| `GET https://kemi.newlinksz.com/kd-api/api/public/docs/{kemi-oidc\|kemi-oidc/web\|kemi-oidc/android\|kemi-oidc/app-api}` | 文档正文 API（本轮据此落盘 sources） |
| `GET https://kemi.newlinksz.com/usercenter/.well-known/openid-configuration` | OIDC 发现文档（issuer / authorize / token / userinfo / jwks / sso-*） |

### 2.2 同生态但非「KEMI One / Canvas 源码」

| 路径 / URL | 一句话 |
|------------|--------|
| https://kemi-chat.newlinksz.com/erp-pro/ | erp-pro（料号/销售订单等）；Chrome 书签有 sales-orders；**选型 D 外围** |
| https://kemi.newlinksz.com/usercenter · `/uc` · `/kd` · `/kd-api` | UserCenter / 账号中心 / 开发者平台 |
| https://kemi-chat1.newlinksz.com/buddy/ | 企微/聊天相关入口（MsgIntel 笔记提及） |
| `work.newlinksz.cn:*`（书签：3000 Redmine、8363 周报、5002、5555 production、5018） | 内网办公站；**未见**明确标为「KEMI One」或「Canvas」的路径 |
| https://github.com/newlinksz/KemiCAD | 公开 **KemiCAD（EDA）**，与行政采购 / One 无关 |
| `D:\\Program Files\\KemiCAD\\` · Desktop `kemiCAD` | 本机 CAD 安装与安装包；**非** KEMI One |
| `D:\\Share\\ErpAuditKit-*` · Documents RedmineKit / MaterialCodeNaming | erp-pro 审核与料号规范；会话 `pcba_session`，与星空隔离 |
| Mac `~/Documents/SmartTodoSystem*` | 个人 Todo（Vite/Tauri）；**无** KEMI One/Canvas 关联 |

### 2.3 明确「未找到」

| 检索面 | 结果 |
|--------|------|
| Windows：Documents / Downloads / OneDrive / D:\\Share / Desktop（D:\\Users\\serein\\Desktop）名含 KemiOne / Canvas（产品义）/ 行政采购工程 | **无源码仓**；仅 Spec + 讨论稿 PDF + KEMI 产品品牌资料 |
| 浅层 `.git` remote（Documents / Desktop / Share） | **无**指向 KEMI One / Canvas 的 remote |
| box `/workspace` | 无 KEMI One / Canvas 应用仓；仅有本 Spec 与金蝶/料号/EDA 等旁系 |
| Cursor Origin `list_namespaces` | **空**（已连接但可见 owner 为空） |
| GitHub MCP | **needsAuth**；未列私有仓 |
| 公开 Web / `site:newlinksz.com` | **无**「KEMI One Canvas 工作流」产品文档；易与法国 KEM ONE、Instructure Canvas LMS、Cursor Canvas Page 混淆——**均排除** |
| 「Canvas」字面命中 | 多为 Cursor Page 链接（`cursor.com/canvas/...`）或 HTML canvas；**不能**当作公司 Canvas 产品仓 |

---

## 3. 技术栈推断（仅有证据才写）

| 推断 | 证据 | 置信度 |
|------|------|--------|
| 公司统一身份为 **KEMI UserCenter OAuth2/OIDC 风格授权码** | `sources/kemi-oidc/*`；发现文档 `grant_types_supported: authorization_code`；`scopes: openid profile` | 高 |
| 开发者平台为 SPA，`axios` baseURL=`/kd-api/api` | 父代理 API 拉取说明 + 文档站 `/kd/` + `kd-api` | 高（平台侧） |
| 网页模块：**服务端持有 `client_secret`**；Android：公开客户端 + PKCE（`kemi-auth` SDK） | `kemi-oidc_web.md` / `kemi-oidc_android.md` | 高 |
| 业务权限**不在** UserCenter | 概览原文：「KEMI 账号只负责登录身份，不负责你的网站 / 应用内的访问权限」 | 高 |
| 本地用户建议字段：`uc_user_id` ↔ `userinfo.sub`，另存 `role/status` | 概览「本地用户表示例」 | 高（推荐模式） |
| erp-pro 与行政采购 **同账号生态、不同应用会话** | erp-pro SSO 记忆；OIDC 多应用；ErpAuditKit `pcba_session` 禁混星空 | 中高 |
| KEMI One / Canvas **前端框架、工作流引擎、ORM、部署形态** | **无源码 / 无内部 Wiki 命中** | **未知 — 勿臆造** |

**禁止写入本调研的臆测：** Nest/Next/React Flow、自研 BPM 名称、库表前缀等（当前无证据）。

---

## 4. 身份 / 登录 / 权限（OIDC 专章）

### 4.1 权威来源

| 文档 | 本地镜像 | 线上 |
|------|----------|------|
| 概览 | `sources/kemi-oidc/kemi-oidc.md` | https://kemi.newlinksz.com/kd/docs/kemi-oidc |
| 网页接入 | `sources/kemi-oidc/kemi-oidc_web.md` | …/kemi-oidc/web |
| Android | `sources/kemi-oidc/kemi-oidc_android.md` | …/kemi-oidc/android |
| 通用应用 HTTP API | `sources/kemi-oidc/kemi-oidc_app-api.md` | …/kemi-oidc/app-api |
| 发现文档 | （本轮 curl） | https://kemi.newlinksz.com/usercenter/.well-known/openid-configuration |

拉取方式备注：浏览器直开文档页曾空结果；**改走** `GET https://kemi.newlinksz.com/kd-api/api/public/docs/...` 得正文。文档站本身**无需登录**可读公开 docs API。

### 4.2 正式环境地址

| 服务 | 地址 | 用途 |
|------|------|------|
| UserCenter API | `https://kemi.newlinksz.com/usercenter` | 授权 / 换票 / userinfo / SSO ticket |
| UserCenter Web | `https://kemi.newlinksz.com/uc` | 用户登录与选账号 |
| 开发者平台 | `https://kemi.newlinksz.com/kd` | 创建 Web 应用、读文档 |
| 开发者平台 API | `https://kemi.newlinksz.com/kd-api` | 控制台 / 公开文档 API |

局域网联调地址（文档记载，**非本包验收依赖**）：`172.21.16.10:8401/8402/8411/8412`。

### 4.3 发现文档要点（已核）

- `issuer`: `https://kemi.newlinksz.com/usercenter`
- `authorization_endpoint` / `token_endpoint` / `userinfo_endpoint` / `jwks_uri`
- 另有 `sso_ticket_endpoint`、`sso_exchange_endpoint`（站间免登；网页文档约定路径含 `/kemi/sso`）
- `response_types_supported`: `code`；`grant_types_supported`: `authorization_code`
- `scopes_supported`: `openid`, `profile`
- `claims_supported`: `sub`, `username`, `preferred_username`, `name`, `nickname`, `email`, `picture`, …
- **不提供**（网页文档明示）：`id_token`、`refresh_token`；过期后重新授权
- Token 端认证：`client_secret_post` / `client_secret_basic` / `none`

### 4.4 选型 A：行政采购应怎么接登录

| 决策 | 说明 |
|------|------|
| **采用「网页接入」** | 浏览器模块；**服务端**持有 `client_secret`；授权码换 `access_token` |
| **不另建账号体系** | 不以本地密码表为主身份；用户主键关联 `sub` / `uc_user_id` |
| **不做**通用应用「密码直登」为主路径 | `app-api` 的 `/api/auth/login` 适合自建 UI 客户端；Web 嵌入走授权码更符合文档分工 |
| Android SDK | 本期行政采购 Spec **非**移动端优先；可留二期 |

网页主路径（摘自 web 文档，细节以 sources 为准）：

1. 开发者平台创建 **Web 应用**，登记 `redirect_uri`，保存 `client_id` / `client_secret`（secret 仅服务端 / Vault）
2. 前端生成 `state` → 跳转 `{UC_API}/oauth/authorize?...&scope=openid%20profile`
3. 回调收 `code` → 服务端 `POST /oauth/token`（含 secret）
4. 用返回的 `user.sub` upsert 本地用户 → **建立业务会话**
5. 需要时 `GET /oauth/userinfo` Bearer 校验

### 4.5 身份 vs 权限 / SoD（硬边界）

```
KEMI OIDC  ──►  你是谁（sub）
行政采购应用 ──►  你能做什么（角色泳道 + S1–S5 + 审批矩阵配置）
```

| 层 | 谁负责 | 行政采购落点 |
|----|--------|--------------|
| 身份 | UserCenter | `uc_user_id` = `sub`；会话绑定 KEMI 登录 |
| 产品准入 | 应用自己 | 「未授权账号不可用本模块」——白名单/组织映射待持仓人定 |
| 角色 | 应用自己 | 申请人 / 部门负责人 / 行政 / 财务 / 总经理 / 出纳（docs/01） |
| SoD | 应用自己 | S1 下单≠验收；S2 记账≠付款；S3 申请≠部门审；S5 预付三角等（docs/05） |
| 金额阈值 | 配置 | 占位符注入，不写死（docs/00a） |

**缺口（权限）：** 尚未见到 KEMI One 现成 RBAC/组织同步 API 或 Canvas 角色模型文档 → 阶段 1 须确认：角色是挂在 One 平台统一权限，还是行政采购模块私有表。

---

## 5. 工作流 / 单据能力：已有 vs 缺口

| 能力 | 状态 | 备注 |
|------|------|------|
| 流程 Spec（步骤编号、状态草案） | **有** | docs/02–06、SPEC.md |
| SoD / 矩阵骨架 | **有**（阈值占位） | docs/05 |
| Canvas / One **内置工作流引擎**（节点、加签、驳回、待办） | **未知** | 无仓无可读实现 |
| 单据页脚手架、附件、审计日志中间件 | **未知** | 同上 |
| 与 erp-pro 入库 API 契约 | **部分**（旁系） | ErpAuditKit / MaterialCodeNaming；行政入库接口**未**在本轮定稿 |
| 金蝶回写 | **本期不做（C 未选）** | docs/07 |

---

## 6. 阶段 1 嵌入：建议接入点与风险

### 6.1 建议接入点（在拿到 One/Canvas 仓之后）

1. **身份门禁**：行政采购所有页面经业务会话；登录仅 OIDC 网页接入。  
2. **用户映射表**：`uc_user_id` / `sub` + 站内角色 + 公司维度（SZ/HK）。  
3. **单据与状态机**：按 docs/06 在 Canvas/One 内建 PR/PO/GRN/INV/PAY（MVP 货到付款）。  
4. **审批动作**：优先复用平台已有「待办/通过/驳回」；若无，再最小自研状态机——**开工前二选一确认**。  
5. **SoD 校验**：写在服务端状态迁移，不信任前端隐藏按钮。  
6. **erp-pro（D）**：仅收货需料号/入库时调用；**独立会话**，禁止与生产料号审核 cookie 混用。

### 6.2 阶段 1 接入清单（可勾选）

- [ ] 向持仓人索取 **KEMI One / Canvas 代码仓地址与权限**（本轮本地/Origin/公开 GitHub 均未命中；阶段 1 不因此停工）
- [ ] 确认 Canvas 是否已有**审批流 / 待办 / 加签**可复用。在确认前，本仓使用模块内状态机，不调用宿主引擎
- [ ] 在 https://kemi.newlinksz.com/kd 为行政采购登记 **Web 应用**（`redirect_uri`、环境变量名约定；secret 进环境变量，**不进仓库**）
- [x] 本仓实现 OIDC 网页回调 + 本地 `uc_user_id` upsert + 业务 session（`app/`）
- [x] 应用内角色表与 S1/S2/S3 服务端校验（对齐 docs/05）
- [x] MVP 单据 API/页：请购→…→付款（无预付）；分类校验挡生产物料
- [x] 行政入库 → erp-pro stub；断言拒绝生产会话字段与 cookie
- [x] 阈值配置表 backlog（财务填数）——与代码解耦，默认 null

### 6.3 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| One/Canvas 仓长期不可见 | 无法估工作量、可能选错嵌入层 | 阻塞项升级：持仓人给仓或改授权范围 |
| 误以为 OIDC 已含审批权限 | SoD 空洞 | 文档已写清；代码评审卡「角色表」 |
| 与 erp-pro / 星空会话混用 | 错审生产料号 | 硬隔离 cookie / 技能边界（erp-pro-audit） |
| 把 Cursor Canvas / LMS Canvas 当产品 | 文档与对接跑偏 | 本调研已排除 |
| 过早改宿主仓 | 宿主仓仍未取得 | 开工授权已给；只在本仓加可嵌入模块，不改宿主 |

---

## 7. 检索方法备忘（可复现）

- Windows `bc5084a6-…`：Documents / Desktop / D:\\Share 名称与内容浅扫；Chrome 书签；Spec 包内检索  
- Mac `bbcf3413-…`：Documents / mdfind / Share 挂载名  
- box：`/workspace` ripgrep  
- Origin：已连接，`list_namespaces` 空  
- GitHub MCP：未授权  
- 公开：WebSearch；OIDC 用 `kd-api` + discovery curl  
- **未做：** 登录内网系统扒源码、读取凭据、修改任何业务仓

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-11-06 | 初稿：本地/旁系检索 + OIDC sources 并入；选型 A 身份策略定稿建议 |
| 2026-11-06 | 开工后补记：阶段 1 脚手架落在本仓 `app/`，不把调研中的「未知宿主能力」写成已接入 |
