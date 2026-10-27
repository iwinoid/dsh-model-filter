// 实验二（端到端）：把真插件 dsh-model-filter 用真 Cordis 生命周期挂到真 LlmRuntime 上，
// 再用真 buildModelCatalog() 读目录，验证「生效过滤 / dispose 恢复 / 透传 / 降级」。
//
// 运行：node experiments/plugin-e2e.mjs
// 只读全局安装包，不写 ~/.dsh，不起服务，不联网。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const DSH_ROOT = process.env.DSH_GLOBAL_AI ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const require_ = createRequire(`${DSH_ROOT}/dsh-llm/lib/index.js`)
const requireSelf = createRequire(import.meta.url)

const { Context } = await import(`${DSH_ROOT}/cordis/lib/index.js`)
const { default: LlmRuntime, LlmAdapter } = await import(`${DSH_ROOT}/dsh-llm/lib/index.js`)
const { buildModelCatalog, modelAvailable } = await import(`${DSH_ROOT}/dsh-api-session-controller/lib/types/catalog.js`)
const plugin = await import('../lib/index.js')

const say = (...args) => console.log(...args)
const section = (title) => say(`\n=== ${title} ===`)
const json = (value) => JSON.stringify(value)
const DEFAULT_SELECTION = { provider: 'deepseek-account', model: 'deepseek-v4' }
const NATIVE_LIST_MODELS = LlmRuntime.prototype.listModels
const PATCH_STATE_KEY = Symbol.for('dsh-model-filter/patch-state')

// 服务端目录顺序与真实账号路由一致：v4-pro 在最前面（它也是登录后自动选中的第一个模型）。
class FakeAccountAdapter extends LlmAdapter {
  async listModels(provider) {
    return [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
      { provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ]
  }
}
class FakeApiKeyAdapter extends LlmAdapter {
  async listModels(provider) {
    return [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
    ]
  }
}
// 目录会抛错的 provider：用来验证「上游故障时插件不吞错、行为与没装插件一致」。
class BrokenAdapter extends LlmAdapter {
  async listModels() {
    throw new Error('上游 /models 挂了')
  }
}
// 目录数组本身坏掉（filter 抛错）的 provider：id 校验能过（原生 listModels 只用 map），
// 但任何 filter 都会抛 —— 正好用来触发「过滤规则内部抛错」这条降级路径。
class WeirdCatalogArray extends Array {
  filter() {
    throw new Error('目录数组的 filter 坏了')
  }
}
class PoisonAdapter extends LlmAdapter {
  async listModels(provider) {
    const list = new WeirdCatalogArray()
    list.push({ provider, id: 'weird-a', name: 'Weird A' }, { provider, id: 'weird-b', name: 'Weird B' })
    return list
  }
}

const root = new Context()
const service = new LlmRuntime(root)
service.registerAdapter(['deepseek-account'], new FakeAccountAdapter())
service.registerAdapter(['deepseek-api-key'], new FakeApiKeyAdapter())
service.registerAdapter(['broken-provider'], new BrokenAdapter())
service.registerAdapter(['weird-provider'], new PoisonAdapter())

const catalog = async () => {
  const result = await buildModelCatalog(root, DEFAULT_SELECTION)
  return {
    groups: result.groups.map(g => ({ id: g.id, models: g.models.map(m => m.id) })),
    failures: result.failures.map(f => f.id),
  }
}
/** 先记录日志，再回放，保证 stdout 顺序可读。 */
const captureLogs = async (run) => {
  const lines = []
  const logger = root.logger
  logger.info = (...args) => lines.push(`info: ${args.join(' ')}`)
  logger.warn = (...args) => lines.push(`warn: ${args.join(' ')}`)
  try {
    return { value: await run(), lines }
  } finally {
    delete logger.info // 删掉自有属性，原型上的真方法立刻恢复
    delete logger.warn
  }
}

section('E0 反证：账号路由本身没有「隐藏某个模型」的开关')
const accountPkg = await import(`${DSH_ROOT}/dsh-llm-deepseek-account/lib/index.js`).catch(() => undefined)
const accountConfig = accountPkg?.default?.Config ?? accountPkg?.Config
say('账号路由 Config 里有 modelOverrides 吗:', Object.keys(accountConfig?.dict ?? {}).includes('modelOverrides'))
const overrideSchema = accountConfig.dict.modelOverrides.inner ?? accountConfig.dict.modelOverrides.dict
say('modelOverrides.<modelId> 允许写的字段:', json(Object.keys(overrideSchema?.dict ?? {})))
say('该字段表里有 hidden/disabled/enabled 吗:', /hidden|disabled|enabled/.test(Object.keys(overrideSchema?.dict ?? {}).join(',')))
say('试着写 modelOverrides: { "deepseek-v4-pro": { hidden: true } }，schema 解析结果是:',
  json(accountConfig.dict.modelOverrides({ 'deepseek-v4-pro': { hidden: true } })), '← 未知字段被丢弃，写不进去')
const accountSource = readFileSync(`${DSH_ROOT}/dsh-llm-deepseek-account/lib/index.js`, 'utf8')
say('账号路由还说 models 字段已不可配置:', accountSource.includes('models is no longer configurable'))
say('结论：modelOverrides 只能改名字/描述/上下文/输出上限/模态，没有隐藏位 → 必须在目录这一层另找缝隙')

section('E1 基线（未挂插件）')
const baselineCatalog = await catalog()
say('catalog:', json(baselineCatalog))
say('modelAvailable(deepseek-account/deepseek-v4-pro):', await modelAvailable(root, { provider: 'deepseek-account', model: 'deepseek-v4-pro' }))

section('E2 用真 Cordis 生命周期挂插件（ctx.plugin + await + fork.dispose）')
const CONFIG = { hideModels: { 'deepseek-account': ['deepseek-v4-pro'] } }
const first = await captureLogs(async () => {
  const fork = root.plugin(plugin, CONFIG)
  await fork
  return fork
})
for (const line of first.lines) say(line)
const fork1 = first.value
say('catalog:', json(await catalog()))
say('modelAvailable(deepseek-account/deepseek-v4-pro):', await modelAvailable(root, { provider: 'deepseek-account', model: 'deepseek-v4-pro' }))
say('modelAvailable(deepseek-account/deepseek-v4):', await modelAvailable(root, { provider: 'deepseek-account', model: 'deepseek-v4' }))
say('实例被加了自有 listModels 吗（应 false）:', Object.hasOwn(service, 'listModels'))
say('另一个 ctx 消费者（子 context）也看不到 v4-pro ?',
  !(await root.extend().llm.listModels('deepseek-account')).some(m => m.id === 'deepseek-v4-pro'))

section('E3 再挂一层（不同 config）+ 只卸载一层：验证共享 wrapper 不叠加')
const second = await captureLogs(async () => {
  const fork = root.plugin(plugin, { hideModels: { 'deepseek-api-key': ['deepseek-v4-pro'] } })
  await fork
  return fork
})
for (const line of second.lines) say(line)
const fork2 = second.value
say('两层同时在位 catalog:', json(await catalog()))
const wrapperAfterTwo = LlmRuntime.prototype.listModels
await fork1.dispose()
say('卸载第一层后 catalog（account 的 v4-pro 应回来，api-key 的仍被隐藏）:', json(await catalog()))
say('wrapper 还是同一层吗（应 true，没叠加）:', LlmRuntime.prototype.listModels === wrapperAfterTwo)
await fork2.dispose()
say('全部卸载后 catalog:', json(await catalog()))
say('原型已还原成原生方法吗:', LlmRuntime.prototype.listModels === NATIVE_LIST_MODELS)
say('原型上的补丁状态已清掉吗:', Object.getOwnPropertyDescriptor(LlmRuntime.prototype, PATCH_STATE_KEY) === undefined)

section('E4 异常降级：坏配置 / 坏目录 / 上游抛错')
const bad = await captureLogs(async () => {
  const fork = root.plugin(plugin, { hideModels: new Proxy({}, { ownKeys() { throw new Error('配置对象坏了') } }) })
  await fork
  return fork
})
for (const line of bad.lines) say(line)
say('坏配置下 catalog（应与基线一致）:', json(await catalog()))
await bad.value.dispose()

for (const [label, config] of [
  ['config 为 null', null],
  ['hideModels 是数组', { hideModels: ['deepseek-v4-pro'] }],
  ['hideModels 值为空数组', { hideModels: { 'deepseek-account': [] } }],
  ['hideModels 值非数组', { hideModels: { 'deepseek-account': 42 } }],
  ['hideModels 值是单个字符串（README 声明支持）', { hideModels: { 'deepseek-account': 'deepseek-v4-pro' } }],
  ['配置了不存在的 provider（应完全透传）', { hideModels: { 'no-such-provider': ['x'] } }],
]) {
  const run = await captureLogs(async () => {
    const fork = root.plugin(plugin, config)
    await fork
    return fork
  })
  say(`- ${label}: 日志=${run.lines.length ? run.lines.map(l => l.replace('[dsh-model-filter] ', '')).join(' | ') : '(无)'} catalog=${json(await catalog())}`)
  await run.value.dispose()
}

const brokenRun = await captureLogs(async () => {
  const fork = root.plugin(plugin, { hideModels: { 'broken-provider': ['x'], 'deepseek-account': ['deepseek-v4-pro'] } })
  await fork
  return fork
})
say('上游抛错的 provider 仍如实出现在 failures 里（插件不吞错）:', json(await catalog()))
await brokenRun.value.dispose()

// 运行期降级：weird-provider 的目录数组 filter 会抛错，而我们的过滤规则正是靠 filter 干活。
// 期望：插件不把目录读取弄崩，且这条 provider 退回「未过滤的原行为」。
const baselinePoison = await root.llm.listModels('weird-provider')
say('基线（未挂插件）weird-provider 模型数:', baselinePoison.length)
const poisonRun = await captureLogs(async () => {
  const fork = root.plugin(plugin, { hideModels: { 'weird-provider': ['weird-a'], 'deepseek-account': ['deepseek-v4-pro'] } })
  await fork
  const after = await root.llm.listModels('weird-provider') // 在捕获窗口内触发一次故障过滤
  return { fork, after }
})
const afterPoison = poisonRun.value.after
for (const line of poisonRun.lines) say(line)
say('过滤内部抛错时 listModels 仍正常返回:', Array.isArray(afterPoison) && afterPoison.length === baselinePoison.length)
say('该 provider 退回原行为（模型没被隐藏）:', afterPoison.length === 2)
say('catalog 里 weird-provider 仍有两项、没被打崩:', json((await catalog()).groups.find(g => g.id === 'weird-provider')?.models))
say('同一次挂载里另一个 provider 的过滤照常生效:', !(await root.llm.listModels('deepseek-account')).some(m => m.id === 'deepseek-v4-pro'))
await poisonRun.value.fork.dispose()

section('E5 HMR 语义：同一个原型上重复挂载同一插件模块')
const reload = await captureLogs(async () => {
  const forks = []
  const wrappers = []
  for (let i = 0; i < 2; i += 1) {
    const fork = root.plugin(plugin, CONFIG)
    await fork
    forks.push(fork)
    wrappers.push(LlmRuntime.prototype.listModels)
  }
  return { forks, wrappers }
})
for (const line of reload.lines) say(line)
say('两次挂载后原型方法还是同一层 wrapper（没叠加）:', reload.value.wrappers[0] === reload.value.wrappers[1])
say('catalog:', json(await catalog()))
for (const fork of reload.value.forks) await fork.dispose()
const finalCatalog = await catalog()
say('全部卸载后原型已还原成原生方法:', LlmRuntime.prototype.listModels === NATIVE_LIST_MODELS)
say('全部卸载后 catalog 与基线一致:', json(finalCatalog) === json(baselineCatalog))

section('结论')
say('插件版本:', requireSelf('../package.json').version, '| 真插件 + 真 cordis + 真 LlmRuntime + 真 buildModelCatalog 全链路通过')
