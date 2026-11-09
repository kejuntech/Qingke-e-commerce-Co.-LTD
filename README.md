# Qingke 工业仪器仪表网站｜新站部署包

这是一个**独立的新网站项目**，以原有仪器仪表网站的产品展示与询价功能为基础，已经设置为：

- 商标：Qingke
- 公司：Qingke e-commerce Co., LTD
- WhatsApp：+86 13696651208
- 邮箱：719166379@qq.com

本项目包不会修改旧网站。建议放入新的 GitHub 仓库，并在 Render 新建一个 Web Service。

## Windows 部署步骤

1. 先下载并解压这个 ZIP。打开解压后的文件夹，确认能看到 `package.json`、`server.js`、`index.html`、`products.html`、`assets` 和 `data-seed`。
2. 登录 GitHub，选择 **New repository**，新建仓库，例如 `qingke-instruments-site`。不要选旧的 `kejun-v18` 仓库。
3. 将解压目录里的文件和文件夹上传到新仓库根目录（上传里面的文件，不要只上传 ZIP 文件本身）。提交并推送到 `main` 分支。
4. 登录 Render，点 **New + → Web Service**，选择刚新建的 `qingke-instruments-site` 仓库。Service Name 可填 `qingke-instruments-site`。
5. 设置：**Build Command** 填 `npm install`；**Start Command** 填 `npm start`；**Health Check Path** 填 `/healthz`。保存后等待状态显示 **Live**。
6. 先使用 Render 分配的新 `onrender.com` 地址打开网站，确认首页、产品页和联系页能正常访问。

## 新站配置提醒

- 新站首次启动时会从 `data-seed` 建立独立的初始产品与联系方式；旧网站的客户、询盘、订单、管理员登录资料和运行数据没有放进这个 ZIP。
- 银行账户与 PayPal 收款信息已留空。正式收款前，应在新站管理后台或 Render 环境中填入并核对你自己的收款配置。
- 邮件通知、数据库、自动翻译和在线支付需要各自的服务凭据；本 ZIP 不含任何密钥。部署后可根据需要在 Render 的 Environment 中配置 `.env.example` 列出的变量。
- 网站将询盘和设置写入 `data` 目录。若 Render 服务没有持久化磁盘或数据库，重启/重新部署后本地文件数据可能无法保留；正式收集客户询盘前，先为新服务配置持久化存储。
- 如果以后要把自有域名切换到新站，需要先在旧 Render 服务中解除该域名，再添加到新服务。此 ZIP 不会更改现有域名或旧站配置。

## 项目启动

Node.js 18 或更高版本，运行：

```bash
npm install
npm start
```

默认本地地址为 `http://localhost:3000`。
