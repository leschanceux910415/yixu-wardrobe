# 衣序部署指南

当前0.2.1版本的[公开Demo](https://yixu-wardrobe-azure.vercel.app)已完成真实天气和公网AI链路验收。本指南说明如何部署自己的实例；模型调用量与费用取决于实际配置。

## 从GitHub导入Vercel

在[Vercel Dashboard](https://vercel.com/dashboard)新建项目，选择Import Git Repository并导入本仓库。项目根目录应直接包含 `package.json`、`vercel.json`、`api/`、`lib/`、`data/`、`public/` 与 `scripts/`。

使用仓库现有配置：

| 设置 | 值 |
|---|---|
| Framework Preset | **Other** |
| Node.js Version | **24.x** |
| Build Command | `node scripts/prepare-public.js` |
| Output Directory | `public` |

`vercel.json`中的 `framework:null`与Other预设保持一致，Node运行时单独选择24.x。`public/`提供前端，`api/*.js`提供函数入口，部署时保留完整项目结构。

也可在控制台提供源码上传入口时上传源码ZIP。ZIP第一层是项目根目录文件，按白名单打包源码和公开文档；环境变量在平台配置，日志、原始评测响应与个人材料在本地归档。更新实例时选择已有项目，上传入口以平台实际界面为准。

## 发布范围

`public/`是唯一静态输出目录。构建脚本按白名单复制PRD、评测方法、研究计划和两份公开报告；后端源码由函数运行时加载，私有配置通过服务端环境变量提供。

`data/wardrobe.json`提供人工构造示例衣橱，打开页面即可体验。衣物修改和穿着记录保存在当前浏览器，采用本地存储方案。

## 服务端变量与共享额度

先参考仓库根目录 `.env.example`。模型密钥及共享额度凭据在Vercel项目的Settings → Environment Variables配置，仅供服务端读取。

| 变量 | 用途 |
|---|---|
| `MODEL_API_KEY` | 模型服务商密钥；留空可体验规则模式 |
| `MODEL_BASE_URL` | 服务商的兼容API基础地址 |
| `TEXT_MODEL` | 服务商支持的模型名称 |
| `PUBLIC_DEPLOYMENT` | 公开部署设置为 `true` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 跨实例共享调用额度所需的服务端连接信息 |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel集成提供的别名，可替代上面一组 |
| `MODEL_MAX_CALLS_PER_DAY` | 每日模型调用额度，示例默认100 |
| `MODEL_MAX_TOKENS` | 当前原型默认1600，按实际模型调整 |
| `INPUT_PRICE_PER_MILLION` / `OUTPUT_PRICE_PER_MILLION` | 可选的真实服务单价；未知时只记录usage |

Vercel环境会自动启用公开部署的共享额度检查。共享额度服务缺失或不可用时，模型请求回退规则。当前Demo使用Vercel Hobby和Upstash Redis Free，设置每日100次模型调用额度；计划与服务条款以提供方当前说明为准。

首页天气与规则推荐0模型调用；主动天气AI最多一次重排；普通 `hybrid`通常包含解析与重排两次。每日额度按模型调用次数管理，完整任务的用量随路径变化。`meta.modelCalls`记录provider调用尝试；实际执行阶段与usage另行记录，费用按服务商账单核对。

保存变量后重新部署，先通过 `/api/health`检查配置，再提交一次AI需求，核对实际mode、fallback、模型阶段和usage。JSON、thinking参数与token预算按所选模型接口配置。

## 验收与域名

先验收未配置模型的规则体验：首页、示例、条件修改、锁定/排除、无解恢复、案例页以及 `/api/health`。再分别检查天气与AI入口，确认自动推荐不调用模型，主动AI实际执行，失败时显示真实回退。

使用退出平台账号后的浏览器访问生产域名，检查Deployment Protection，确认公开访问流程。桌面、手机尺寸、真实手机和移动网络的测试分别记录设备与环境。

检查静态资源白名单与服务端变量隔离，验证页面实际模式与后端一致，以及刷新后的本地记录保存正确。历史验收与失败修复见[天气实施记录](weather-ai-delivery.md)。

平台生产域名可直接作为作品链接。自定义域名为可选项：添加已拥有的域名，按平台指引配置DNS并确认HTTPS生效。当前项目无需另租服务器。若之后改用Node服务器，应使用Node 24.x、HTTPS反向代理、进程管理及共享额度配置，仍只将 `public/`作为静态目录。

公开仓库提供题库、评测器与汇总报告，历史原始响应、日志及验收截图在本地归档。重新运行时记录当前模型、参数和数据版本，生成独立的新批次。
