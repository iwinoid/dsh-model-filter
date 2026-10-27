# dsh-model-filter

在**保留 provider 路由**的前提下，把指定模型从 DSH Web 的模型选择器目录里隐藏。

典型用法：dsh 0.2.1-rc.3 登录 DeepSeek 账号后可免配 API Key 走账号额度（provider id `deepseek-account`）。
该路由的模型清单由服务端 `GET /models` 下发，本地没有 `models` 字段可删，
`modelOverrides` 也只能改名/描述/上下文/输出上限/模态，**没有隐藏位**（见 [PROOF.md](./PROOF.md) 的 E0）。
本插件从「目录读取」这一层做过滤：`deepseek-account` 路由照常可用、账号额度照常走，只是
`deepseek-v4-pro` 不再出现在选择器里。

## 安装（profile 侧两处改动 + 重启）

以下片段是**说明**，本仓库不会替你写 `~/.dsh`。以 web profile 为例。

1）profile 依赖加一条 `link:`（`~/.dsh/profiles/web/package.json`）：

```json
{
  "dependencies": {
    "dsh-model-filter": "link:~/Documents/项目/dsh/dsh-model-filter"
  }
}
```

用 CLI 更省事（它会转发给 profile 目录里的 pnpm）：

```bash
dsh plugin --profile web add link:~/Documents/项目/dsh/dsh-model-filter
```

2）profile 的 `cordis.patch.yml`（patch 层，在所有 bundle 之后应用）加一条 insert：

```yaml
- insert:
    - id: dsh-model-filter
      name: dsh-model-filter
      config:
        hideModels:
          deepseek-account:
            - deepseek-v4-pro
```

3）重启 `dsh web`（本插件在 host 进程启动时挂载，热改 patch 不会加载新包）。
重启后打开 GUI，模型选择器里 `deepseek-account` 分组只剩其它模型。

> 也可以走 bundle 路线：把 `"dsh-model-filter"` 加进 profile `dsh.profile.bundles`，
> 由包内 [cordis.patch.yml](./cordis.patch.yml) 提供默认配置。两种方式**不要同时用**。
> `- id:` 型 patch 是整体替换该行 `config`，要改隐藏清单必须写全 `hideModels`。

## 配置

```yaml
config:
  hideModels:
    '<providerId>':
      - '<modelId>'
      - '<modelId>'
```

* 只影响列出的 provider：没写的 provider 完全透传（连返回的数组身份都不变）。
* 可以写多个 provider、每个 provider 多个模型。
* 也接受单个字符串（`hideModels: { deepseek-account: deepseek-v4-pro }`）。
* 空列表 / 非法值的条目会被忽略并打一条 warn，绝不因此中断目录读取。

## 行为与边界

* **只过滤目录**：`ctx.llm.listModels()` 的返回值被过滤。路由本身、请求发送、账号鉴权都不受影响；
  你在 GUI 里手动选择的其它模型、以及 agent 的模型调用都不变。
* **被隐藏的模型同时会变成「不可选」**：host 的 `modelAvailable()`（`dsh-api-session-controller/lib/types/catalog.js:67`）
  也走 `listModels()`，所以隐藏后该模型不再被视为可用，GUI 会把已保存的该模型选择回落到默认选择。
* **登录后的默认模型可能顺延**：`initializeDefaultModel()` 取账号分组里的 `models[0]`，
  若隐藏的正好是服务端列表第一个（`deepseek-v4-pro` 通常就是），免 Key 登录后的默认模型会顺延到下一个。
* **对空目录分组的影响**：`buildModelCatalog()` 会丢掉模型数为 0 的分组。若把某 provider 的模型全部隐藏，
  该 provider 在选择器里整组消失（路由仍注册着）。
* **失败即退化**：过滤逻辑抛错时返回原结果；找不到 `listModels`、配置非法时插件直接不生效，
  模型目录与没装插件时完全一致。

## 实现与卸载

* 挂载点：`Object.getPrototypeOf(ctx.llm).listModels`（实测就是 `LlmRuntime.prototype.listModels`）。
  `ctx.llm` 是 Cordis 的 traceable Proxy，它的 `get` 陷阱每次调用都沿原型链重新取方法，
  所以进程内所有 `ctx.llm` 消费者读到的都是过滤后的目录。
* 卸载：`ctx.effect` 的清理函数会把原型方法还原；多份规则共享同一层 wrapper，不会叠加。
* 已隐藏模型的调用不受影响（目录是 advisory）：插件不拦截 `stream()`，不会让已经选中的模型调不通。

## 兼容性

* 依赖 `ctx.llm.listModels` 是原型方法、且 `ctx.llm` 是 traceable Proxy —— 这两点在 cordis 4.0.5 +
  dsh 0.2.1-rc.3 上已实测（见 [PROOF.md](./PROOF.md)）。
* 本包**零运行时 import**（不 import cordis / schemastery），所以 `link:` 挂载后无需 `pnpm install`，
  也不存在依赖版本漂移。它只用注入进来的 `ctx.llm`。代价是不导出 `Config`（schemastery schema），
  配置校验改在插件内手写：非法条目只打 warn 并忽略，`dsh --dump-config` 里能看到你写的原始 config。
* dsh 升级后若 `listModels` 改成实例自有属性或改走别的服务，插件会自动退化为「不生效」并打 warn，
  不会让目录读崩；此时换挂载点即可（`experiments/prototype-patch.mjs` 可直接用来复验缝隙）。

## 开发与验证

```bash
node experiments/prototype-patch.mjs    # 缝隙原理（真 cordis + 真 LlmRuntime + 真 buildModelCatalog）
node experiments/plugin-e2e.mjs         # 端到端（真插件 + 真生命周期 + 过滤/恢复/透传/降级）
bash experiments/composition-dump.sh    # 挂载片段过真组合管线（DSH_HOME 重定向，boot-free）
```

三个脚本都只读全局安装包，不写 `~/.dsh`、不起服务、不联网
（第三个把 `DSH_HOME` 指到本包内的临时目录，跑完即清理）。输出快照见
`experiments/*.out.txt`，结论见 [PROOF.md](./PROOF.md)。
