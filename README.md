# 衣序：天气与自然语言驱动的衣橱推荐原型

将“18度通勤，不穿裙子，保留白衬衫”转为可修改的条件，从已有衣橱检索单品并生成搭配。规则检查显式约束，大模型用于需求理解与候选重排；天气提供可追溯的预报依据。

**[在线 Demo](https://yixu-wardrobe-azure.vercel.app) · [源码仓库](https://github.com/leschanceux910415/yixu-wardrobe) · [产品与评测案例页](https://yixu-wardrobe-azure.vercel.app/case-study.html)**

当前版本 **0.2.1** 已上线，完成真实天气和公网AI链路验收。示例衣橱与开发题均为人工构造；真实用户研究、独立保留测试和天气推荐质量评测尚未完成。

## 产品与技术取舍

- 支持自然语言与表单输入、条件纠正、单品锁定/排除、多轮修改、无解诊断，以及分别保存想穿计划和自报已穿记录。
- 先枚举并校验可行组合，再排序展示；模型不能编造衣物ID或放宽禁穿条件。厚薄、正式度与配色是演示软偏好，未知防水、材质等属性会明确提示。
- 支持固定15城、今天/明天及预设时段。首页天气＋规则推荐不调用模型；主动点击天气AI最多做一次候选重排，异常时明确回退规则。
- 使用原生前端、Node.js与Vercel函数，零运行时第三方依赖。衣物编辑和穿着记录保存在当前浏览器，当前不支持图像识别或账号同步。

```text
自然语言 / 已确认条件 / 真实天气
  → 规则解析、检索与组合校验
  → 规则排序，或模型候选重排
  → 输出复核、真实执行模式与降级说明
```

`lib/core.js`处理规则与约束，`lib/weather.js`获取天气，`lib/service.js`编排流程，`lib/llm.js`适配模型。页面示例衣橱为24件人工构造衣物，评测另用12件独立构造的示例衣物。

## 本地运行

使用 **Node.js 24.x**，在仓库根目录执行，无需安装运行时依赖：

```sh
node server.js
```

打开 <http://127.0.0.1:5173>，案例页为 `/case-study.html`。**规则模式无需模型密钥**；天气查询需要联网。

如需使用模型，先复制配置示例：

```sh
cp .env.example .env
```

Windows PowerShell也可执行 `Copy-Item .env.example .env`。在本机私有 `.env` 中填写 `MODEL_API_KEY`、`MODEL_BASE_URL`、`TEXT_MODEL` 后重启服务。密钥只由服务端读取；配置项见 [.env.example](.env.example) 与[部署指南](docs/deployment-guide.md)。

## 评测结果与边界

2026年11月8日已有记录：

| 验证 | 结果 | 解释范围 |
|---|---:|---|
| 工程自动化测试 | 105/105 | 含天气工具、服务、前端与HTTP边界，部分使用mock |
| 规则开发回归 | 37/37 | 人工构造、已参与开发的题 |
| 真实混合策略首轮 | 34/37 | 37题实际模型执行，0降级、0执行错误 |
| 已知失败D25、D27、D28修复后定向复验 | 3/3 | 仅3道已知失败题，未做修复后完整混合复测 |
| 新增天气任务规格 | 12条，`draft_not_run` | 尚未通过任务运行器执行，不填写通过率 |

首轮失败来自缺件诊断与不必要澄清；修复时将确定性可行性判断与模型建议分开。独立评测器不复用产品的 `checkOutfit` 作真值，固定分母包含失败。首轮混合策略本机HTTP端到端耗时中位数2880.93ms、P95为3479.14ms，不能解释为线上性能承诺。这些记录尚不支持模型优于规则、审美胜率或用户收益结论。

公开仓库包含人工题库、独立评测器、运行器及分批汇总：[规则报告](eval/results/rule-report.md)、[混合首轮报告](eval/results/hybrid-report.md)、[3题定向复验](eval/results/clarification-fix/hybrid-report.md)、[天气发布前规则回归](eval/results/weather-release-rule/rule-report.md)。历史逐题响应、原始请求日志和验收截图在本地留存，不随仓库公开。

```sh
node --test tests/*.test.js
node eval/run.js --version rule
# 另一个终端启动服务并配置模型后，可运行：
node eval/run.js --version hybrid --base-url http://127.0.0.1:5173 --out-dir eval/results/local-hybrid
```

运行器会在本机生成逐题记录和汇总，同名输出会更新；模型评测使用实际服务额度。`direct`保留对照入口，但尚未完成完整真实评测。

## 部署与成本

可从GitHub导入Vercel，使用仓库现有配置：Framework Preset为 **Other**，Node为 **24.x**，构建命令为 `node scripts/prepare-public.js`，静态输出目录为 `public`。API、模型密钥和共享额度配置在服务端，详见[部署指南](docs/deployment-guide.md)。

成本路径：首页规则推荐0模型调用；天气AI最多一次重排；高级`hybrid`在理解与重排均执行时通常两次调用。天气使用Open-Meteo非商业免费接口，小时预报有30分钟单实例内存缓存；公共天气GET响应允许最多5分钟CDN缓存。当前Demo设置每日100次模型调用额度，公开部署需共享额度服务，额度不足时回退规则。调用尝试数不等于计费次数，未配置真实单价时不估算费用。现有平台地址即可访问，无需另租服务器或购买域名。

进一步阅读：[PRD](docs/PRD.md)、[评测方法](docs/evaluation-method.md)、[失败与迭代](docs/iteration-log.md)、[天气实施记录](docs/weather-ai-delivery.md)、[用户研究计划](docs/research-plan.md)、[开源方案调研](docs/github-ai-upgrade-research.md)。
