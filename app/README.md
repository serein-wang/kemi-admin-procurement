# 行政采购 Web/API

本仓独立运行的路径①服务（货到付款 / 月结 / 预付）。页面和接口都在这里，不依赖 Canvas / KEMI One 宿主仓。`registerAdminProcurement` 留作以后嵌入。说明见 [`docs/09-开发脚手架.md`](../docs/09-开发脚手架.md)。

```bash
cp .env.example .env
npm install
npm test
npm start
```

本地页面：`http://127.0.0.1:3000/`。

OIDC 的 `client_secret` 只放在环境变量里。`ALLOW_DEV_LOGIN` 默认关闭。金额阈值留空表示未配置。本包不回写金蝶，也不调用 KEMI One / Canvas 宿主 API。
