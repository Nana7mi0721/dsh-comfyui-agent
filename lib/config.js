/**
 * 插件配置：schemastery schema + 解析工具。
 *
 * 为什么存在：ComfyUI 的地址、本机安装目录、超时与并发上限在不同机器上都不一样，
 * 不能写死在代码里。配置写在 profile 的 `cordis.patch.yml` 里（`id: comfyui-agent`
 * 那条的 `config:` 段），运行期读取的字段标 `.volatile()`，这样用户改完配置不需要
 * 重新加载整个插件树，下一次工具调用就会读到新值。
 */
import z from '@deepseek-ai/schemastery'

/**
 * 运行期可热改的字段（地址/密钥/目录/超时/上限）。
 *
 * `comfyuiDir` 是「本机 ComfyUI 安装目录列表」而不是单个目录：整合包、便携版、
 * 多实例的用户经常有不止一份，Agent 需要靠它定位 models / custom_nodes / output。
 */
export const Config = z.object({
  /** ComfyUI 服务器地址，支持反代（形如 `https://host/comfy`）。 */
  baseUrl: z.string().default('http://127.0.0.1:8188').volatile(),
  /** 反代或 ComfyUI 鉴权插件要求的 API key；空串 = 不带认证头。 */
  apiKey: z.string().role('secret').volatile(),
  /** 是否在请求里带上 `Authorization: Bearer <apiKey>`。 */
  apiKeyHeader: z.boolean().default(true).volatile(),
  /** 本机 ComfyUI 安装目录（可多个）：为了让 Agent 直接读 models / custom_nodes / output。 */
  comfyuiDirs: z.array(z.string()).default([]).volatile(),
  /** 插件自己的数据目录；留空 = `$DSH_HOME/data/dsh-comfyui-agent`。 */
  dataDir: z.string().volatile(),
  /** ComfyUI 输出目录；留空 = 由 comfyuiDirs + `/output` 推断（仅用于按文件清理资产）。 */
  outputDir: z.string().volatile(),
  /** 单次 HTTP 请求超时（毫秒）。object_info 在装满插件的机器上可以大到若干 MB。 */
  requestTimeoutMs: z.number().default(120000).volatile(),
  /** `mode: sync` 等待一次运行完成的上限（毫秒），超时后转为后台任务并返回 prompt_id。 */
  runTimeoutMs: z.number().default(900000).volatile(),
  /** 轮询运行结果的间隔（毫秒）。 */
  pollIntervalMs: z.number().default(1000).volatile(),
  /** 一次运行最多回显几张图到对话里（视频/音频只回文件路径，不回显字节）。 */
  maxInlineImages: z.number().default(4).volatile(),
  /** 单张图回显的字节上限；超过就只回路径不动 attachment 存储。 */
  maxInlineImageBytes: z.number().default(15728640).volatile(),
  /** 是否允许工具上传本机文件到 ComfyUI 输入目录（img2img / 视频参考用）。 */
  allowUpload: z.boolean().default(true).volatile(),
  /** 允许上传的根目录列表；空 = 允许工作区与 ComfyUI 目录。 */
  uploadRoots: z.array(z.string()).default([]).volatile(),
})

/**
 * 把 loader 交给 `apply` 的配置解成普通对象。
 *
 * `.volatile()` 字段拿到的可能是「活引用」（带 `get()`），每次读都要现解一次，
 * 否则会把启动那一刻的值永久缓存下来。非对象值一律按原样返回。
 * @param {unknown} config - loader 传入的配置对象。
 * @returns {Record<string, unknown>} 解引用后的配置。
 */
export function resolveConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

/**
 * 规范化配置：去掉末尾斜杠、展开默认目录、把空串当作「未设置」。
 * @param {Record<string, unknown>} raw - `resolveConfig` 的产物。
 * @returns {{
 *   baseUrl: string, apiKey: string, apiKeyHeader: boolean, comfyuiDirs: string[],
 *   dataDir: string|undefined, outputDir: string|undefined, requestTimeoutMs: number,
 *   runTimeoutMs: number, pollIntervalMs: number, maxInlineImages: number,
 *   maxInlineImageBytes: number, allowUpload: boolean, uploadRoots: string[],
 * }} 规范化后的配置。
 */
export function normalizeConfig(raw) {
  const str = (value) => (typeof value === 'string' ? value.trim() : '')
  const num = (value, fallback, min = 1) => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n >= min ? n : fallback
  }
  const list = (value) => (Array.isArray(value) ? value.map((v) => str(v)).filter((v) => v.length > 0) : [])
  const dirs = list(raw.comfyuiDirs)
  return {
    baseUrl: str(raw.baseUrl) === '' ? 'http://127.0.0.1:8188' : str(raw.baseUrl).replace(/\/+$/, ''),
    apiKey: str(raw.apiKey),
    apiKeyHeader: raw.apiKeyHeader !== false,
    comfyuiDirs: dirs,
    dataDir: str(raw.dataDir) === '' ? undefined : str(raw.dataDir),
    outputDir: str(raw.outputDir) === '' ? undefined : str(raw.outputDir),
    requestTimeoutMs: num(raw.requestTimeoutMs, 120000, 1000),
    runTimeoutMs: num(raw.runTimeoutMs, 900000, 1000),
    pollIntervalMs: num(raw.pollIntervalMs, 1000, 100),
    maxInlineImages: num(raw.maxInlineImages, 4, 0),
    maxInlineImageBytes: num(raw.maxInlineImageBytes, 15 * 1024 * 1024, 1024),
    allowUpload: raw.allowUpload !== false,
    uploadRoots: list(raw.uploadRoots),
  }
}
