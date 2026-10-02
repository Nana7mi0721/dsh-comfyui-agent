/**
 * 画布工作流（UI 格式）→ API 工作流（prompt 格式）转换。
 *
 * 为什么存在：ComfyUI 前端保存的是「画布」——节点有位置、连线和 widget 值，
 * 但**不能直接提交**；服务端只吃 `{ "3": { class_type, inputs } }` 这种扁平 prompt。
 * 用户在 ComfyUI 里攒了几十个画布工作流，插件必须能把这些画布跑起来，
 * 否则 Agent 只能自己现搭节点图，等于把用户已有的资产全丢了。
 *
 * 转换里踩过的坑（都在下面的实现里）：
 *  - 坐标行链接与对象行链接（version 0.4）两种格式并存，先归一化；
 *  - `widgets_values` 与节点 widget 的对应关系必须以 object_info 的
 *    required→optional 顺序为准，且带 `control_after_generate` 的 INT widget
 *    后面多吞一个值（种子后面的 "fixed"/"randomize"）——按 inputs 数组对齐会错位；
 *  - bypass(mode 4) 的节点不在 prompt 里出现，但它的输出要「直通」到第一个有连线的输入；
 *  - Reroute / PrimitiveNode 是前端虚拟节点，没有 class_type，必须就地化掉；
 *  - 子图（definitions.subgraphs）要展开成扁平节点，`-10` 是子图输入节点、`-20` 是输出节点。
 */

/** 只有这些类型的输入会变成 widget（其余都是连线插槽）。 */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

/** 纯前端节点：不进 prompt，各自有专门的直通规则。 */
const VIRTUAL_TYPES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'PreviewAny'])

/**
 * rgthree 的导航/开关类节点。注意：这张表里有一部分在服务器上**有真实实现**
 * （`Any Switch (rgthree)`、`Context (rgthree)`、`Power Primitive (rgthree)`…，见 `object_info`），
 * 跳过它们会让下游连线的来源解析不到；只有服务器确实没有的（Fast Muter / Bypasser、Bookmark、
 * Label、Mute / Bypass Relay / Repeater）才必须跳过。
 */
const RGTHREE_UI_TYPES = /^(Fast Groups Muter|Fast Groups Bypasser|Fast Muter|Fast Bypasser|Mute \/ Bypass Relay|Mute \/ Bypass Repeater|Bookmark|Label|Context|Context Big|Power Primitive|Any Switch) \(rgthree\)$/

/** 服务器上没有、但语义是「把输入原样送到输出」的节点：解析连线时按 Reroute 直通。 */
const REROUTE_LIKE_TYPES = new Set(['Reroute', 'Mute / Bypass Relay (rgthree)', 'Mute / Bypass Repeater (rgthree)'])

/** 命名对（Set/Get）节点：前端用它做「隐形连线」，转换时要按名字重新接上。 */
const SET_NODE_TYPES = new Set(['SetNode', 'easy setNode', 'Set node'])
const GET_NODE_TYPES = new Set(['GetNode', 'easy getNode', 'Get node'])

/** 一个转换结果。 @typedef {{ prompt: Record<string, any>, warnings: string[], skipped: string[] }} ConvertResult */

/**
 * 归一化 link 行：位置行 `[id, origin, slot, target, slot, type]` 与
 * 对象行 `{id, origin_id, origin_slot, target_id, target_slot, type}` 统一成对象。
 * @param {any} row - 原始 link。
 * @returns {{ id: number, originId: string|number, originSlot: number, targetId: string|number, targetSlot: number, type?: string }|undefined} 归一化结果。
 */
function normalizeLink(row) {
  if (Array.isArray(row)) {
    return { id: row[0], originId: row[1], originSlot: row[2], targetId: row[3], targetSlot: row[4], type: row[5] }
  }
  if (row && typeof row === 'object') {
    return {
      id: row.id,
      originId: row.origin_id ?? row.originId,
      originSlot: row.origin_slot ?? row.originSlot,
      targetId: row.target_id ?? row.targetId,
      targetSlot: row.target_slot ?? row.targetSlot,
      type: row.type,
    }
  }
  return undefined
}

/**
 * object_info 里一条输入声明的形状判定。
 * @param {any} spec - `["INT", {...}]` 或 `[["a","b"], {...}]`。
 * @returns {{ typeName: string, options: any, isWidget: boolean, isCombo: boolean }} 判定结果。
 */
export function inputSpecInfo(spec) {
  const typeName = Array.isArray(spec) ? spec[0] : spec
  const options = Array.isArray(spec) && spec.length > 1 && spec[1] !== null && typeof spec[1] === 'object' ? spec[1] : {}
  const isCombo = Array.isArray(typeName)
  const isWidget = options.forceInput !== true && (isCombo || WIDGET_TYPES.has(String(typeName)))
  return { typeName: isCombo ? 'COMBO' : String(typeName), options, isWidget, isCombo }
}

/**
 * 一个节点类的 widget 顺序（含 `control_after_generate` 这种“吞值但不出现在 prompt 里”的伴生 widget）。
 *
 * 顺序规则与 ComfyUI 前端一致：required 先、optional 后，各自按对象键序。
 * @param {any} definition - object_info 里该类节点的定义。
 * @returns {Array<{ name: string, spec: any, synthetic: boolean }>} widget 序列。
 */
export function widgetOrder(definition) {
  const order = []
  for (const group of ['required', 'optional']) {
    const entries = definition?.input?.[group]
    if (!entries || typeof entries !== 'object') continue
    for (const [name, spec] of Object.entries(entries)) {
      const info = inputSpecInfo(spec)
      if (!info.isWidget) continue
      order.push({ name, spec, synthetic: false })
      if (info.options?.control_after_generate === true) order.push({ name: `${name}.control_after_generate`, spec: null, synthetic: true })
    }
  }
  return order
}

/**
 * 一个节点实际序列化出来的 widget 顺序（位置与 `node.widgets_values` 一一对应）。
 *
 * 优先用前端自己写进 `node.inputs[].widget.name` 的记录——它包含「JS 扩展注册的自定义 widget」
 * （如 LoraManager 的 `text`，object_info 里只是个不认识的类型名）。object_info 只用来补
 * `control_after_generate` 这种「占位但值不在 prompt 里」的伴生 widget。
 * @param {any} node - 画布节点。
 * @param {any} definition - object_info 里该类节点的定义（可能没有）。
 * @returns {Array<{ name: string, synthetic: boolean }>} widget 序列。
 */
export function buildWidgetOrder(node, definition) {
  const declared = definition ? widgetOrder(definition) : fallbackWidgetOrder(node)
  const annotated = (node.inputs ?? []).filter((input) => input.widget?.name !== undefined)
  if (annotated.length === 0) return declared
  const out = []
  for (const input of annotated) {
    const name = input.widget.name
    if (out.some((w) => w.name === name)) continue
    // 上传按钮（IMAGEUPLOAD / VIDEOUPLOAD / AUDIOUPLOAD）是 `serialize:false` 的 widget：
    // 它会占用 widgets_values 的一个位置，但**不进 prompt**（前端在 graphToPrompt 里跳过）
    out.push({ name, synthetic: false, noSerialize: /UPLOAD$/.test(String(input.type ?? '')) })
    const index = declared.findIndex((w) => w.name === name)
    if (index >= 0 && declared[index + 1]?.synthetic) out.push(declared[index + 1])
  }
  // 声明了但前端没写进 inputs 的（老画布 / 节点升级）补在后面：位置对齐不受影响
  for (const widget of declared) {
    if (!widget.synthetic && !out.some((w) => w.name === widget.name)) out.push(widget)
  }
  return out
}

/**
 * 「参数不在 object_info 里」的节点，按各自源码的序列化方式从 `widgets_values` 里捞参数。
 * 每条规则 `(values) => ({ inputs, consumed })`，`consumed` 是它用掉的 `widgets_values` 下标。
 * 依据（本机 `E:\ComfyUI\ComfyUI\custom_nodes\` 源码逐条核实）：
 * - `comfyui-aspect-ratio-advanced\js\aspect_ratio_advanced_v2.js:659,2199`：
 *   `entry.inputs[HIDDEN_INPUT_NAME] = JSON.stringify(readState(node))`，`HIDDEN_INPUT_NAME = "ResolutionState"`。
 * - `rgthree-comfy\web\comfyui\power_lora_loader.js:86-87,515`：widget 名 `"lora_" + this.loraWidgetsCounter`，
 *   值是 `{...this.value}`；`rgthree-comfy\py\power_lora_loader.py` 按 `key.startswith('LORA_')` 逐个读 `{on,lora,strength,strengthTwo}`。
 * - `ComfyUI-Lora-Manager\py\nodes\lora_loader.py:130` + `py\nodes\utils.py:97`：`text` 是必填 widget，
 *   LoRA 列表从 `kwargs["loras"]` 取（数组或 `{__value__:[...]}`），画布里的 `{version,textWidgetName}` 是 JS widget 状态。
 * @type {Record<string, (values: any[]) => { inputs: Record<string, any>, consumed: Set<number> }>}
 */
const DYNAMIC_WIDGET_RULES = {
  AspectRatioAdvanced: stateJsonRule('ResolutionState'),
  dehypnotic_AspectRatio: stateJsonRule('ResolutionState'),
  'Power Lora Loader (rgthree)': rgthreeLoraRule,
  'Lora Loader (LoraManager)': loraManagerRule,
  LoraLoaderLM: loraManagerRule,
  // 纯展示节点：widgets_values 里是它预览的图片列表，没有参数价值
  'Image Comparer (rgthree)': uiStateRule,
}

/**
 * 规则：把「界面状态」类 widget 值（rgthree 的表头、对比图列表…）吃掉不报警。
 * @param {any[]} values - `widgets_values`。
 * @returns {{ inputs: Record<string, any>, consumed: Set<number> }} 规则结果。
 */
function uiStateRule(values) {
  const consumed = new Set()
  values.forEach((value, index) => {
    if (Array.isArray(value)) consumed.add(index)
  })
  return { inputs: {}, consumed }
}

/**
 * 规则工厂：整个 widget 状态是一个对象，序列化成 hidden 输入的 JSON 字符串。
 * @param {string} inputName - hidden 输入名。
 * @returns {(values: any[]) => { inputs: Record<string, any>, consumed: Set<number> }} 规则。
 */
function stateJsonRule(inputName) {
  return (values) => {
    const index = values.findIndex((value) => value && typeof value === 'object' && !Array.isArray(value))
    if (index < 0) return { inputs: {}, consumed: new Set() }
    return { inputs: { [inputName]: JSON.stringify(values[index]) }, consumed: new Set([index]) }
  }
}

/**
 * rgthree Power Lora Loader：把每个 LoRA 对象按出现顺序写成 `lora_1`、`lora_2`…
 * @param {any[]} values - `widgets_values`。
 * @returns {{ inputs: Record<string, any>, consumed: Set<number> }} 规则结果。
 */
function rgthreeLoraRule(values) {
  const inputs = {}
  const consumed = new Set()
  let count = 0
  values.forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    // rgthree 的表头 widget（{type:"PowerLoraLoaderHeaderWidget"}）只是界面元素
    if (typeof value.type === 'string' && value.type.endsWith('HeaderWidget')) {
      consumed.add(index)
      return
    }
    if (typeof value.lora !== 'string' || !('strength' in value)) return
    count += 1
    inputs[`lora_${count}`] = value
    consumed.add(index)
  })
  return { inputs, consumed }
}

/**
 * ComfyUI-Lora-Manager 的 `Lora Loader (LoraManager)`：字符串项是 `text`，数组项是 `loras`。
 * @param {any[]} values - `widgets_values`。
 * @returns {{ inputs: Record<string, any>, consumed: Set<number> }} 规则结果。
 */
function loraManagerRule(values) {
  const inputs = {}
  const consumed = new Set()
  let hasText = false
  values.forEach((value, index) => {
    if (Array.isArray(value)) {
      inputs.loras = value
      consumed.add(index)
      return
    }
    if (!hasText && typeof value === 'string') {
      inputs.text = value
      hasText = true
      consumed.add(index)
      return
    }
    // `{version, textWidgetName}` 之类的前端 widget 状态：没有参数价值，吃掉别报警告
    if (value && typeof value === 'object' && ('version' in value || 'textWidgetName' in value)) consumed.add(index)
  })
  return { inputs, consumed }
}

/**
 * 一个节点类的全部输入（required + optional，保持声明顺序）。
 * @param {any} definition - object_info 定义。
 * @returns {Array<{ name: string, spec: any, info: ReturnType<typeof inputSpecInfo> }>} 输入清单。
 */
function allInputs(definition) {
  const out = []
  for (const group of ['required', 'optional']) {
    const entries = definition?.input?.[group]
    if (!entries || typeof entries !== 'object') continue
    for (const [name, spec] of Object.entries(entries)) out.push({ name, spec, info: inputSpecInfo(spec) })
  }
  return out
}

/**
 * 展开子图：把 `type` 是 `definitions.subgraphs[].id` 的节点就地替换成内部节点。
 *
 * 展开后所有节点 id 变成字符串（内部节点用 `<父id>:<内部id>`），链接全部落到
 * 真实节点上，后续转换只面对「普通节点 + 普通链接」一种形态。
 * @param {any} graph - 画布 JSON。
 * @returns {{ nodes: any[], links: any[], warnings: string[] }} 扁平化后的图。
 */
function flattenSubgraphs(graph) {
  const warnings = []
  /** @type {Map<string, any>} */
  const definitions = new Map()
  for (const sub of graph?.definitions?.subgraphs ?? []) {
    if (sub && typeof sub.id === 'string') definitions.set(sub.id, sub)
  }

  const nodes = []
  const links = []
  // 父节点输出槽 → 实际来源 [nodeId, slot]；子图展开时登记，父图连线重定向时查表。
  const outputRedirect = new Map()

  const cloneInner = (sub, parent) => {
    const idPrefix = `${parent.id}:`
    const localLinks = (sub.links ?? []).map(normalizeLink).filter(Boolean)
    const innerNodes = (sub.nodes ?? []).filter(Boolean)
    const innerById = new Map(innerNodes.map((node) => [node.id, node]))

    // 子图输入节点(-10) 的每个槽位 → 父节点对应槽位的来源
    const inputSources = (slot) => {
      const parentInput = parent.inputs?.[slot]
      if (parentInput && parentInput.link != null) {
        const link = linkIndex.get(parentInput.link)
        if (link) return resolveOutput(link.originId, link.originSlot, 0)
      }
      // 没有连线：父节点自己的 widget 值就是这个输入端的字面量
      const widgetValues = Array.isArray(parent.widgets_values) ? parent.widgets_values : []
      const literal = widgetValues[slot]
      return literal === undefined ? undefined : { literal }
    }

    for (const inner of innerNodes) {
      const id = idPrefix + inner.id
      const cloned = {
        id,
        type: inner.type,
        mode: inner.mode ?? 0,
        title: inner.title,
        inputs: (inner.inputs ?? []).map((input) => ({ ...input })),
        outputs: (inner.outputs ?? []).map((output) => ({ ...output })),
        widgets_values: inner.widgets_values,
        properties: inner.properties,
      }
      nodes.push(cloned)
    }

    for (const link of localLinks) {
      if (link.originId === sub.inputNode?.id) continue // 子图输入：稍后按槽位重定向
      if (link.targetId === sub.outputNode?.id) {
        // 子图输出：登记父节点该输出槽的来源
        outputRedirect.set(`${parent.id}#${link.targetSlot}`, { kind: 'link', originId: `${idPrefix}${link.originId}`, originSlot: link.originSlot })
        continue
      }
      const rewritten = {
        id: `${idPrefix}link${link.id}`,
        originId: `${idPrefix}${link.originId}`,
        originSlot: link.originSlot,
        targetId: `${idPrefix}${link.targetId}`,
        targetSlot: link.targetSlot,
        type: link.type,
      }
      links.push(rewritten)
      const target = innerById.get(link.targetId)
      const slot = target?.inputs?.[link.targetSlot]
      if (slot) slot.link = rewritten.id
    }

    // 内部节点吃子图输入的那一端，改成直接连到父图的外部来源
    for (const link of localLinks) {
      if (link.originId !== sub.inputNode?.id) continue
      const source = inputSources(link.originSlot)
      const targetId = `${idPrefix}${link.targetId}`
      const target = nodes.find((node) => node.id === targetId)
      const slot = target?.inputs?.[link.targetSlot]
      if (!slot) continue
      if (source?.literal !== undefined) {
        slot.link = null
        if (!Array.isArray(target.widgets_values)) target.widgets_values = []
        target.widgets_values[link.targetSlot] = source.literal
      } else if (source) {
        const rewritten = {
          id: `${idPrefix}link${link.id}`,
          originId: source.originId,
          originSlot: source.originSlot,
          targetId,
          targetSlot: link.targetSlot,
          type: link.type,
        }
        links.push(rewritten)
        slot.link = rewritten.id
      } else {
        slot.link = null
        warnings.push(`子图 ${sub.name ?? sub.id} 的输入槽 ${link.originSlot} 在父节点上没有连线，内部节点 ${target?.type} 的对应输入留空`)
      }
    }
  }

  /** 已归一化的链接索引，按 link id 查。 */
  const linkIndex = new Map()
  const originalLinks = (graph?.links ?? []).map(normalizeLink).filter(Boolean)

  /** 解析一个输出引用；子图输出槽会被重定向到内部节点。 @returns {any} */
  const resolveOutput = (nodeId, slot, depth) => {
    const redirect = outputRedirect.get(`${nodeId}#${slot}`)
    if (redirect && redirect.kind === 'link') return { originId: redirect.originId, originSlot: redirect.originSlot }
    return { originId: nodeId, originSlot: slot }
  }

  // 先登记子图（内部链接需要借用 linkIndex 解析父节点输入来源）
  for (const link of originalLinks) linkIndex.set(link.id, link)
  const graphNodes = (graph?.nodes ?? []).filter(Boolean)
  const subgraphParents = graphNodes.filter((node) => definitions.has(node.type))

  // 展开子图节点（可能嵌套：展开出来的内部节点如果又是子图，下面循环会再处理一轮）
  const queue = [...subgraphParents]
  const expandedIds = new Set()
  while (queue.length > 0) {
    const parent = queue.shift()
    if (expandedIds.has(parent.id)) continue
    expandedIds.add(parent.id)
    const definition = definitions.get(parent.type)
    cloneInner(definition, parent)
    for (const inner of definition.nodes ?? []) {
      if (definitions.has(inner.type)) {
        // 嵌套子图：内部节点 id 在克隆后是 `<parent>:<inner>`，需要以克隆体为父再展开一次
        const cloned = nodes.find((node) => node.id === `${parent.id}:${inner.id}`)
        if (cloned) queue.push(cloned)
      }
    }
  }

  // 父图节点：子图节点不直接进结果（已被展开），其余原样克隆
  for (const node of graphNodes) {
    if (definitions.has(node.type)) continue
    nodes.push({
      id: node.id,
      type: node.type,
      mode: node.mode ?? 0,
      title: node.title,
      inputs: (node.inputs ?? []).map((input) => ({ ...input })),
      outputs: (node.outputs ?? []).map((output) => ({ ...output })),
      widgets_values: node.widgets_values,
      properties: node.properties,
    })
  }

  // 父图链接：两端如果落在被展开的子图节点上，重定向到内部节点
  const subgraphIds = new Set(subgraphParents.map((node) => node.id))
  for (const link of originalLinks) {
    const fromSub = subgraphIds.has(link.originId)
    const toSub = subgraphIds.has(link.targetId)
    if (fromSub && toSub) continue
    const origin = fromSub ? outputRedirect.get(`${link.originId}#${link.originSlot}`) : { originId: link.originId, originSlot: link.originSlot }
    if (!origin) {
      warnings.push(`连线 ${link.id} 的来源在子图 ${link.originId} 的输出槽 ${link.originSlot} 上没有落点，已丢弃`)
      continue
    }
    const rewritten = {
      id: `link${link.id}`,
      originId: origin.originId,
      originSlot: origin.originSlot,
      targetId: toSub ? `${link.targetId}:__input__` : link.targetId,
      targetSlot: link.targetSlot,
      type: link.type,
    }
    if (toSub) continue // 子图输入槽由 cloneInner 的 inputSources 处理
    links.push(rewritten)
  }

  // 重写父图节点 inputs[].link 为归一化后的新 id（旧数字 id 已不存在）
  const linkIdMap = new Map()
  for (const link of links) linkIdMap.set(link.targetId + '#' + link.targetSlot, link.id)
  for (const node of nodes) {
    for (const input of node.inputs) {
      if (input.link === null || input.link === undefined) continue
      const found = links.find((link) => link.targetId === node.id && link.targetSlot === node.inputs.indexOf(input))
      input.link = found ? found.id : null
    }
  }

  return { nodes, links, warnings }
}

/**
 * 把画布工作流转成可提交的 API prompt。
 * @param {any} graph - 画布 JSON（`{nodes, links, definitions?}`）。
 * @param {{ objectInfo?: Record<string, any> }} [options] - 转换选项；不给 object_info 时会退化用节点自身 inputs 推断 widget 顺序。
 * @returns {ConvertResult} 转换结果。
 */
export function convertGraphToApi(graph, options = {}) {
  const objectInfo = options.objectInfo ?? {}
  const warnings = []
  const skipped = []
  const flat = flattenSubgraphs(graph)
  warnings.push(...flat.warnings)

  /** @type {Map<string, any>} */
  const nodes = new Map(flat.nodes.map((node) => [String(node.id), node]))
  /** @type {Map<string, any>} */
  const links = new Map(flat.links.map((link) => [link.id, link]))

  // Set/Get 命名对：Get 节点通过 widget 名字找回 Set 节点的来源
  const setNodesByName = new Map()
  for (const node of nodes.values()) {
    if (!SET_NODE_TYPES.has(node.type)) continue
    const key = nameKeyOf(node)
    if (key !== undefined) setNodesByName.set(key, node)
  }
  const getNodeSource = (node) => {
    const key = nameKeyOf(node)
    const setNode = key === undefined ? undefined : setNodesByName.get(key)
    if (!setNode) return undefined
    const input = (setNode.inputs ?? []).find((entry) => entry.link != null)
    if (!input) return undefined
    const link = links.get(input.link)
    return link ? resolveOutput(link.originId, link.originSlot, 0) : undefined
  }

  /** 取节点上某个输入名对应的连线（兼容 `widget.name` 与 `localized_name`）。 */
  const inputLinkOf = (node, name) => {
    const entry = (node.inputs ?? []).find((input) => input.name === name || input.widget?.name === name)
    if (!entry || entry.link === null || entry.link === undefined) return undefined
    return links.get(entry.link)
  }

  /**
   * 这个类名是否「不进 prompt」。画布上有一堆纯前端节点（Note、Reroute、Fast Muter…），
   * 服务器没有对应实现时必须跳过；但只要 `object_info` 里有它，就说明服务器能执行，
   * 跳过反而会让下游连线的来源消失（`Any Switch (rgthree)`、`Context (rgthree)` 就是这种）。
   * `PreviewAny` 例外：它是纯展示节点，且其必填输入没接线时会让整次提交被拒。
   * @param {string} type - 节点类名。
   * @returns {boolean} true 表示不进 prompt。
   */
  function skippedType(type) {
    if (!VIRTUAL_TYPES.has(type) && !RGTHREE_UI_TYPES.test(type)) return false
    if (type === 'PreviewAny' || REROUTE_LIKE_TYPES.has(type)) return true
    return objectInfo[type] === undefined
  }

  /**
   * 解析一个输出引用：跳过 bypass(4) 的节点、就地化 Reroute / Get 节点。
   * @param {string|number} nodeId - 来源节点 id。
   * @param {number} slot - 来源输出槽。
   * @param {number} depth - 递归深度保护。
   * @returns {any} `{ originId, originSlot }` 或 `{ literal }`。
   */
  const resolveOutput = (nodeId, slot, depth = 0) => {
    if (depth > 32) {
      warnings.push(`连线解析超过 32 层，疑似环形直通（节点 ${nodeId}）`)
      return undefined
    }
    const node = nodes.get(String(nodeId))
    if (!node) return undefined
    if (GET_NODE_TYPES.has(node.type)) return getNodeSource(node)
    if (node.type === 'PrimitiveNode') {
      const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
      return values[0] === undefined ? undefined : { literal: values[0] }
    }
    if (REROUTE_LIKE_TYPES.has(node.type) || node.mode === 4) {
      // bypass / Reroute：输出跟着第一个有连线的输入走（类型相同的优先）
      const wanted = node.outputs?.[slot]?.type
      const candidates = (node.inputs ?? []).filter((input) => input.link != null)
      const picked = candidates.find((input) => wanted === undefined || input.type === wanted) ?? candidates[0]
      if (!picked) return undefined
      const link = links.get(picked.link)
      if (!link) return undefined
      return resolveOutput(link.originId, link.originSlot, depth + 1)
    }
    // 纯前端节点（Note / 标尺 / 没有服务端实现的 rgthree 开关…）：它们不会进 prompt，取不到输出
    if (skippedType(node.type)) return undefined
    return { originId: String(nodeId), originSlot: slot }
  }

  /**
   * 节点 widget 的名字键（Set/Get 节点用它配对）。
   * @param {any} node - 节点。
   * @returns {string|undefined} 名字。
   */
  function nameKeyOf(node) {
    const inputs = node.inputs ?? []
    const widgetInput = inputs.find((input) => input.widget?.name !== undefined)
    const entry = inputs.find((input) => input.name === 'Constant' || input.name === 'name' || input.name === 'Name') ?? widgetInput
    if (!entry) return undefined
    const name = entry.name
    const order = definitionWidgetNames(node)
    const index = order.indexOf(entry.widget?.name ?? name)
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const value = index >= 0 ? values[index] : values[0]
    return value === undefined ? undefined : String(value)
  }

  /** 该节点 widget 名序列（有 object_info 用 object_info，否则退化成节点 inputs 里的 widget 名）。 */
  function definitionWidgetNames(node) {
    const def = objectInfo[node.type]
    if (def) return widgetOrder(def).filter((w) => !w.synthetic).map((w) => w.name)
    return (node.inputs ?? []).filter((input) => input.widget?.name !== undefined).map((input) => input.widget.name)
  }

  const prompt = {}
  const ordered = [...nodes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  for (const node of ordered) {
    if (node.mode === 2) {
      skipped.push(`${node.type}#${node.id}（已静音）`)
      continue
    }
    if (node.mode === 4) {
      skipped.push(`${node.type}#${node.id}（已 bypass，改为直通）`)
      continue
    }
    if (skippedType(node.type)) continue
    if (SET_NODE_TYPES.has(node.type)) continue

    const definition = objectInfo[node.type]
    if (!definition) {
      // 没有 object_info 时仍然尝试转换：widget 顺序退化用节点自身 inputs 的 widget 名
      warnings.push(`服务器上没有节点类型 ${node.type}（画布节点 ${node.id}）：可能缺少对应的自定义节点，该节点的输入按画布自身推断`)
    }

    const inputs = {}
    // 1) 连线插槽
    for (const entry of allInputs(definition ?? {})) {
      if (entry.info.isWidget) continue
      const link = inputLinkOf(node, entry.name)
      if (!link) continue
      const resolved = resolveOutput(link.originId, link.originSlot, 0)
      if (resolved?.literal !== undefined) inputs[entry.name] = resolved.literal
      else if (resolved) inputs[entry.name] = [String(resolved.originId), resolved.originSlot]
      else warnings.push(`${node.type}#${node.id} 的输入 ${entry.name} 来源无法解析，已留空`)
    }
    // 没有 object_info 时，用节点自身的 inputs 兜底（只补连线型输入）
    if (!definition) {
      for (const input of node.inputs ?? []) {
        if (input.link == null || input.widget !== undefined) continue
        const link = links.get(input.link)
        if (!link) continue
        const resolved = resolveOutput(link.originId, link.originSlot, 0)
        if (resolved?.literal !== undefined) inputs[input.name] = resolved.literal
        else if (resolved) inputs[input.name] = [String(resolved.originId), resolved.originSlot]
      }
    }

    // 2) widget 值：按前端实际序列化的 widget 顺序吃 widgets_values（位置一一对应）
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const order = buildWidgetOrder(node, definition)
    const consumed = new Set()
    order.forEach((widget, index) => {
      if (widget.synthetic) return
      if (widget.noSerialize) {
        consumed.add(index)
        return
      }
      const converted = (node.inputs ?? []).find((input) => input.widget?.name === widget.name)
      if (converted && converted.link != null) {
        consumed.add(index)
        const link = links.get(converted.link)
        if (link) {
          const resolved = resolveOutput(link.originId, link.originSlot, 0)
          if (resolved?.literal !== undefined) inputs[widget.name] = resolved.literal
          else if (resolved) inputs[widget.name] = [String(resolved.originId), resolved.originSlot]
        }
        return
      }
      const value = values[index]
      if (value === undefined) return
      consumed.add(index)
      inputs[widget.name] = value
    })

    // 3) object_info 里看不到的动态 widget：整块状态对象 / 个数不定的自定义 widget
    const rule = DYNAMIC_WIDGET_RULES[node.type]
    if (rule) {
      const dynamic = rule(values)
      for (const index of dynamic.consumed) consumed.add(index)
      Object.assign(inputs, dynamic.inputs)
    }

    // 4) 没被任何规则认领的「对象/数组」值 = 真要丢参数了：显式报警，不静默丢
    values.forEach((value, index) => {
      if (consumed.has(index) || value === null || value === undefined) return
      const empty = Array.isArray(value) ? value.length === 0 : typeof value !== 'object' || Object.keys(value).length === 0
      if (empty) return
      warnings.push(`${node.type}#${node.id} 的第 ${index + 1} 个 widget 值还原不出输入名（${JSON.stringify(value).slice(0, 120)}），已跳过`)
    })

    const nodeEntry = { class_type: node.type, inputs }
    if (typeof node.title === 'string' && node.title.length > 0) nodeEntry._meta = { title: node.title }
    prompt[String(node.id)] = nodeEntry
  }

  // 引用完整性：prompt 里出现的每个 [id, slot] 都必须指向本次提交内的节点
  for (const [id, entry] of Object.entries(prompt)) {
    for (const [name, value] of Object.entries(entry.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') continue
      if (prompt[value[0]] === undefined) {
        warnings.push(`节点 ${id} 的输入 ${name} 指向不存在的节点 ${value[0]}，已移除该引用`)
        delete entry.inputs[name]
      }
    }
  }

  // 可达性剪枝：ComfyUI 会校验 prompt 里**每一个**节点的必填输入，与输出无关的散落节点
  // （没选文件的 LoadImage、没接线的预览节点…）会让整次提交被拒。只保留能从输出节点回溯到的部分。
  const roots = Object.keys(prompt).filter((id) => objectInfo[prompt[id].class_type]?.output_node === true)
  if (roots.length === 0) {
    warnings.push('画布里没有输出节点（SaveImage / PreviewImage / 保存视频…），ComfyUI 可能会拒绝这次提交')
  } else {
    const keep = new Set()
    const stack = [...roots]
    while (stack.length > 0) {
      const id = stack.pop()
      if (keep.has(id) || prompt[id] === undefined) continue
      keep.add(id)
      for (const value of Object.values(prompt[id].inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') stack.push(value[0])
      }
    }
    const dropped = Object.keys(prompt).filter((id) => !keep.has(id))
    if (dropped.length > 0) {
      const names = dropped.map((id) => `${prompt[id].class_type}#${id}`)
      skipped.push(`与输出无关、不参与执行的节点 ${dropped.length} 个：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}`)
      for (const id of dropped) delete prompt[id]
    }
  }

  if (Object.keys(prompt).length === 0) {
    throw new Error('画布转换后没有任何可执行节点：请确认画布里有输出节点（SaveImage / PreviewImage / SaveVideo 等），且没有被全部静音')
  }
  return { prompt, warnings, skipped }
}

/**
 * 没有 object_info 时的 widget 顺序：按节点自身 inputs 里带 `widget` 注解的条目。
 * @param {any} node - 节点。
 * @returns {Array<{ name: string, synthetic: boolean }>} widget 序列。
 */
function fallbackWidgetOrder(node) {
  return (node.inputs ?? []).filter((input) => input.widget?.name !== undefined).map((input) => ({ name: input.widget.name, synthetic: false }))
}

/**
 * 画布里的输出节点（决定一次运行会产出什么文件）。
 * @param {any} graph - 画布 JSON。
 * @param {Record<string, any>} objectInfo - 节点定义。
 * @returns {string[]} 节点类名清单。
 */
export function outputNodeTypes(graph, objectInfo) {
  const types = new Set()
  for (const node of graph?.nodes ?? []) {
    if (!node || typeof node.type !== 'string') continue
    const definition = objectInfo[node.type]
    if (definition?.output_node === true) types.add(node.type)
  }
  return [...types]
}
