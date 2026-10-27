// dsh-model-filter —— 在保留 provider 路由的前提下，把指定模型从「模型选择器目录」里隐藏。
//
// 背景：deepseek-account（登录账号额度）路由的模型清单由服务端 /models 下发，
// 本地没有 models 字段可以删；dsh-llm-deepseek-account 的 modelOverrides 只能改
// 名字/上下文/模态等，没有 hidden/disabled 开关。于是改从目录这一层下手。
//
// 缝隙（已由 experiments/prototype-patch.mjs、experiments/plugin-e2e.mjs 实测确认）：
//   host 端 dsh-api-session-controller 的 buildModelCatalog() 对每个 provider 调
//   ctx.llm.listModels(provider.id)；而 ctx.llm 是 Cordis 的 traceable Proxy，
//   它的 get 陷阱每次调用都用 getPropertyDescriptor(target, prop) 沿原型链重新取方法，
//   所以把 LlmRuntime.prototype.listModels 换成 wrapper，进程内所有 ctx.llm 消费者
//   （catalog、modelAvailable、GUI 的 modelCatalog RPC…）读到的都是过滤后的结果。
//
// 本文件遵守两条约束：
//   1. 零运行时 import：不 import cordis/schemastery，因此用 link: 挂载时无需 pnpm install，
//      插件的依赖只有注入进来的 ctx.llm。
//   2. 只碰原型方法，不给服务实例加自有属性，也不动 ~/.dsh 与全局安装目录里的任何文件。

/** Cordis 插件名（loader 诊断与 entry id 用）。 */
export const name = 'dsh-model-filter'

/**
 * 依赖声明：llm 服务就绪后才 apply，保证 ctx.llm 一定是真的 LlmRuntime。
 * @type {string[]}
 */
export const inject = ['llm']

/**
 * 原型上的补丁状态键。用 Symbol.for 而不是模块内变量，是为了在模块被 HMR 重新
 * 加载（同一原型上换了一个新的模块实例）时仍能复用同一份状态，避免叠加两层 wrapper。
 */
const PATCH_STATE = Symbol.for('dsh-model-filter/patch-state')

/** 归一化后的配置：providerId → 要隐藏的 modelId 集合。 */
function normalizeConfig(raw, warn) {
  /** @type {Map<string, Set<string>>} */
  const hide = new Map()
  if (raw === undefined || raw === null) return hide
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('config 必须是对象，例如 { hideModels: { "deepseek-account": ["deepseek-v4-pro"] } }')
    return hide
  }
  const table = raw.hideModels
  if (table === undefined || table === null) return hide
  if (typeof table !== 'object' || Array.isArray(table)) {
    warn('hideModels 必须是 { "<providerId>": ["<modelId>", ...] } 形式的对象')
    return hide
  }
  let entries
  try {
    entries = Object.entries(table)
  } catch (error) {
    // 例如 hideModels 是一个属性访问就抛错的代理对象：整体降级为「不生效」
    warn(`hideModels 无法枚举，插件不生效：${String(error)}`)
    return hide
  }
  for (const [key, value] of entries) {
    const provider = String(key).trim()
    if (provider.length === 0) {
      warn('hideModels 里有空的 provider id，已忽略')
      continue
    }
    // 宽松一点：也接受单个字符串，等价于只有一项的数组。
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : undefined
    if (list === undefined) {
      warn(`hideModels["${provider}"] 必须是字符串数组，已忽略该 provider`)
      continue
    }
    const ids = new Set()
    for (const item of list) {
      if (typeof item !== 'string') {
        warn(`hideModels["${provider}"] 里有非字符串项，已忽略该项`)
        continue
      }
      const id = item.trim()
      if (id.length === 0) continue
      ids.add(id)
    }
    if (ids.size === 0) {
      warn(`hideModels["${provider}"] 是空列表，已忽略该 provider`)
      continue
    }
    hide.set(provider, ids)
  }
  return hide
}

/**
 * 沿原型链找到承载 listModels 的那一层。ctx.llm 是 traceable Proxy，
 * Object.getPrototypeOf() 不经过代理陷阱，直接给出真实实例的原型（实测为 LlmRuntime.prototype）。
 * @param {unknown} service - 注入得到的 ctx.llm。
 * @returns {object | undefined} 承载 listModels 的对象。
 */
function findListModelsHolder(service) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return undefined
  let holder = Object.getPrototypeOf(service)
  while (holder !== null && holder !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(holder, 'listModels')
    if (desc !== undefined && typeof desc.value === 'function') return holder
    holder = Object.getPrototypeOf(holder)
  }
  return undefined
}

/**
 * 把一份过滤规则挂到原型方法上。多份规则共享同一层 wrapper（HMR 或重复挂载也不会叠加）。
 * @param {object} holder - 承载 listModels 的原型对象。
 * @param {(provider: string, models: unknown) => unknown} filter - 单个 provider 的过滤规则。
 * @param {(error: unknown) => void} onError - 本条规则抛错时的降级回调（只用于记日志）。
 * @returns {() => void} 幂等的卸载函数；只回收自己这一份规则。
 */
function installFilter(holder, filter, onError) {
  let state = holder[PATCH_STATE]
  if (state === undefined) {
    const original = holder.listModels
    if (typeof original !== 'function') throw new TypeError('listModels 不是函数，拒绝打补丁')
    state = { original, filters: new Map(), wrapper: undefined }
    // wrapper 只做三件事：委派原方法 → 依次应用规则 → 单条规则出错就退回上一步结果。
    // 注意 this：traceable Proxy 调用时会把 this 换成一个 shadow，仍能正常解析
    // this.registration()，所以这里用 Reflect.apply 原样透传 this 即可。
    state.wrapper = async function (...args) {
      const models = await Reflect.apply(state.original, this, args)
      let result = models
      for (const rule of state.filters.values()) {
        try {
          const next = rule.filter(args[0], result)
          if (next !== undefined) result = next
        } catch (error) {
          rule.onError(error) // 降级：保持原行为，绝不让插件把目录读崩
        }
      }
      return result
    }
    Object.defineProperty(holder, PATCH_STATE, {
      value: state,
      enumerable: false,
      writable: true,
      configurable: true,
    })
    holder.listModels = state.wrapper
  }
  const token = Symbol('dsh-model-filter')
  state.filters.set(token, { filter, onError })
  return () => {
    if (!state.filters.delete(token)) return // 已经卸载过
    if (state.filters.size > 0) return // 还有别的规则在用这层 wrapper
    // 只有当原型方法仍是我们的 wrapper 时才恢复；否则说明后面又有人包了一层，
    // 这时宁可留着不还原，也不能把别人的 wrapper 覆盖掉。
    if (holder.listModels === state.wrapper) holder.listModels = state.original
    if (holder[PATCH_STATE] === state) delete holder[PATCH_STATE]
  }
}

/**
 * 生成单个 provider 的过滤规则：未配置的 provider 原样透传（连数组身份都不变）。
 * @param {Map<string, Set<string>>} hide - 归一化后的配置。
 * @returns {(provider: string, models: unknown) => unknown} 过滤规则。
 */
function makeFilter(hide) {
  return (provider, models) => {
    const hidden = hide.get(provider)
    if (hidden === undefined || hidden.size === 0) return models // 未配置：透传
    if (!Array.isArray(models)) return models // 目录不是数组（适配器异常）：透传
    let removed = 0
    const kept = models.filter((model) => {
      const id = model !== null && typeof model === 'object' ? model.id : undefined
      if (typeof id === 'string' && hidden.has(id)) {
        removed += 1
        return false
      }
      return true
    })
    if (removed === 0) return models // 没有命中：返回原数组，保持身份
    return kept
  }
}

/**
 * Cordis 插件入口。任何一步出问题都只记日志并放弃本次挂载，目录保持原样。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 已注入 llm 的上下文。
 * @param {{ hideModels?: Record<string, string[]> }} [config] - 插件配置。
 */
export function apply(ctx, config) {
  try {
    applyOrThrow(ctx, config)
  } catch (error) {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(`[dsh-model-filter] 挂载失败，模型目录保持原样：${String(error)}`)
    }
  }
}

/**
 * 真正干活的部分：归一化配置 → 找原型 → 装 wrapper。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 已注入 llm 的上下文。
 * @param {{ hideModels?: Record<string, string[]> }} [config] - 插件配置。
 */
function applyOrThrow(ctx, config) {
  const log = (level, message) => {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](`[dsh-model-filter] ${message}`)
  }
  const warn = (message) => log('warn', message)
  const hide = normalizeConfig(config, warn)
  if (hide.size === 0) {
    log('info', '未配置 hideModels，插件不生效（目录保持原样）')
    return
  }
  const holder = findListModelsHolder(ctx.llm)
  if (holder === undefined) {
    warn('在 ctx.llm 的原型链上找不到 listModels，跳过（目录保持原样）')
    return
  }
  const filter = makeFilter(hide)
  ctx.effect(function* () {
    const release = installFilter(holder, filter, (error) => warn(`过滤出错，已退回原目录：${String(error)}`))
    log('info', `已挂载：隐藏 ${[...hide.entries()].map(([p, ids]) => `${p} → ${[...ids].join(', ')}`).join('；')}`)
    yield () => {
      release()
      log('info', '已卸载，模型目录恢复原样')
    }
  }, 'dsh-model-filter')
}
