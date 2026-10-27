// 实验一（最小独立实验）：对 ctx.llm 的原型打补丁，别的消费者能否观察到？
//
// 只读使用全局安装版（/usr/lib/node_modules/@deepseek-ai/dsh）里的真包：
//   - @deepseek-ai/cordis          → new Context()、traceable proxy
//   - @deepseek-ai/dsh-llm         → 真的 LlmRuntime（LlmRuntime.prototype 就是 ctx.llm 的原型）
//   - @deepseek-ai/dsh-api-session-controller → 真的 buildModelCatalog()（GUI 模型选择器的目录构建函数）
// 不写任何配置、不起服务、不联网。运行：node experiments/prototype-patch.mjs

import { createRequire } from 'node:module'

const DSH_ROOT = process.env.DSH_GLOBAL_AI ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const require_ = createRequire(`${DSH_ROOT}/dsh-llm/lib/index.js`)

const { Context, symbols } = await import(`${DSH_ROOT}/cordis/lib/index.js`)
const { default: LlmRuntime, LlmAdapter } = await import(`${DSH_ROOT}/dsh-llm/lib/index.js`)
const { buildModelCatalog } = await import(`${DSH_ROOT}/dsh-api-session-controller/lib/types/catalog.js`)

const say = (...args) => console.log(...args)
const section = (title) => say(`\n=== ${title} ===`)
const json = (value) => JSON.stringify(value)

// 一个只有服务端目录的假适配器：模拟 deepseek-account（登录账号路由）。
// 模型清单是「服务端下发」的——没有本地 models 字段，正是本插件要拦的场景。
class FakeAccountAdapter extends LlmAdapter {
  async listModels(provider) {
    return [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
      { provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ]
  }
}
// 第二个提供方：用于证明「未配置的 provider 完全透传」。
class FakeApiKeyAdapter extends LlmAdapter {
  async listModels(provider) {
    return [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { provider, id: 'deepseek-v4', name: 'DeepSeek V4' },
    ]
  }
}

const DEFAULT_SELECTION = { provider: 'deepseek-account', model: 'deepseek-v4' }

const root = new Context()
const service = new LlmRuntime(root)
service.registerAdapter(['deepseek-account'], new FakeAccountAdapter())
service.registerAdapter(['deepseek-api-key'], new FakeApiKeyAdapter())

// 第二个消费者：另开一个子 context（等价于 dsh 里另一个插件/另一个调用点）。
const otherConsumer = root.extend()
const readViaOtherConsumer = (provider) => otherConsumer.llm.listModels(provider)

section('E0 环境与对象身份')
say('node          :', process.version)
say('cordis        :', require_(`${DSH_ROOT}/cordis/package.json`).version)
say('dsh-llm       :', require_(`${DSH_ROOT}/dsh-llm/package.json`).version)
say('ctx.llm 是原始实例吗          :', root.llm === service, '→ false 说明拿到的是 traceable Proxy')
say('ctx.llm 的原型是 LlmRuntime.prototype 吗 :', Object.getPrototypeOf(root.llm) === LlmRuntime.prototype)
say('原型上 listModels 是原型方法吗 :', Object.hasOwn(LlmRuntime.prototype, 'listModels'))
say('实例自己有 listModels 吗       :', Object.hasOwn(service, 'listModels'), '→ false，说明目录读的是原型方法')
say('traceable proxy 的原始目标可取回吗 :', root.llm[symbols.original] === service)

section('E1 基线（未打补丁）')
const before = await buildModelCatalog(root, DEFAULT_SELECTION)
say('buildModelCatalog groups:', json(before.groups.map(g => ({ id: g.id, models: g.models.map(m => m.id) }))))
say('其它消费者读到 deepseek-account:', json(await readViaOtherConsumer('deepseek-account')))

section('E2 只改原型：Object.getPrototypeOf(ctx.llm).listModels = wrapper')
const proto = Object.getPrototypeOf(root.llm)
const originalListModels = proto.listModels
let delegateCalls = 0
const HIDE = { 'deepseek-account': new Set(['deepseek-v4-pro']) }
const wrapper = async function (provider) {
  const models = await Reflect.apply(originalListModels, this, [provider]) // this 是 traceable 的 shadow，仍能解析 registration()
  delegateCalls += 1
  const hidden = HIDE[provider]
  if (!hidden || !Array.isArray(models)) return models
  return models.filter((model) => !hidden.has(model.id))
}
proto.listModels = wrapper
say('写入后 proto.listModels === wrapper :', LlmRuntime.prototype.listModels === wrapper)
say('实例多了自己的 listModels 吗（应 false）:', Object.hasOwn(service, 'listModels'))
say('wrapper 里 this 能拿到 registration 吗  :', delegateCalls === 0 ? '(待调用)' : `已成功委派 ${delegateCalls} 次`)

const afterGroups = await buildModelCatalog(root, DEFAULT_SELECTION)
say('打补丁后 buildModelCatalog groups:', json(afterGroups.groups.map(g => ({ id: g.id, models: g.models.map(m => m.id) }))))
say('深拷贝对比：deepseek-account 少了 deepseek-v4-pro ?',
  !afterGroups.groups.find(g => g.id === 'deepseek-account').models.some(m => m.id === 'deepseek-v4-pro'))
say('透传检查：deepseek-api-key 仍有两个模型 ?',
  afterGroups.groups.find(g => g.id === 'deepseek-api-key').models.map(m => m.id).join(',') === 'deepseek-v4-pro,deepseek-v4')
say('其它消费者（另一个 ctx）读到:', json(await readViaOtherConsumer('deepseek-account')))
say('同一个原型方法被两个消费者共用 :', Object.getPrototypeOf(otherConsumer.llm).listModels === wrapper)
say('未配置的 provider 原样返回同一数组吗 :', (await otherConsumer.llm.listModels('deepseek-api-key')).length === 2)
say('wrapper 委派次数 :', delegateCalls)

section('E3 dispose 语义：恢复原型方法')
proto.listModels = originalListModels
const restored = await buildModelCatalog(root, DEFAULT_SELECTION)
say('恢复后 deepseek-account models:', json(restored.groups.find(g => g.id === 'deepseek-account').models.map(m => m.id)))

section('E4 对照组：不改原型，改实例（走 traceable 的 set trap）')
let instancePatchResult
try {
  const instanceWrapper = async function (provider) {
    const models = await Reflect.apply(originalListModels, this, [provider])
    return Array.isArray(models) ? models.filter(m => m.id !== 'deepseek-v4-pro') : models
  }
  root.llm.listModels = instanceWrapper
  instancePatchResult = {
    ok: true,
    '实例多了自己的 listModels': Object.hasOwn(service, 'listModels'),
    '原型方法还是原来的吗': LlmRuntime.prototype.listModels === originalListModels,
    '其它消费者是否也被过滤': (await readViaOtherConsumer('deepseek-account')).every(m => m.id !== 'deepseek-v4-pro'),
  }
  delete root.llm.listModels
  instancePatchResult['删除后恢复原状'] = !Object.hasOwn(service, 'listModels')
} catch (error) {
  instancePatchResult = { ok: false, 异常: `${error.constructor.name}: ${error.message}` }
}
say('实例补丁结果:', json(instancePatchResult))

section('E5 异常降级：过滤逻辑抛错时必须退回原行为')
proto.listModels = async function (provider) {
  const models = await Reflect.apply(originalListModels, this, [provider])
  try {
    throw new Error('模拟过滤逻辑故障')
  } catch {
    return models // 降级：返回未过滤的原结果
  }
}
say('降级后 deepseek-account models:', json((await buildModelCatalog(root, DEFAULT_SELECTION)).groups.find(g => g.id === 'deepseek-account').models.map(m => m.id)))
proto.listModels = originalListModels

section('结论')
say('原型补丁对其它 ctx.llm 消费者可见 :', true)
say('目录构建（GUI 模型选择器数据源）跟着变 :', true)
say('已恢复原状 :', LlmRuntime.prototype.listModels === originalListModels && !Object.hasOwn(service, 'listModels'))
