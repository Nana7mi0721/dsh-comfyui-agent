/**
 * Agent 工具定义。
 *
 * 为什么存在：插件对模型暴露的全部能力都在这里。工具数量刻意压到 5 个——
 * 每个工具定义都会常驻进上下文，工具越多每轮越贵；能力靠参数收窄而不是靠新工具。
 * 分工：status（在不在线、路径在哪）→ nodes（服务器支持什么节点）→
 * workflows（用户存了哪些画布、能调哪些参数）→ run（跑）→ show（看/上传）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeInputImageName } from './comfy.js'
import { convertGraphToApi } from './graph.js'
import { detectModels, templateByName } from './templates.js'

/**
 * 工具返回值里的图片对象属性表（与 host 的 ImageAttachmentRef 同形状）。
 * 注意 DSH 的 value schema DSL：`required` 只能出现在「属性」上，
 * 根节点 / items / oneOf 分支都不允许 → 这里只存属性表，不写根级 required。
 */
const IMAGE_PROPERTIES = {
  attachmentId: { type: 'string', required: true },
  mediaType: { type: 'string', required: true },
  bytes: { type: 'integer', required: true },
  width: { type: 'integer', required: true },
  height: { type: 'integer', required: true },
  name: { type: 'string' },
}

/** 图片对象 schema（当数组的 items 用，因此根级不能带 required）。 */
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: IMAGE_PROPERTIES,
}

/** render 用的文本块。 */
function text(value) {
  return { type: 'text', text: value }
}

/**
 * 去掉值为 undefined 的键（递归）。
 * 为什么必须做：DSH 的 tool runtime 会拿 output.schema 校验工具返回值，
 * 而校验器要求返回值是 lossless JSON —— 任何 `{ error: undefined }` 都会被判
 * `"value" must be a lossless JSON object`。声明里可选的字段直接不出现即可。
 * @param {any} value - 工具返回值。
 * @returns {any} 只含 JSON 值的等价对象。
 */
function prune(value) {
  if (Array.isArray(value)) return value.map((entry) => prune(entry))
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = prune(entry)
    return result
  }
  return value
}

/** defineTool 的包装：注册前把 execute 的返回值过一遍 prune。 */
function defineJsonTool(options) {
  const run = options.execute
  return defineTool({
    ...options,
    async execute(args, exec) {
      return prune(await run(args, exec))
    },
  })
}

/**
 * 把 canonical value 里的图片对象还原成 host 的 attachment ref。
 * @param {any} image - 图片值。
 * @returns {any} ImageAttachmentRef。
 */
function imageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

/**
 * 图片值 + 图片块。
 * @param {any[]} images - 图片值数组。
 * @returns {any[]} ContentBlock 数组。
 */
function imageBlocks(images) {
  return (images ?? []).map((image) => ({ type: 'image', attachment: imageRef(image) }))
}

/** 把字节存进 attachment 服务，失败时返回 undefined（降级成只报路径）。 */
async function saveImageAttachment(ctx, data, name) {
  const attachments = ctx.get('attachments')
  if (!attachments || typeof attachments.saveImage !== 'function') return undefined
  const mediaType = name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png'
  try {
    const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name })
    return { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name ?? name }
  } catch (error) {
    return undefined
  }
}

/**
 * 注册全部 ComfyUI 工具。
 * @param {any} sctx - 已经 inject 到 tools 服务的 cordis 上下文。
 * @param {any} runtime - `{ client, config }`。
 * @returns {Array<() => void>} disposer 列表。
 */
export function registerComfyUITools(sctx, runtime) {
  const { client } = runtime
  const disposers = []
  const jobs = new Map()

  const register = (definition) => {
    disposers.push(sctx.tools.register(definition))
  }

  // ── comfyui_status ────────────────────────────────────────────────────────
  register(
    defineJsonTool({
      name: 'comfyui_status',
      description:
        '检查本地 ComfyUI 是否在线，并报告本机路径（ComfyUI 目录、用户保存的画布工作流目录、输出目录）、队列长度与可用模型清单。开始任何 ComfyUI 工作前先调它一次。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean', required: true },
            version: { type: 'string' },
            error: { type: 'string' },
            baseUrl: { type: 'string', required: true },
            comfyuiDir: { type: 'string', required: true },
            workflowsDir: { type: 'string', required: true },
            outputDir: { type: 'string', required: true },
            workflowCount: { type: 'integer', required: true },
            queueRunning: { type: 'integer', required: true },
            queuePending: { type: 'integer', required: true },
            models: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                checkpoints: { type: 'array', items: { type: 'string' }, required: true },
                diffusionModels: { type: 'array', items: { type: 'string' }, required: true },
                textEncoders: { type: 'array', items: { type: 'string' }, required: true },
                vaes: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
        render(args, value) {
          const lines = []
          if (value.connected) lines.push(`ComfyUI 在线：${value.baseUrl}（版本 ${value.version ?? '未知'}）`)
          else lines.push(`ComfyUI 离线：${value.baseUrl}${value.error ? `（${value.error}）` : ''}`, '请确认绘世启动器已启动 ComfyUI，或改插件配置里的 baseUrl。')
          lines.push(`队列：运行 ${value.queueRunning} / 等待 ${value.queuePending}`)
          lines.push(`ComfyUI 目录：${value.comfyuiDir}`)
          lines.push(`画布工作流目录：${value.workflowsDir}（${value.workflowCount} 个）`)
          lines.push(`输出目录：${value.outputDir}`)
          if (value.connected) {
            const models = value.models
            const line = (label, list) => (list.length === 0 ? `${label}：无` : `${label}（${list.length}）：${list.slice(0, 8).join('、')}${list.length > 8 ? ' …' : ''}`)
            lines.push(line('checkpoints', models.checkpoints), line('diffusion_models', models.diffusionModels), line('text_encoders', models.textEncoders), line('vae', models.vaes))
          }
          return [text(lines.join('\n'))]
        },
      },
      async execute() {
        const config = runtime.config()
        const ping = await client.ping()
        const stats = ping.ok ? await client.systemStats().catch(() => undefined) : undefined
        const queue = ping.ok ? await client.queue().catch(() => undefined) : undefined
        const files = await client.listWorkflowFiles()
        const models = ping.ok ? await detectModels(client) : { checkpoints: [], diffusionModels: [], textEncoders: [], vaes: [] }
        return {
          connected: ping.ok,
          version: ping.ok ? String(stats?.system?.comfyui_version ?? ping.version ?? 'unknown') : undefined,
          error: ping.ok ? undefined : ping.error,
          baseUrl: config.baseUrl,
          comfyuiDir: config.comfyuiDir,
          workflowsDir: client.workflowsDir,
          outputDir: client.outputDir,
          workflowCount: files.length,
          queueRunning: queue?.queue_running?.length ?? 0,
          queuePending: queue?.queue_pending?.length ?? 0,
          models,
        }
      },
    }),
  )

  // ── comfyui_nodes ────────────────────────────────────────────────────────
  register(
    defineJsonTool({
      name: 'comfyui_nodes',
      description:
        '查询 ComfyUI 服务器支持的节点。不传 class 时按关键字搜索节点类名（例如 filter:"Lora"）；传 class 时返回该类节点的完整输入定义（每个输入的类型、默认值、取值范围、可选项），用于手工搭建 API 工作流。',
      parameters: {
        filter: { type: 'string', description: '按类名/分类的子串搜索（不区分大小写）' },
        class: { type: 'string', description: '单个节点类名，取它的输入定义' },
        limit: { type: 'integer', description: '列表最多返回多少条（默认 60）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            matches: { type: 'array', items: { type: 'string' }, required: true },
            truncated: { type: 'boolean', required: true },
            definition: { type: 'json' },
          },
        },
        render(args, value) {
          if (value.definition !== undefined) return [text(`节点 ${args.class} 的定义：\n${JSON.stringify(value.definition, null, 1)}`)]
          if (value.matches.length === 0) return [text(`没有匹配的节点类。服务器共有 ${value.total} 个节点类。`)]
          return [text(`匹配 ${value.matches.length} 个节点类${value.truncated ? '（已截断，可用更具体的关键字）' : ''}：\n${value.matches.join('\n')}`)]
        },
      },
      async execute(args) {
        const objectInfo = await client.objectInfo()
        const names = Object.keys(objectInfo).sort()
        if (typeof args.class === 'string' && args.class.length > 0) {
          const definition = objectInfo[args.class]
          if (definition === undefined) return { total: names.length, matches: [], truncated: false, definition: { error: `服务器上没有节点类 ${args.class}` } }
          return { total: names.length, matches: [], truncated: false, definition: { name: args.class, input: definition.input, output: definition.output, output_name: definition.output_name, output_node: definition.output_node, category: definition.category } }
        }
        const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : undefined
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 400) : 60
        const matched = filter === undefined ? names : names.filter((name) => name.toLowerCase().includes(filter))
        return { total: names.length, matches: matched.slice(0, limit), truncated: matched.length > limit, definition: undefined }
      },
    }),
  )

  // ── comfyui_workflows ────────────────────────────────────────────────────
  register(
    defineJsonTool({
      name: 'comfyui_workflows',
      description:
        '操作用户在 ComfyUI 界面里保存的画布工作流。action:"list" 列出它们（含节点数与输出节点，判断某个工作流是文生图还是反推）；action:"params" 返回某个工作流里可调的参数（节点 id + 当前值 + 取值范围），这是准备运行前最该看的东西；action:"get" 返回转换后的完整 API 工作流（很费 token，只在需要精细改节点时用）。',
      parameters: {
        action: { type: 'string', enum: ['list', 'params', 'get'], description: '默认 list' },
        name: { type: 'string', description: '画布工作流名（不带 .json），action 为 params/get 时必填' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            workflows: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  nodes: { type: 'integer', required: true },
                  outputs: { type: 'array', items: { type: 'string' }, required: true },
                  modified: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                },
              },
            },
            name: { type: 'string' },
            file: { type: 'string' },
            params: { type: 'json' },
            workflow: { type: 'json' },
            warnings: { type: 'array', items: { type: 'string' }, required: true },
            skipped: { type: 'array', items: { type: 'string' }, required: true },
            nodeCount: { type: 'integer' },
          },
        },
        render(args, value) {
          if (value.action === 'list') {
            if (value.workflows.length === 0) return [text(`画布工作流目录里没有 .json：${value.file ?? ''}`)]
            const lines = value.workflows.map((item) => `- ${item.name}｜${item.nodes} 个节点｜输出节点：${item.outputs.join('、') || '无'}｜${item.modified}`)
            return [text(`共 ${value.workflows.length} 个画布工作流：\n${lines.join('\n')}\n用 action:"params" + name 看某个工作流能调什么。`)]
          }
          const lines = []
          if (value.action === 'params') {
            lines.push(`工作流「${value.name}」的可调参数（共 ${value.nodeCount} 个节点）：`)
            for (const group of value.params ?? []) {
              lines.push(`- 节点 ${group.id}（${group.class_type}${group.title ? ` / ${group.title}` : ''}）`)
              for (const field of group.fields) lines.push(`    ${field.name} = ${JSON.stringify(field.value)}${field.options ? `  可选：${field.options.slice(0, 12).join('、')}${field.options.length > 12 ? ' …' : ''}` : ''}${field.min !== undefined ? `  范围 ${field.min}~${field.max}` : ''}`)
            }
            if (value.warnings.length > 0) lines.push('', `提示：${value.warnings.slice(0, 8).join('；')}`)
            if (value.skipped.length > 0) lines.push(`跳过：${value.skipped.join('；')}`)
            lines.push('', `运行：comfyui_run { file: ${JSON.stringify(value.name)}, inputs: { "<节点id>": { "<字段>": 新值 } } }`)
            return [text(lines.join('\n'))]
          }
          lines.push(`工作流「${value.name}」的 API 形式（${value.nodeCount} 个节点）：`, JSON.stringify(value.workflow))
          if (value.warnings.length > 0) lines.push(`警告：${value.warnings.join('；')}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const action = typeof args.action === 'string' ? args.action : 'list'
        if (action === 'list') {
          const files = await client.listWorkflowFiles()
          // 必须带 object_info 转换，否则 UI 专用节点（Note/Primitive/虚拟节点）会被算进节点数，
          // 与 params/get/run 报出来的数量对不上。ComfyUI 离线时退化为不带。
          const objectInfo = await client.objectInfo().catch(() => undefined)
          const workflows = []
          for (const file of files) {
            try {
              const { graph } = await client.readWorkflow(file.file)
              const converted = convertGraphToApi(graph, { objectInfo })
              const outputs = [...new Set(Object.values(converted.prompt).filter((node) => /Save|Preview|Caption|Txt|Export/.test(node.class_type)).map((node) => node.class_type))]
              workflows.push({ name: file.name, nodes: Object.keys(converted.prompt).length, outputs, modified: new Date(file.modified).toISOString().slice(0, 16).replace('T', ' '), bytes: file.bytes })
            } catch (error) {
              workflows.push({ name: file.name, nodes: 0, outputs: [`读取失败：${error instanceof Error ? error.message : String(error)}`], modified: '-', bytes: file.bytes })
            }
          }
          return { action, workflows, warnings: [], skipped: [], file: client.workflowsDir }
        }
        if (typeof args.name !== 'string' || args.name.length === 0) throw new Error('action 为 params/get 时必须给 name')
        const { graph, file } = await client.readWorkflow(args.name)
        const objectInfo = await client.objectInfo()
        const converted = convertGraphToApi(graph, { objectInfo })
        if (action === 'get') {
          return { action, workflows: [], name: args.name, file, workflow: converted.prompt, warnings: converted.warnings, skipped: converted.skipped, nodeCount: Object.keys(converted.prompt).length }
        }
        return { action: 'params', workflows: [], name: args.name, file, params: describeParams(converted, objectInfo), warnings: converted.warnings, skipped: converted.skipped, nodeCount: Object.keys(converted.prompt).length }
      },
    }),
  )

  // ── comfyui_run ──────────────────────────────────────────────────────────
  register(
    defineJsonTool({
      name: 'comfyui_run',
      timeoutMs: runtime.toolTimeoutMs ?? 2_400_000,
      description:
        '运行一次 ComfyUI 出图/处理：三选一给 file（用户保存的画布工作流名）、template（txt2img / img2img 内置模板）、或 workflow（自己写的 API 工作流对象）。用 inputs 按节点 id 覆盖输入，例如 {"76":{"seed":123}}。默认同步等待并把产出的图片直接返回；视频等长任务给 wait:false，拿到 prompt_id 后用 resume 收结果。',
      parameters: {
        file: { type: 'string', description: '画布工作流名（见 comfyui_workflows list）' },
        template: { type: 'string', enum: ['txt2img', 'img2img'], description: '内置模板' },
        workflow: { type: 'json', description: '直接给的 API 工作流（{ "3": { class_type, inputs } }）' },
        params: { type: 'json', description: '模板参数：prompt/negative/width/height/steps/cfg/seed/sampler/scheduler/checkpoint/diffusionModel/textEncoder/vae/batch/denoise/image' },
        inputs: { type: 'json', description: '按节点 id 覆盖输入：{ "节点id": { "字段": 值 } }' },
        savePrefix: { type: 'string', description: '输出文件名前缀（仅模板）' },
        randomizeSeed: { type: 'boolean', description: 'true（默认）时把没被显式覆盖的种子随机化，保证每次出图不一样；false 则严格照工作流里存的种子跑' },
        wait: { type: 'boolean', description: '是否同步等结果（默认 true）' },
        maxImages: { type: 'integer', description: '最多把几张图带回对话（默认 4）' },
        resume: { type: 'string', description: '收某个已提交 prompt_id 的结果（配合 wait:false 或超时后使用）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            promptId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            seconds: { type: 'number' },
            source: { type: 'string', required: true },
            nodeCount: { type: 'integer', required: true },
            seeds: { type: 'array', items: { type: 'integer' }, required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  filename: { type: 'string', required: true },
                  subfolder: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                },
              },
            },
            images: { type: 'array', items: IMAGE_SCHEMA, required: true },
            notes: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string' },
          },
        },
        render(args, value) {
          const blocks = []
          const countPart = value.source === 'resume' ? '' : `${value.nodeCount} 个节点`
          const secondsPart = value.seconds === undefined ? '' : `用时 ${value.seconds.toFixed(1)} 秒`
          const detail = [countPart, secondsPart].filter(Boolean).join('，')
          const lines = [`ComfyUI 运行${value.status === 'error' ? '失败' : value.status === 'submitted' ? '已提交' : '完成'}：${value.source}${detail ? `（${detail}）` : ''}`]
          lines.push(`prompt_id：${value.promptId}`)
          if (value.seeds.length > 0) lines.push(`种子：${value.seeds.join('、')}`)
          for (const file of value.files) lines.push(`产出：${file.path}`)
          for (const note of value.notes) lines.push(`- ${note}`)
          if (value.status === 'submitted') lines.push(`用 comfyui_run { resume: ${JSON.stringify(value.promptId)} } 收结果。`)
          if (value.error) lines.push(value.error)
          if (value.images.length === 0 && value.files.length === 0 && value.status === 'done') lines.push('这次运行没有产出文件。')
          blocks.push(text(lines.join('\n')))
          blocks.push(...imageBlocks(value.images))
          return blocks
        },
      },
      async execute(args, exec) {
        const config = runtime.config()
        const randomize = args.randomizeSeed !== false
        const maxImages = typeof args.maxImages === 'number' && args.maxImages > 0 ? Math.min(args.maxImages, 12) : 4
        const notes = []

        /** 收结果：下载图片、存 attachment。 */
        const collect = async (promptId, source, nodeCount, seconds) => {
          // resume 是用户给的 id，拼错就该立刻报错；我们自己刚提交的 id 则要容忍 ComfyUI 那个
          // "已出队但历史还没落盘"的毫秒级竞态（见 comfy.js 里 waitForCompletion 的说明）。
          const entry = await client.waitForCompletion(promptId, { assumeExists: source !== 'resume', onTick: () => {} })
          const media = client.collectMedia(entry)
          const files = media.map((item) => ({ filename: item.filename, subfolder: item.subfolder ?? '', kind: item.kind, path: client.localPathOf(item) }))
          const images = []
          const seenImages = new Set()
          let duplicateImages = 0
          // SaveImage 与 PreviewImage 常出同一张图（一个进 output、一个进 temp）：按内容去重，
          // 并优先保留 output 目录里的那份（真正的作品文件）。依据是 DSH 附件服务是内容寻址的
          // （同一张图必然拿到同一个 attachmentId），所以拿 attachmentId 当"图像内容"的指纹用。
          const wanted = media
            .filter((item) => item.kind === 'image')
            .sort((a, b) => (a.type === 'temp' ? 1 : 0) - (b.type === 'temp' ? 1 : 0))
          let examined = 0
          for (const item of wanted) {
            if (images.length >= maxImages) break
            examined++
            try {
              const data = await client.fetchMedia(item)
              const saved = await saveImageAttachment(sctx, data, item.filename)
              if (!saved) {
                notes.push(`图片存不进附件服务，文件在：${client.localPathOf(item)}`)
                continue
              }
              if (seenImages.has(saved.attachmentId)) {
                duplicateImages++
                continue
              }
              seenImages.add(saved.attachmentId)
              images.push(saved)
            } catch (error) {
              notes.push(`取回 ${item.filename} 失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (duplicateImages > 0) notes.push(`有 ${duplicateImages} 个产出与上面某张图内容完全相同（同一张图的不同文件名，已省略重复回显）。`)
          // 别默默截断：告诉用户还有几张没回显、以及去哪儿找文件。
          if (examined < wanted.length) notes.push(`这次产出 ${wanted.length} 张图，只回显了 ${images.length} 张（maxImages=${maxImages}）；其余文件路径见上面的产出清单。`)
          const otherMedia = media.filter((item) => item.kind !== 'image')
          if (otherMedia.length > 0) notes.push(`另有 ${otherMedia.length} 个非图片产出（视频/音频/文本），文件路径见上面的产出清单。`)
          return { promptId, status: 'done', seconds, source, nodeCount, seeds: [], files, images, notes, error: undefined }
        }

        if (typeof args.resume === 'string' && args.resume.length > 0) {
          const started = Date.now()
          const result = await collect(args.resume, 'resume', 0, undefined)
          return { ...result, seconds: (Date.now() - started) / 1000 }
        }

        const { prompt, source, seeds } = await buildPrompt(args, { client, config, randomize, notes })

        const submitted = await client.queuePrompt(prompt)
        if (submitted.nodeErrors !== undefined) {
          const detail = Object.entries(submitted.nodeErrors).map(([id, errors]) => `${id}: ${(errors.errors ?? []).map((item) => item.message ?? item.details).join('；')}`).join('\n')
          throw new Error(`工作流校验失败：\n${detail}`)
        }
        if (typeof submitted.promptId !== 'string' || submitted.promptId.length === 0) throw new Error('ComfyUI 没有返回 prompt_id，提交可能失败了。')
        notes.push(...(submitted.number === undefined ? [] : [`队列序号 ${submitted.number}`]))

        if (args.wait === false) {
          jobs.set(submitted.promptId, { source })
          return { promptId: submitted.promptId, status: 'submitted', seconds: undefined, source, nodeCount: Object.keys(prompt).length, seeds, files: [], images: [], notes: [...notes, '已提交但没等结果（wait:false）。用 resume 收结果。'], error: undefined }
        }
        const started = Date.now()
        const result = await collect(submitted.promptId, source, Object.keys(prompt).length, undefined)
        return { ...result, seconds: (Date.now() - started) / 1000, seeds }
      },
    }),
  )

  // ── comfyui_show ─────────────────────────────────────────────────────────
  register(
    defineJsonTool({
      name: 'comfyui_show',
      description:
        '看 ComfyUI 输出目录里的既有成果，或把本机文件上传进 ComfyUI 作为输入图。action:"latest" 把最近生成的几张图带回对话；action:"view" 按文件名精确取一张；action:"upload" 把本机某个图片文件复制进 ComfyUI 的 input 目录，返回可在 img2img 里用的文件名。',
      parameters: {
        action: { type: 'string', enum: ['latest', 'view', 'upload'], description: '默认 latest' },
        count: { type: 'integer', description: 'latest 取几张（默认 1，最多 8）' },
        filter: { type: 'string', description: 'latest 时按文件名子串过滤' },
        name: { type: 'string', description: 'view 时的文件名（可含子目录，如 sub/a.png）' },
        path: { type: 'string', description: 'upload 时的本机绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { filename: { type: 'string', required: true }, path: { type: 'string', required: true }, kind: { type: 'string', required: true }, modified: { type: 'string', required: true } },
              },
            },
            images: { type: 'array', items: IMAGE_SCHEMA, required: true },
            uploaded: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(args, value) {
          if (value.action === 'upload') {
            const name = value.uploaded ?? ''
            return [
              text(
                value.error ??
                  `已上传到 ComfyUI input：${name}\n在 img2img 里这样用：comfyui_run { template: "img2img", params: { image: ${JSON.stringify(name)}, prompt: "…", denoise: 0.5 } }`,
              ),
            ]
          }
          const blocks = [text(value.error ?? `ComfyUI 输出（${value.files.length} 个）：\n${value.files.map((file) => `- ${file.filename}｜${file.kind}｜${file.modified}`).join('\n')}`)]
          blocks.push(...imageBlocks(value.images))
          return blocks
        },
      },
      async execute(args) {
        const action = typeof args.action === 'string' ? args.action : 'latest'
        if (action === 'upload') {
          if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('action:upload 需要 path（本机图片绝对路径）')
          const { readFile: read } = await import('node:fs/promises')
          const { basename } = await import('node:path')
          const data = await read(args.path)
          const result = await client.uploadImage({ data, filename: basename(args.path) })
          return { action, files: [], images: [], uploaded: result?.name ?? basename(args.path), error: undefined }
        }
        const count = action === 'view' ? 1 : typeof args.count === 'number' && args.count > 0 ? Math.min(args.count, 8) : 1
        const all = await client.listOutputs({ limit: 400, filter: args.filter })
        const chosen = action === 'view' ? all.filter((file) => file.filename === args.name || `${file.subfolder}/${file.filename}` === args.name) : all.filter((file) => file.kind === 'image').slice(0, count)
        if (chosen.length === 0) {
          return { action, files: [], images: [], uploaded: undefined, error: action === 'view' ? `输出目录里没有「${args.name}」。` : '输出目录里还没有图片。' }
        }
        const images = []
        const files = []
        for (const file of chosen) {
          files.push({ filename: file.filename, path: file.path, kind: file.kind, modified: new Date(file.modified).toISOString().slice(0, 16).replace('T', ' ') })
          if (file.kind !== 'image') continue
          try {
            const data = await client.fetchMedia({ filename: file.filename, subfolder: file.subfolder, type: 'output' })
            const saved = await saveImageAttachment(sctx, data, file.filename)
            if (saved) images.push(saved)
          } catch {}
        }
        return { action, files, images, uploaded: undefined, error: undefined }
      },
    }),
  )

  return disposers
}

/**
 * 组装要提交的 API 工作流。
 * @param {any} args - 工具参数。
 * @param {{ client: any, config: any, randomize: boolean, notes: string[] }} context - 运行上下文。
 * @returns {Promise<{ prompt: Record<string, any>, source: string, seeds: number[] }>} 结果。
 */
async function buildPrompt(args, context) {
  const { client, randomize, notes } = context
  let prompt
  let source
  let templateRun = false
  if (args.workflow !== undefined && typeof args.workflow === 'object' && args.workflow !== null) {
    prompt = structuredClone(args.workflow)
    source = 'inline workflow'
  } else if (typeof args.file === 'string' && args.file.length > 0) {
    const { graph } = await client.readWorkflow(args.file)
    const objectInfo = await client.objectInfo()
    const converted = convertGraphToApi(graph, { objectInfo })
    prompt = converted.prompt
    source = `画布工作流「${args.file}」`
    notes.push(...converted.warnings.slice(0, 6))
    if (converted.warnings.length > 6) notes.push(`另有 ${converted.warnings.length - 6} 条转换告警。`)
    if (converted.skipped.length > 0) notes.push(`未参与运行：${converted.skipped.slice(0, 6).join('；')}`)
  } else if (typeof args.template === 'string' && args.template.length > 0) {
    const factory = templateByName(args.template)
    if (factory === undefined) throw new Error(`没有内置模板「${args.template}」，只有 txt2img 与 img2img`)
    templateRun = true
    const models = await detectModels(client)
    const objectInfo = await client.objectInfo()
    const params = { ...(args.params ?? {}) }
    if (typeof args.savePrefix === 'string' && args.savePrefix.length > 0) params.savePrefix = args.savePrefix
    // 图片参数洗一遍：LoadImage 只认 input 目录里的文件名，而 `input:xxx.png` 这种带注解的写法
    // （界面上、日志里很常见）直接塞进去会被 ComfyUI 判成 "Invalid image file"。
    if (typeof params.image === 'string') {
      const cleaned = normalizeInputImageName(params.image)
      if (cleaned !== params.image) notes.push(`params.image 去掉 input 注解后是「${cleaned}」。`)
      params.image = cleaned
    }
    const built = factory(models, params, objectInfo)
    prompt = built.prompt
    source = `内置模板 ${args.template}`
    notes.push(...built.notes)
    // 模板要用图（img2img 的 LoadImage）时，先确认这张图真的在 input 目录里 —— 否则只能在提交后
    // 从 ComfyUI 那句 "Invalid image file" 里猜，不如这里直接说清楚该怎么办。
    const wantedImage = Object.values(prompt).find((node) => node?.class_type === 'LoadImage')?.inputs?.image
    if (typeof wantedImage === 'string' && wantedImage.length > 0 && !client.inputImageExists(wantedImage)) {
      throw new Error(`ComfyUI 的 input 目录里没有「${wantedImage}」。先用 comfyui_show { action:"upload", path:"<本机图片绝对路径>" } 把它传进去，再把返回的文件名交给 params.image。`)
    }
  } else {
    throw new Error('必须给 file（画布工作流名）、template（txt2img/img2img）或 workflow（API 工作流对象）三者之一')
  }

  // params 只喂模板。file/workflow 运行时它会被静默忽略——尤其 params.seed 会「关掉随机化却不设种子」，
  // 很容易让人以为种子生效了，所以这里明确说清楚，并给出正确的做法。
  if (!templateRun) {
    if (args.params !== undefined && args.params !== null && typeof args.params === 'object' && Object.keys(args.params).length > 0) {
      notes.push('这是 file/workflow 运行，params 里的模板参数不生效。要改参数请用 inputs 按节点 id 覆盖，例如 inputs:{"76":{"seed":123456}}（节点 id 见 comfyui_workflows action:"params"）。')
    }
    if (typeof args.savePrefix === 'string' && args.savePrefix.length > 0) {
      notes.push('savePrefix 只在 template 运行时生效；file/workflow 运行请改 SaveImage 节点的 filename_prefix。')
    }
  }

  // inputs 覆盖：{ "节点id": { "字段": 值 } }
  const inputs = args.inputs
  if (inputs !== undefined && inputs !== null && typeof inputs === 'object') {
    for (const [nodeId, fields] of Object.entries(inputs)) {
      const node = prompt[nodeId]
      if (node === undefined) {
        throw new Error(`inputs 里的节点 ${nodeId} 不在这次运行的工作流里。可用 comfyui_workflows action:"params" 看有哪些节点。`)
      }
      if (fields === null || typeof fields !== 'object') continue
      for (const [field, value] of Object.entries(fields)) {
        if (!(field in (node.inputs ?? {}))) {
          const known = Object.keys(node.inputs ?? {}).join('、')
          throw new Error(`节点 ${nodeId}（${node.class_type}）没有输入 ${field}。它有的是：${known}`)
        }
        node.inputs[field] = value
      }
    }
  }

  // 种子随机化：没被显式覆盖的 seed/noise_seed 换成随机数（否则同一工作流跑两次出同一张图）
  const seeds = []
  const overridden = new Set()
  for (const [nodeId, fields] of Object.entries(inputs ?? {})) {
    for (const field of Object.keys(fields ?? {})) overridden.add(`${nodeId}.${field}`)
  }
  // 用户显式给了 params.seed（模板参数）时不要再随机化：给了种子就是要复现那张图
  const pinnedSeed = templateRun && typeof args.params?.seed === 'number'
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const field of ['seed', 'noise_seed']) {
      const current = node?.inputs?.[field]
      if (typeof current !== 'number') continue
      // 调用方显式钉住的种子（inputs 里的 76.seed 之类）：不随机化，但必须照实回报，
      // 否则 seeds 为空会误报「没有种子输入」——出图用的是它，报告里却不认。
      if (overridden.has(`${nodeId}.${field}`)) {
        seeds.push(current)
        continue
      }
      if (randomize && !pinnedSeed) node.inputs[field] = Math.floor(Math.random() * 0xffffffff)
      seeds.push(node.inputs[field])
    }
  }
  if (seeds.length === 0) notes.push('这次运行的节点里没有种子输入（没有采样器？）。')
  return { prompt, source, seeds }
}

/**
 * 从转换后的 API 工作流里挑出「人想改」的参数，连同节点 id 与取值范围返回。
 * @param {{ prompt: Record<string, any> }} converted - 转换结果。
 * @param {any} objectInfo - object_info。
 * @param {any} client - ComfyUI 客户端。
 * @returns {Array<{ id: string, class_type: string, title?: string, fields: Array<any> }>} 参数分组。
 */
function describeParams(converted, objectInfo) {
  /** 值得暴露的输入名（提示词、尺寸、采样、模型、文件名）。 */
  const interesting = /^(text|prompt|negative|positive|width|height|batch_size|steps|cfg|seed|noise_seed|denoise|sampler_name|scheduler|filename_prefix|image|file|audio|vae_name|unet_name|ckpt_name|clip_name|lora_name|strength|strength_model|strength_clip|model_name|weight_dtype|type|device|text_encoder|resolution|megapixels|aspect_ratio)$/
  const loaderClass = /Loader|LoadImage|LoadVideo|LoadAudio|SaveImage|SaveVideo|SaveAudio|CLIPTextEncode|KSampler|EmptyLatentImage|Resize|Scale|Txt|Caption|Preview/
  const groups = []
  for (const [id, node] of Object.entries(converted.prompt)) {
    if (!loaderClass.test(node.class_type)) continue
    const definition = objectInfo[node.class_type]
    const fields = []
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && typeof value[0] === 'string') continue // 连线，不是可调参数
      if (!interesting.test(name) && !/^(INT|FLOAT|STRING|BOOLEAN)$/.test(String(definition?.input?.required?.[name]?.[0] ?? ''))) continue
      const spec = definition?.input?.required?.[name] ?? definition?.input?.optional?.[name]
      const options = Array.isArray(spec?.[0]) ? spec[0].map(String) : undefined
      const limits = typeof spec?.[1] === 'object' && spec[1] !== null ? spec[1] : {}
      fields.push({ name, value, ...(options === undefined ? {} : { options }), ...(typeof limits.min === 'number' ? { min: limits.min, max: limits.max } : {}) })
    }
    if (fields.length === 0) continue
    groups.push({ id, class_type: node.class_type, ...(node._meta?.title === undefined ? {} : { title: node._meta.title }), fields })
  }
  return groups
}
