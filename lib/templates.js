/**
 * 内置 API 模板：让「什么都不准备」也能出图。
 *
 * 为什么存在：用户画布工作流是主力，但有些场合（新模型、空 ComfyUI、只想快速试一张）
 * 需要一条不依赖任何已保存画的运行路径。模板按本机实际模型布局生成：
 * 有 checkpoints 就走 CheckpointLoaderSimple，没有就走 UNETLoader + CLIPLoader + VAELoader
 * （本机是 Anima：diffusion_models/anima-*.safetensors + text_encoders/qwen_3_06b_base + vae/qwen_image_vae）。
 */

/** 模型清单。 @typedef {{ checkpoints: string[], diffusionModels: string[], textEncoders: string[], vaes: string[] }} ModelInventory */

/**
 * 侦察本机有哪些模型可用。
 * @param {import('./comfy.js').ComfyClient} client - ComfyUI 客户端。
 * @returns {Promise<ModelInventory>} 模型清单。
 */
export async function detectModels(client) {
  const [checkpoints, diffusionModels, textEncoders, clip, vaes] = await Promise.all([
    client.models('checkpoints'),
    client.models('diffusion_models'),
    client.models('text_encoders'),
    client.models('clip'),
    client.models('vae'),
  ])
  const clean = (list) => list.filter((name) => !/^put_.*_here$/i.test(name) && !name.endsWith('.metadata.json'))
  return {
    checkpoints: clean(checkpoints),
    diffusionModels: clean(diffusionModels),
    textEncoders: [...clean(textEncoders), ...clean(clip)],
    vaes: clean(vaes),
  }
}

/**
 * 从候选里挑一个：优先名字里含关键字的，否则第一个。
 * @param {string[]} list - 候选。
 * @param {string[]} [preferred] - 关键字（不区分大小写）。
 * @returns {string|undefined} 选中项。
 */
export function pick(list, preferred = []) {
  for (const keyword of preferred) {
    const hit = list.find((name) => name.toLowerCase().includes(keyword.toLowerCase()))
    if (hit !== undefined) return hit
  }
  return list[0]
}

/**
 * 校验采样器 / 调度器的取值是否在服务器支持范围内。
 * @param {any} objectInfo - object_info。
 * @param {{ sampler?: string, scheduler?: string }} wanted - 期望值。
 * @returns {{ sampler?: string, scheduler?: string, notes: string[] }} 实际可用值。
 */
function resolveSampler(objectInfo, wanted) {
  const notes = []
  const samplerOptions = objectInfo?.KSampler?.input?.required?.sampler_name?.[0]
  const schedulerOptions = objectInfo?.KSampler?.input?.required?.scheduler?.[0]
  const pickOption = (options, value, fallback, label) => {
    if (!Array.isArray(options) || options.length === 0) return value
    if (value !== undefined && options.includes(value)) return value
    if (value !== undefined) notes.push(`${label}「${value}」不在服务器支持范围内，已改用「${fallback}」`)
    return options.includes(fallback) ? fallback : options[0]
  }
  return {
    sampler: pickOption(samplerOptions, wanted.sampler, 'euler', '采样器'),
    scheduler: pickOption(schedulerOptions, wanted.scheduler, 'normal', '调度器'),
    notes,
  }
}

/** 模板默认参数（本机 Anima 的可用配方）。 */
export const TEMPLATE_DEFAULTS = {
  prompt: 'a cute girl, detailed, high quality',
  negative: 'worst quality, low quality, blurry, watermark, text',
  width: 1024,
  height: 1024,
  batch: 1,
  steps: 12,
  cfg: 1,
  denoise: 1,
  sampler: 'euler',
  scheduler: 'beta57',
}

/**
 * 生成 txt2img 的 API 工作流。
 * @param {ModelInventory} models - 模型清单。
 * @param {Record<string, any>} params - 参数（见 TEMPLATE_DEFAULTS，另可给 checkpoint / diffusionModel / textEncoder / vae / savePrefix / seed）。
 * @param {any} [objectInfo] - object_info，用于校验采样器取值。
 * @returns {{ prompt: Record<string, any>, notes: string[] }} API 工作流与提示。
 */
export function txt2img(models, params, objectInfo) {
  const notes = []
  const merged = { ...TEMPLATE_DEFAULTS, ...stripUndefined(params) }
  const { sampler, scheduler, notes: samplerNotes } = resolveSampler(objectInfo, merged)
  notes.push(...samplerNotes)
  const savePrefix = merged.savePrefix ?? 'dsh'

  const prompt = {
    3: {
      class_type: 'KSampler',
      _meta: { title: '采样器' },
      inputs: {
        seed: merged.seed ?? Math.floor(Math.random() * 0xffffffff),
        steps: merged.steps,
        cfg: merged.cfg,
        sampler_name: sampler,
        scheduler,
        denoise: merged.denoise,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    5: { class_type: 'EmptyLatentImage', _meta: { title: '空 Latent' }, inputs: { width: merged.width, height: merged.height, batch_size: merged.batch } },
    6: { class_type: 'CLIPTextEncode', _meta: { title: '正面提示词' }, inputs: { text: merged.prompt } },
    7: { class_type: 'CLIPTextEncode', _meta: { title: '负面提示词' }, inputs: { text: merged.negative } },
    8: { class_type: 'VAEDecode', _meta: { title: '解码' }, inputs: { samples: ['3', 0] } },
    9: { class_type: 'SaveImage', _meta: { title: '保存' }, inputs: { images: ['8', 0], filename_prefix: savePrefix } },
  }

  const checkpoint = merged.checkpoint ?? pick(models.checkpoints)
  if (checkpoint !== undefined && merged.diffusionModel === undefined) {
    prompt['4'] = { class_type: 'CheckpointLoaderSimple', _meta: { title: '主模型' }, inputs: { ckpt_name: checkpoint } }
    prompt['3'].inputs.model = ['4', 0]
    prompt['6'].inputs.clip = ['4', 1]
    prompt['7'].inputs.clip = ['4', 1]
    prompt['8'].inputs.vae = ['4', 2]
    notes.push(`使用 checkpoint：${checkpoint}`)
  } else {
    const diffusionModel = merged.diffusionModel ?? pick(models.diffusionModels, ['anima'])
    const textEncoder = merged.textEncoder ?? pick(models.textEncoders)
    const vae = merged.vae ?? pick(models.vaes)
    if (diffusionModel === undefined) throw new Error('本机没有可用的主模型：checkpoints 与 diffusion_models 都是空的。请先在 ComfyUI 里放模型。')
    if (textEncoder === undefined) throw new Error('本机没有可用的文本编码器（text_encoders 目录为空）。')
    if (vae === undefined) throw new Error('本机没有可用的 VAE（vae 目录为空）。')
    prompt['4'] = { class_type: 'UNETLoader', _meta: { title: '扩散模型' }, inputs: { unet_name: diffusionModel, weight_dtype: merged.weightDtype ?? 'default' } }
    prompt['10'] = { class_type: 'CLIPLoader', _meta: { title: '文本编码器' }, inputs: { clip_name: textEncoder, type: merged.clipType ?? 'stable_diffusion', device: 'default' } }
    prompt['11'] = { class_type: 'VAELoader', _meta: { title: 'VAE' }, inputs: { vae_name: vae } }
    prompt['3'].inputs.model = ['4', 0]
    prompt['6'].inputs.clip = ['10', 0]
    prompt['7'].inputs.clip = ['10', 0]
    prompt['8'].inputs.vae = ['11', 0]
    notes.push(`使用 diffusion_models：${diffusionModel} + 文本编码器 ${textEncoder} + VAE ${vae}`)
  }
  return { prompt, notes }
}

/**
 * 生成 img2img 的 API 工作流（按图生图 / 改图）。
 * @param {ModelInventory} models - 模型清单。
 * @param {Record<string, any>} params - 参数，必需 `image`（ComfyUI input 目录里的文件名）。
 * @param {any} [objectInfo] - object_info。
 * @returns {{ prompt: Record<string, any>, notes: string[] }} API 工作流与提示。
 */
export function img2img(models, params, objectInfo) {
  if (typeof params.image !== 'string' || params.image.length === 0) {
    throw new Error('img2img 需要 image 参数（ComfyUI input 目录里的图片文件名，可用 comfyui_show action:upload 先上传）')
  }
  const merged = { ...TEMPLATE_DEFAULTS, denoise: 0.6, ...stripUndefined(params) }
  const built = txt2img(models, { ...merged, denoise: merged.denoise }, objectInfo)
  const prompt = built.prompt
  // 用「加载图 → VAEEncode」替换掉空 Latent
  delete prompt['5']
  prompt['12'] = { class_type: 'LoadImage', _meta: { title: '输入图' }, inputs: { image: params.image } }
  prompt['13'] = { class_type: 'VAEEncode', _meta: { title: '编码输入图' }, inputs: { pixels: ['12', 0], vae: prompt['8'].inputs.vae } }
  prompt['3'].inputs.latent_image = ['13', 0]
  return { prompt, notes: built.notes }
}

/**
 * 模板名 → 生成函数。
 * @param {string} name - `txt2img` / `img2img`。
 * @returns {typeof txt2img|undefined} 生成函数。
 */
export function templateByName(name) {
  if (name === 'txt2img') return txt2img
  if (name === 'img2img') return img2img
  return undefined
}

/** 去掉值为 undefined 的键（`{...a, ...b}` 会把显式的 undefined 覆盖进去）。 */
function stripUndefined(object) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}
