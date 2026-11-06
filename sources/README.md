# sources · 源稿与外部权威镜像

| 文件 / 目录 | 说明 |
|-------------|------|
| 用户附件 PDF | 行政采购·流程讨论稿 v3 · 2026-11-02 · 6 页（泳道 SVG + 步骤对照 + SoD + 矩阵 + 开放问题）；桌面另有 `行政采购流程-讨论稿-v3.pdf` |
| `v3-开放问题摘录.md` | 开放问题摘录 |
| `kemi-oidc/` | **KEMI 账号授权登录**文档镜像（2026-11-06 自 `kd-api` 公开 docs 拉取） |
| 本包生成 / 调研日 | 2026-11-06 Asia/Shanghai |

## kemi-oidc 索引

| 本地 | 线上入口 | API slug |
|------|----------|----------|
| `kemi-oidc.md` (+ `.json`) | https://kemi.newlinksz.com/kd/docs/kemi-oidc | `kemi-oidc` |
| `kemi-oidc_web.md` | …/kemi-oidc/web | `kemi-oidc/web` |
| `kemi-oidc_android.md` | …/kemi-oidc/android | `kemi-oidc/android` |
| `kemi-oidc_app-api.md` | …/kemi-oidc/app-api | `kemi-oidc/app-api` |

API：`GET https://kemi.newlinksz.com/kd-api/api/public/docs/{slug}`  
发现文档：`GET https://kemi.newlinksz.com/usercenter/.well-known/openid-configuration`

页脚原话备忘：讨论稿 v3 · 手绘泳道 SVG · 未改 KEMI One / Canvas · 定稿后再开发。

相对 v2：补「先款后货」预付子流程。

范围备忘：深圳 CNY · 香港 HKD · 不含生产物料与委外。

**不存放：** 凭据、`client_secret`、会话、真实阈值定案（定案后写入独立 config，不进源稿冒充）。
