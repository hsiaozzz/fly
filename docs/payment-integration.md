# ARCANE 创作次数包与支付宝 Vibe Pay

本实现为 ARCANE 用户购买一次性创作次数包。现有每日免费额度优先使用；免费额度用完后，已购次数可以用于生成或修改。购买次数不改变平台的 token、全局每日调用或并发安全限额，也不是自动续费订阅。

## 收款与到账

接入支付宝 **Vibe Pay / AI 网页应用收款**，使用 `alipay.trade.page.pay`，产品码 `FAST_INSTANT_TRADE_PAY`，官方 `alipay-sdk@4.14.0` 和 RSA2。

- 订单由服务器保存套餐价格快照，以整数分存储人民币金额。浏览器只能提交套餐 ID 与幂等请求 ID。
- 登录用户从同源 `/api/payments/orders/:orderId/checkout` 打开付款页。服务端校验订单归属并生成签名表单，浏览器 POST 到官方支付宝网关。
- SDK 4.14.0 的默认 POST HTML 只转义引号。本适配器使用 SDK 本地生成的签名参数，完整 HTML 转义后构造 POST 表单，避免套餐名称中的 `&quot;` 等字面实体被浏览器改写，导致签名不一致；不会请求网关 GET。
- `/billing?orderId=...` 只定位当前登录用户的服务器订单并查询状态。回跳参数、浏览器缓存或页面文字不能赋予次数。
- 异步通知接收 `application/x-www-form-urlencoded`，限制 64 KB，完整解码一次，拒绝重复参数，调用 SDK `checkNotifySignV2` 验签，并核对 app、卖家、订单、金额和交易类型。
- `TRADE_SUCCESS` / `TRADE_FINISHED` 的付款事件才发次数。退款、分账和关单事件不能冒充付款事件。
- 订单变为已付、余额增加、购买账本写入、通知幂等记录在同一 MySQL 事务内完成。重复通知和主动查询不能重复发次数。
- 主动查询调用 `alipay.trade.query`，启用 SDK 服务端响应验签，核对订单号和金额，以及查询返回的 app / seller 字段。跨请求有界合并相同订单查询，成功结果缓存 3 秒。
- 本地时间过期不会直接把订单标记为已关闭；晚到的合法付款通知仍可入账。只有支付宝确认 `TRADE_CLOSED` 才关闭待付订单。

## 次数预占与恢复

账户、账本、生成预占记录按 **用户 + sandbox / production + appId** 隔离，沙箱次数不会进入正式余额。充值和任务都使用持久记录，不能通过前端状态修改余额。

付费生成或修改前原子预占 1 次。预占与账本写入在同一事务中完成，最后 1 次只能被一个并发任务使用。任务成功后预占转为已消费；失败、澄清或取消后归还。相同结算可以重放，已消费任务不能再退款式结算，相同任务 ID 不能再次启动。

生成最长 5 分钟，预占有效期为 15 分钟。进程中断后，后续余额查询或新预占会在事务内归还超时预占。过期任务不得再成功扣次或重复启动。没有活动业务请求时不会主动运行恢复任务。

成功结算在数据库锁等待结束及提交前检查取消信号；提交前取消会回滚扣次。数据库提交与网络交付无法原子执行：若提交后连接中断，可能已扣次而浏览器未收到结果，当前需要按持久任务/账本记录核对，后续应增加持久任务结果恢复。任务 ID 标识一次服务器执行，不提供客户端重复请求的自动结果回放。

## 配置

配置仅在服务器读取，不返回私钥、公钥或签名给产品 UI。无有效配置时，套餐建议仅为草案，不会创建订单或请求支付网关。

| 配置项 | 含义 |
| --- | --- |
| `ALIPAY_ENABLED=true` | 开放新销售。设为 false 停止创建订单和打开新付款；已购次数、验证通知及确认原订单继续工作 |
| `ALIPAY_ENV=sandbox` 或 `production` | 必须显式指定；沙箱与正式网关固定，不接受任意网关 URL |
| `ALIPAY_APP_ID` | 对应环境和应用的 appId |
| `ALIPAY_PRIVATE_KEY` | 部署系统保管的应用 RSA 私钥；本项目不代用户创建、转换或提交生产密钥 |
| `ALIPAY_PUBLIC_KEY` | 对应环境的支付宝 RSA 公钥；不是应用公钥 |
| `ALIPAY_SELLER_ID` | 收款卖家的支付宝用户号，用于通知业务校验 |
| `ALIPAY_KEY_TYPE=PKCS1` 或 `PKCS8` | 私钥格式，默认 PKCS1；应与实际密钥格式匹配 |
| `PAYMENT_PUBLIC_BASE_URL` | 当前部署的 HTTPS origin，不含凭据、路径、query 或 fragment。仅本地沙箱允许 localhost HTTP |
| `PAYMENT_PACKAGES_JSON` | 显式发布的服务器套餐列表；每项为 `{id,name,credits,amountFen,currency:"CNY"}` |
| `DATABASE_URL` | 已迁移的 MySQL 数据库，沿用现有服务器配置 |

未发布套餐或关闭新销售不会删除已有订单/额度。配置密钥、环境或 appId 缺失/切换时，当前服务不能核验原配置的交易；应保留原应用配置完成在途订单核对。财务记录不会随用户删除级联销毁。

迁移 `0006_payment_credits.sql` 只增加支付、通知、账户、账本和预占五张表；不会改变或删除既有数据表。应用的数据库就绪检查覆盖这些表。由部署负责人在目标环境正常执行迁移，本次开发没有连接业务数据库。

## 本轮范围与验证

此版本没有退款按钮、自动退款、退款冲账、交易关闭调用或订阅续费。已付订单之后的商户侧退款需要独立的退款与额度回收工作流；本实现只防止这类通知重复发次数。不要在没有相应冲账流程时自行把退费等同于额度回收。

已使用本地 mock 网关与临时测试 RSA 密钥验证配置禁用、服务端价格、订单归属、通知验签、字段篡改、退款事件过滤、签名表单的 HTML 实体往返及查询补偿。临时测试密钥未保存，也未用于外部请求。

MySQL 并发/回滚/重启恢复测试只在明确设置 `ARCANE_TEST_DATABASE_URL` 时连接一次性测试数据库；普通测试不连接部署数据库。测试覆盖通知/查询恰好一次发次数、订单幂等、最后一次的并发预占、失败/取消释放、过期恢复以及环境隔离。测试用支付宝结果均为 mock，不产生真实订单或资金。

尚需商户在对应环境完成产品开通、配置自有密钥并进行真实沙箱付款及公网通知联调，才可验证到账链路。配置存在和本地测试通过均不能证明正式收款可用。

## 官方依据（2026-10-10 查阅）

- [Vibe Pay](https://aipay.alipay.com/docs/vibe-pay.html)
- [AI 网页应用收款接入指南](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.html)
- [支付页面接口](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/alipay-trade-page-pay.html)
- [交易查询接口](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/alipay-trade-query.html)
- [异步通知与验签](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/api-list/async-notify-verify.html)
- [即刻收产品说明](https://aipay.alipay.com/docs/vibe-pay/nowpay/nowpay-intro.html)：当前要求合作平台，独立创作者接入仍在准备；本项目没有假定已取得该套件资格
- [官方 SDK 源码](https://github.com/alipay/alipay-sdk-nodejs-all)

官方 `@alipay/alipay-aipay` 安装包 1.7.3 已在隔离临时目录核对 registry 完整性并安装 stable Skill 1.7.0，仅作为契约资料研究。未运行其 CLI 登录、遥测、商户签约或沙箱创建流程，也没有创建真实支付/退款交易。
