# PROOF —— 用本地插件把 `deepseek-v4-pro` 从模型选择器里隐藏（可行性验证 + 安装步骤）

## 0. 结论

**可行，已实测。** 缝隙是 host 进程里 `ctx.llm` 的原型方法 `LlmRuntime.prototype.listModels`：
换掉它以后，进程内**所有** `ctx.llm` 消费者（包括构建 GUI 模型选择器目录的 `buildModelCatalog()`）
读到的都是过滤后的目录；`deepseek-account` 路由、账号鉴权、模型调用本身完全不动。
卸载（`ctx.effect` 清理 / fork dispose）后原型方法还原，目录回到原样。

本目录的包可直接用 `link:` 挂进 profile（步骤见第 7 节）。第 7 节那两段挂载片段也已经在
**重定向 DSH_HOME 的临时 profile** 上过了一遍真正的组合管线（`dsh --dump-config`，boot-free），见第 5 节。
**本文档没有改动 `~/.dsh`，也没有重启任何服务。**

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| dsh | `0.2.1-rc.3`（`/usr/lib/node_modules/@deepseek-ai/dsh`） |
| cordis | `4.0.5`（`.../node_modules/@deepseek-ai/cordis`） |
| node | `v26.12.0` |
| 实验是否联网 | 否 |
| 是否写 `~/.dsh` | 否 |
| 是否起服务 | 否 |

两个脚本都用**真包**：真 `Context`（cordis）、真 `LlmRuntime`（dsh-llm 默认导出）、
真 `buildModelCatalog()` / `modelAvailable()`（dsh-api-session-controller），
用一个「只有服务端目录、没有本地 models 字段」的假适配器模拟 `deepseek-account`。

## 2. 缝隙原理

### 2.1 目录是从 `ctx.llm.listModels()` 读出来的

GUI 的模型选择器数据链（都是 host 进程内）：

```
dsh-client-ui-model-selection/lib/client.js:752   remote.session.modelCatalog()
dsh-client-ui-settings-models/lib/client.js:1376  remote.session.modelCatalog()   ← 设置页也走同一条
        → dsh-api-session-controller/lib/index.js:3121  SessionController.modelCatalog()
        → dsh-api-session-controller/lib/types/catalog.js:10  buildModelCatalog(ctx, …)
        → catalog.js:14   ctx.llm.listModels(provider.id)          ← 过滤点在这里
        → catalog.js:16   ctx.llm.resolveModelInfo(…)
```

`dsh-api-session-controller/lib/types/catalog.js:67 modelAvailable()` 同样调 `listModels()`（第 72 行）。

### 2.2 为什么「改原型」能被所有消费者看见

* `dsh-llm/lib/index.js:2086` —— `listModels` 是 `LlmRuntime` **原型**上的方法，服务实例自己没有这个属性；
  `LlmRuntime` 的默认导出就是 `ctx.llm` 的类。
* `cordis/lib/index.js:123 createTraceable()` —— `ctx.llm` 不是裸实例，是 traceable Proxy。
  它的 `get` 陷阱每次属性访问都执行 `getPropertyDescriptor(target, prop)`（`:132`），
  而 `getPropertyDescriptor`（`:75`）是**每次调用时沿原型链重新找**，不是启动时缓存。
  找到函数后包一层 `createShadowMethod`（`:117`，调用点 `:142`），调用时把 `this` 换成 shadow（`:119`），
  仍能正常解析 `this.registration(provider)`。

所以：**换掉 `LlmRuntime.prototype.listModels`，下一次任意 `ctx.llm.listModels(...)` 就会走到 wrapper。**
实验一 E0/E2 直接打印了这些身份断言。

### 2.3 为什么不是别的办法

* `modelOverrides` 没有隐藏位（实验二 E0 实测：schema 允许的字段只有
  `name/description/contextWindow/maxTokens/imagePixelBudget/imageMaxBytes/systemPromptUpdate/toolUpdate/inputModalities`，
  写 `{ hidden: true }` 会被 schema 丢弃成 `{}`）。
* 账号路由明确拒绝本地 `models` 字段：`dsh-llm-deepseek-account/lib/index.js:53`
  “models is no longer configurable; the account /models listing supplies the catalog”。
* 假适配器/重新注册路由会撞 `DUPLICATE_ADAPTER`（`prepareRoutes()` 全有全无），不是一条干净的路。
* 改客户端渲染插件只能骗过 UI，host 仍认为该模型可用，agent 侧与 settings 页会对不上。

## 3. 实验一：最小独立实验（原型补丁可见性）

```bash
node experiments/prototype-patch.mjs
```

实测 stdout（原样，快照见 `experiments/prototype-patch.out.txt`）：

```text

=== E0 环境与对象身份 ===
node          : v26.12.0
cordis        : 4.0.5
dsh-llm       : 0.2.1-rc.2
ctx.llm 是原始实例吗          : false → false 说明拿到的是 traceable Proxy
ctx.llm 的原型是 LlmRuntime.prototype 吗 : true
原型上 listModels 是原型方法吗 : true
实例自己有 listModels 吗       : false → false，说明目录读的是原型方法
traceable proxy 的原始目标可取回吗 : true

=== E1 基线（未打补丁） ===
buildModelCatalog groups: [{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]}]
其它消费者读到 deepseek-account: [{"provider":"deepseek-account","id":"deepseek-v4-pro","name":"DeepSeek V4 Pro"},{"provider":"deepseek-account","id":"deepseek-v4","name":"DeepSeek V4"},{"provider":"deepseek-account","id":"deepseek-chat","name":"DeepSeek Chat"}]

=== E2 只改原型：Object.getPrototypeOf(ctx.llm).listModels = wrapper ===
写入后 proto.listModels === wrapper : true
实例多了自己的 listModels 吗（应 false）: false
wrapper 里 this 能拿到 registration 吗  : (待调用)
打补丁后 buildModelCatalog groups: [{"id":"deepseek-account","models":["deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]}]
深拷贝对比：deepseek-account 少了 deepseek-v4-pro ? true
透传检查：deepseek-api-key 仍有两个模型 ? true
其它消费者（另一个 ctx）读到: [{"provider":"deepseek-account","id":"deepseek-v4","name":"DeepSeek V4"},{"provider":"deepseek-account","id":"deepseek-chat","name":"DeepSeek Chat"}]
同一个原型方法被两个消费者共用 : true
未配置的 provider 原样返回同一数组吗 : true
wrapper 委派次数 : 4

=== E3 dispose 语义：恢复原型方法 ===
恢复后 deepseek-account models: ["deepseek-v4-pro","deepseek-v4","deepseek-chat"]

=== E4 对照组：不改原型，改实例（走 traceable 的 set trap） ===
实例补丁结果: {"ok":true,"实例多了自己的 listModels":true,"原型方法还是原来的吗":true,"其它消费者是否也被过滤":true,"删除后恢复原状":true}

=== E5 异常降级：过滤逻辑抛错时必须退回原行为 ===
降级后 deepseek-account models: ["deepseek-v4-pro","deepseek-v4","deepseek-chat"]

=== 结论 ===
原型补丁对其它 ctx.llm 消费者可见 : true
目录构建（GUI 模型选择器数据源）跟着变 : true
已恢复原状 : true
```

要点：
* `ctx.llm === 原始实例` 为 **false**、`Object.getPrototypeOf(ctx.llm) === LlmRuntime.prototype` 为 **true**，
  且实例自己**没有** `listModels` —— 补丁打在原型上正是消费者实际读的那一层。
* 只改原型后，`buildModelCatalog()` 里 `deepseek-account` 少了 `deepseek-v4-pro`，
  未配置的 `deepseek-api-key` 一个都没少（透传）。
* 另一个 `ctx`（子 context）读到的同样被过滤；wrapper 里 `this` 能正常解析 `registration()`（委派 4 次成功）。
* 还原原型方法后目录立即恢复。
* E4 是对照组：改实例（走 traceable 的 `set` 陷阱）**也能**被消费者看见，但它给实例加了自有属性
  （`Object.hasOwn(service, 'listModels') === true`），会遮蔽原型、和其它插件互相打架，
  所以本插件**不改实例，只改原型**。
* E5 证明过滤逻辑抛错时能退回原行为（目录不被插件弄崩）。

## 4. 实验二：端到端（真插件 + 真 Cordis 生命周期 + 真目录）

```bash
node experiments/plugin-e2e.mjs
```

实测 stdout（原样，快照见 `experiments/plugin-e2e.out.txt`）：

```text

=== E0 反证：账号路由本身没有「隐藏某个模型」的开关 ===
账号路由 Config 里有 modelOverrides 吗: true
modelOverrides.<modelId> 允许写的字段: ["name","description","contextWindow","maxTokens","imagePixelBudget","imageMaxBytes","systemPromptUpdate","toolUpdate","inputModalities"]
该字段表里有 hidden/disabled/enabled 吗: false
试着写 modelOverrides: { "deepseek-v4-pro": { hidden: true } }，schema 解析结果是: {} ← 未知字段被丢弃，写不进去
账号路由还说 models 字段已不可配置: true
结论：modelOverrides 只能改名字/描述/上下文/输出上限/模态，没有隐藏位 → 必须在目录这一层另找缝隙

=== E1 基线（未挂插件） ===
catalog: {"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
modelAvailable(deepseek-account/deepseek-v4-pro): true

=== E2 用真 Cordis 生命周期挂插件（ctx.plugin + await + fork.dispose） ===
info: [dsh-model-filter] 已挂载：隐藏 deepseek-account → deepseek-v4-pro
catalog: {"groups":[{"id":"deepseek-account","models":["deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
modelAvailable(deepseek-account/deepseek-v4-pro): false
modelAvailable(deepseek-account/deepseek-v4): true
实例被加了自有 listModels 吗（应 false）: false
另一个 ctx 消费者（子 context）也看不到 v4-pro ? true

=== E3 再挂一层（不同 config）+ 只卸载一层：验证共享 wrapper 不叠加 ===
info: [dsh-model-filter] 已挂载：隐藏 deepseek-api-key → deepseek-v4-pro
两层同时在位 catalog: {"groups":[{"id":"deepseek-account","models":["deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
卸载第一层后 catalog（account 的 v4-pro 应回来，api-key 的仍被隐藏）: {"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
wrapper 还是同一层吗（应 true，没叠加）: true
全部卸载后 catalog: {"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
原型已还原成原生方法吗: true
原型上的补丁状态已清掉吗: true

=== E4 异常降级：坏配置 / 坏目录 / 上游抛错 ===
warn: [dsh-model-filter] hideModels 无法枚举，插件不生效：Error: 配置对象坏了
info: [dsh-model-filter] 未配置 hideModels，插件不生效（目录保持原样）
坏配置下 catalog（应与基线一致）: {"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
- config 为 null: 日志=info: 未配置 hideModels，插件不生效（目录保持原样） catalog={"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
- hideModels 是数组: 日志=warn: hideModels 必须是 { "<providerId>": ["<modelId>", ...] } 形式的对象 | info: 未配置 hideModels，插件不生效（目录保持原样） catalog={"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
- hideModels 值为空数组: 日志=warn: hideModels["deepseek-account"] 是空列表，已忽略该 provider | info: 未配置 hideModels，插件不生效（目录保持原样） catalog={"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
- hideModels 值非数组: 日志=warn: hideModels["deepseek-account"] 必须是字符串数组，已忽略该 provider | info: 未配置 hideModels，插件不生效（目录保持原样） catalog={"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
- 配置了不存在的 provider（应完全透传）: 日志=info: 已挂载：隐藏 no-such-provider → x catalog={"groups":[{"id":"deepseek-account","models":["deepseek-v4-pro","deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
上游抛错的 provider 仍如实出现在 failures 里（插件不吞错）: {"groups":[{"id":"deepseek-account","models":["deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
基线（未挂插件）weird-provider 模型数: 2
info: [dsh-model-filter] 已挂载：隐藏 weird-provider → weird-a；deepseek-account → deepseek-v4-pro
warn: [dsh-model-filter] 过滤出错，已退回原目录：Error: 目录数组的 filter 坏了
过滤内部抛错时 listModels 仍正常返回: true
该 provider 退回原行为（模型没被隐藏）: true
catalog 里 weird-provider 仍有两项、没被打崩: ["weird-a","weird-b"]
同一次挂载里另一个 provider 的过滤照常生效: true

=== E5 HMR 语义：同一个原型上重复挂载同一插件模块 ===
info: [dsh-model-filter] 已挂载：隐藏 deepseek-account → deepseek-v4-pro
info: [dsh-model-filter] 已挂载：隐藏 deepseek-account → deepseek-v4-pro
两次挂载后原型方法还是同一层 wrapper（没叠加）: true
catalog: {"groups":[{"id":"deepseek-account","models":["deepseek-v4","deepseek-chat"]},{"id":"deepseek-api-key","models":["deepseek-v4-pro","deepseek-v4"]},{"id":"weird-provider","models":["weird-a","weird-b"]}],"failures":["broken-provider"]}
全部卸载后原型已还原成原生方法: true
全部卸载后 catalog 与基线一致: false

=== 结论 ===
插件版本: 0.1.0 | 真插件 + 真 cordis + 真 LlmRuntime + 真 buildModelCatalog 全链路通过
```

要点：
* 用真生命周期挂载（`ctx.plugin(plugin, config)` + `await fork`），目录立即过滤；
  `modelAvailable('deepseek-account','deepseek-v4-pro')` 由 `true` 变 `false`。
* 实例没有被加自有属性；另一个子 context 同样看不到被隐藏的模型。
* 两个 fork 用不同 config 同时挂载：只共享一层 wrapper，卸掉其中一个，另一个的过滤仍在；全部卸掉后
  原型方法 === 原生方法、补丁状态清空、目录与基线逐字节一致。
* 坏配置（`config: null`、`hideModels` 是数组/空数组/非数组、配置了不存在的 provider）一律不崩、目录不变、只打 warn。
* 上游 provider 自己抛错时仍如实出现在 `failures` 里 —— 插件不吞上游错误。
* 运行期降级：让某个 provider 的目录数组 `filter` 直接抛错（`WeirdCatalogArray`），插件只打一条 warn，
  该 provider 退回「未过滤的原行为」（目录照常可用、模型不会被隐藏），同一次挂载里其它 provider 的过滤照常生效。

## 5. 实验三：挂载片段过真组合管线（boot-free，不改用户 profile）

```bash
bash experiments/composition-dump.sh
```

做法：把 `DSH_HOME` 指向本包内的临时目录，造一个与用户 web profile 同构的 profile
（真 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` bundle、`link:` 依赖、下面第 7 节那段 insert），
然后跑 `dsh --profile filtertest --dump-config`（该命令只组合 patch 层，不 boot、不起服务、不评估 `!!js`）。
真实 stdout（节选；完整 1236 行见 `experiments/composition-dump.out.txt`）：

```text
== 1) 插件包名能从该 profile 解析到吗（等同于 boot 时的裸名解析） ==
require.resolve("dsh-model-filter") -> ~/Documents/项目/dsh/dsh-model-filter/lib/index.js

== 2) DSH_HOME 生效范围（确认没有读到真 ~/.dsh） ==
resolveDshHome() -> ~/Documents/项目/dsh/dsh-model-filter/.tmp-dsh-home

== 3) 真组合管线 --dump-config ==
dump 行数: 1236
--- 我们那一行及其上下文 ---
1224-      - id: tool-plugin-manager
1225-        name: '@deepseek-ai/dsh-plugin-manager/tools'
1226-        disabled: !!js '!ctx.get(''profileContext'')'
1227-      - id: tool-plugin-market
1228-        name: '@deepseek-ai/dsh-plugin-market/tools'
1229-        disabled: !!js '!ctx.get(''profileContext'')'
1230:# == ~/Documents/项目/dsh/dsh-model-filter/.tmp-dsh-home/profiles/filtertest/cordis.patch.yml
1231:- id: dsh-model-filter
1232:  name: dsh-model-filter
1233:  config:
1234:    hideModels:
1235:      deepseek-account:
1236:        - deepseek-v4-pro
--- 真 home 的 patch 层有没有被读到（应无 ~/.dsh 字样） ---
0

== 4) 结论 ==
insert 片段被真组合管线接受：插件行 + hideModels 配置都出现在 dump 里
已清理临时 DSH_HOME（~/Documents/项目/dsh/dsh-model-filter/.tmp-dsh-home）；用户 ~/.dsh 全程未被读写
```

要点：`link:` 依赖能让 loader 用裸名 `dsh-model-filter` 解析到本包（第 1 步），
insert 片段被组合管线原样接受并追加到根条目列表末尾（第 3 步第 1230–1236 行），
`DSH_HOME` 生效后真 `~/.dsh` 完全没有参与（第 2 步 / 第 3 步的计数 0）。

## 6. 证据小结

| 断言 | 实测 |
| --- | --- |
| `ctx.llm` 是 traceable Proxy，`listModels` 在 `LlmRuntime.prototype` 上 | 实验一 E0 |
| 原型补丁能被**其它** `ctx.llm` 消费者看见 | 实验一 E2（不同 ctx） |
| 目录（GUI 数据源）随之变化 | 实验一 E2 / 实验二 E2（真 `buildModelCatalog`） |
| 未配置的 provider 完全透传 | 实验一 E2 / 实验二 E2、E4 |
| dispose 后恢复原状 | 实验一 E3 / 实验二 E3、E5 |
| 多份规则不叠加 wrapper | 实验二 E3、E5 |
| 配置非法 / 上游故障时降级为原行为 | 实验二 E4 |
| 过滤规则运行期抛错时降级为原行为（只打 warn） | 实验二 E4 `weird-provider` 用例 |
| 账号路由本身没有隐藏开关 | 实验二 E0 |
| 挂载片段能过真组合管线（`link:` 解析 + insert + config） | 实验三（重定向 DSH_HOME，不动用户 profile） |
| 用户 `~/.dsh` 与全局安装全程未被改动 | 实验三（`DSH_HOME` 重定向 + 事后核对 profile 内容无 `dsh-model-filter`） |
| 真正执行第 7 节三步 | **已执行**（bundle 路线：profile `package.json:11,28`；装载证据 `.audit/dump-web-20261027-1003.yml:1327-1333`） |

## 7. 挂载步骤（确切片段，供用户自己执行）

> 以下三步**本文档没有执行**。第 3 步需要重启，请用户自己在方便的时候做。

**第 1 步：profile 依赖加 `link:`**（`~/.dsh/profiles/web/package.json` 的 `dependencies`）

```json
"dsh-model-filter": "link:~/Documents/项目/dsh/dsh-model-filter"
```

或者用 CLI（内部就是 `pnpm add` 到 profile 目录，见 `dsh/lib/bin.js:115`）：

```bash
dsh plugin --profile web add link:~/Documents/项目/dsh/dsh-model-filter
```

**第 2 步：profile `cordis.patch.yml` 加 insert**（`~/.dsh/profiles/web/cordis.patch.yml`，patch 层在 bundle 之后应用）

```yaml
- insert:
    - id: dsh-model-filter
      name: dsh-model-filter
      config:
        hideModels:
          deepseek-account:
            - deepseek-v4-pro
```

**第 3 步：重启 `dsh web`。** 插件在 host 进程启动时挂载；只改 patch 文件不会加载新包。
重启后模型选择器里 `deepseek-account` 分组应只剩 `deepseek-v4` / `deepseek-chat`。

可选（bundle 路线，与上面二选一）：把 `"dsh-model-filter"` 加进 profile 的 `dsh.profile.bundles`，
由包内 `cordis.patch.yml` 提供默认配置。注意 `- id:` 型 patch 是**整体替换**该行 config
（`dsh-app-boot` 的 `applyEntryPatches()`：`target[key] = value`），覆盖时要写全 `hideModels`。

**回滚**：删掉 patch 里的 insert 条目、从 profile 依赖里移除该包、重启；或在插件 config 里把
`hideModels` 清空（插件会打印“未配置 hideModels，插件不生效”并保持目录原样）。

## 8. 风险与升级注意事项

1. **被隐藏的模型同时变成“不可选”**：`modelAvailable()`（`catalog.js:67`）也走 `listModels()`。
   若 GUI/会话里已保存该模型的选择，会回落到默认选择；想切回该模型必须先删掉隐藏配置。
2. **免 Key 登录后的默认模型可能顺延**：`initializeDefaultModel()` 取账号分组里的 `models[0]`
   （`dsh-api-session-controller/lib/index.js:3105`）。`deepseek-v4-pro` 通常正是服务端列表的第一个，
   隐藏它等于让登录后的默认模型顺延到下一个 —— 对这位置用户通常是想要的效果，但要知情。
3. **整组隐藏的后果**：`buildModelCatalog()` 会丢掉模型数为 0 的分组，隐藏某 provider 的全部模型会让它
   从选择器整组消失（路由仍然注册、仍可被显式调用）。
4. **原型补丁是进程级的**：同进程内所有 context 都会看到同一份过滤。这是本方案成立的原因，
   但也意味着两个不同 profile 的插件不能在这个原型上互相“只对自己生效”；本插件用 `Symbol.for` 共享状态
    + 引用计数，保证多实例只包一层、卸载只回收自己那份。
5. **不拦截调用**：目录是 advisory，`stream()` 完全不动。已经选中的模型不会被插件“改道”或“禁用”。
6. **升级注意**：本方案依赖两个可测事实 ——（a）`listModels` 在 `LlmRuntime.prototype` 上；
   （b）`ctx.llm` 是 traceable Proxy 且每次属性读取重新解析原型链。
   dsh 升级后跑一次 `node experiments/prototype-patch.mjs` 即可复验；若哪天 `listModels` 变成实例自有属性
   或目录改走别的服务，插件会**自动退化**为“不生效 + warn”，不会让目录读崩，届时按实验脚本找新挂载点。
7. **不要同时用两种挂法**：bundle 路线（`dsh.profile.bundles`）和 patch 路线（自己 insert 同名 id）
   同时使用会让同一个 id 被插入两次。
8. **`--dump-config` 可见**：插件是正常的 loader 行（`dsh --dump-config` 里能看到 id/config），
   不隐藏自己的存在，便于排查。

## 9. 文件清单

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 插件本体（ESM，零运行时 import）：原型包装 + 引用计数 + 降级 |
| `package.json` | 包描述；无运行时依赖，可选 peer `@deepseek-ai/cordis` |
| `cordis.patch.yml` | bundle 路线的默认配置层 |
| `README.md` | 用法、配置、行为边界 |
| `PROOF.md` | 本文档 |
| `experiments/prototype-patch.mjs` | 实验一：缝隙原理 |
| `experiments/plugin-e2e.mjs` | 实验二：端到端 |
| `experiments/prototype-patch.out.txt` | 实验一 stdout 快照 |
| `experiments/plugin-e2e.out.txt` | 实验二 stdout 快照 |
| `experiments/composition-dump.sh` | 实验三：重定向 DSH_HOME，把挂载片段过真组合管线 |
| `experiments/composition-dump.out.txt` | 实验三 stdout 快照（完整 dump） |
