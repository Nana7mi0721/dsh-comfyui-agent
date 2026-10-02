/**
 * ComfyUI HTTP 客户端 + 本机目录访问。
 *
 * 为什么存在：插件的全部能力（跑工作流、取图、列模型、读用户保存的画布）
 * 都收敛到这一层，工具层不再自己拼 URL；同时本机跑着 ComfyUI 时，
 * 直接读它的目录比走 API 更可靠（用户保存的画布 ComfyUI 没有对应的读取接口，
 * 只有 `/userdata/{file}` 能拿到）。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 一次运行产出的媒体文件。 @typedef {{ filename: string, subfolder: string, type: string, kind: 'image'|'video'|'audio'|'file', path?: string }} MediaFile */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a'])

/**
 * 按扩展名判断媒体种类。
 * @param {string} name - 文件名。
 * @returns {'image'|'video'|'audio'|'file'} 种类。
 */
export function mediaKind(name) {
  const index = name.lastIndexOf('.')
  const ext = index < 0 ? '' : name.slice(index).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'file'
}

/** 按扩展名给 ContentBlock 用的 MIME。 */
export function mediaTypeOf(name) {
  const index = name.lastIndexOf('.')
  const ext = index < 0 ? '' : name.slice(index).toLowerCase()
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }[ext] ?? 'application/octet-stream'
  )
}

/** ComfyUI 客户端。 */
/**
 * 把用户/模型给的图片参数洗成 input 目录里的文件名。
 * ComfyUI 的 LoadImage 只认 input 目录下的名字，但界面上显示、日志里复述时经常带上 `input:` 前缀
 * （有时是中文全角冒号）或方括号写法，直接塞回去就会得到 "Invalid image file"。
 * @param {string} value - 原始值。
 * @returns {string} 去掉注解与引号后的文件名。
 */
export function normalizeInputImageName(value) {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/^\[input\]/i, '')
    .replace(/^input\s*[:：]\s*/i, '')
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

export class ComfyClient {
  /**
   * @param {() => { baseUrl: string, timeoutMs: number, pollIntervalMs: number, comfyuiDir: string }} configOf - 现读配置（设置页可热改）。
   */
  constructor(configOf) {
    this.configOf = configOf
    /** 记住前缀学习结果：裸路由 404 时改用 /api 前缀。 */
    this.routePrefix = ''
    this.clientId = randomUUID()
  }

  /** @returns {string} 去掉尾斜杠的 baseUrl。 */
  get base() {
    return this.configOf().baseUrl.replace(/\/+$/, '')
  }

  /**
   * 发一个请求，自动处理 `/api` 前缀回退。
   * @param {string} route - 形如 `/object_info`。
   * @param {{ method?: string, body?: any, raw?: BodyInit, headers?: Record<string,string>, timeoutMs?: number, responseType?: 'json'|'text'|'buffer' }} [options] - 请求选项。
   * @returns {Promise<any>} 解析后的响应。
   */
  async request(route, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.configOf().requestTimeoutMs
    const attempts = this.routePrefix === '' ? ['', '/api'] : [this.routePrefix]
    let lastError
    for (const prefix of attempts) {
      const url = `${this.base}${prefix}${route}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          headers: options.raw === undefined && options.body !== undefined ? { 'content-type': 'application/json', ...options.headers } : options.headers,
          signal: controller.signal,
        })
        if (response.status === 404 && prefix === '' && this.routePrefix === '') continue
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`ComfyUI ${options.method ?? 'GET'} ${route} 返回 ${response.status}${text ? `：${text.slice(0, 400)}` : ''}`)
        }
        this.routePrefix = prefix
        if (options.responseType === 'buffer') return Buffer.from(await response.arrayBuffer())
        if (options.responseType === 'text') return await response.text()
        return await response.json()
      } catch (error) {
        lastError = error
        if (error?.name === 'AbortError') throw new Error(`ComfyUI 请求超时（${timeoutMs}ms）：${url}`)
        if (prefix === '' && this.routePrefix === '') continue
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new Error(`ComfyUI 请求失败：${route}`)
  }

  /** 服务器是否在线。 @returns {Promise<{ ok: boolean, version?: string, error?: string }>} 探测结果。 */
  async ping() {
    try {
      const stats = await this.request('/system_stats', { timeoutMs: Math.min(8000, this.configOf().requestTimeoutMs) })
      return { ok: true, version: stats?.system?.comfyui_version ?? stats?.system?.os ?? 'unknown' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** @returns {Promise<any>} system_stats 原文。 */
  async systemStats() {
    return await this.request('/system_stats')
  }

  /** @returns {Promise<Record<string, any>>} 全部节点定义（object_info）。 */
  async objectInfo() {
    return await this.request('/object_info')
  }

  /**
   * 列某个模型目录下的文件（ComfyUI 0.3+ 的 `/models/{folder}`）。
   * @param {string} folder - 目录名，如 `checkpoints`。
   * @returns {Promise<string[]>} 文件名清单。
   */
  async models(folder) {
    try {
      const list = await this.request(`/models/${encodeURIComponent(folder)}`)
      return Array.isArray(list) ? list.map(String) : []
    } catch {
      return []
    }
  }

  /** @returns {Promise<any>} 队列状态。 */
  async queue() {
    return await this.request('/queue')
  }

  /**
   * 提交一个 API 工作流。
   * @param {Record<string, any>} prompt - API prompt。
   * @returns {Promise<{ promptId: string, number?: number, nodeErrors?: any }>} 提交结果。
   */
  async queuePrompt(prompt) {
    const body = { prompt, client_id: this.clientId }
    try {
      const result = await this.request('/prompt', { method: 'POST', body })
      if (result?.node_errors && Object.keys(result.node_errors).length > 0) return { promptId: result.prompt_id, number: result.number, nodeErrors: result.node_errors }
      return { promptId: result?.prompt_id ?? '', number: result?.number }
    } catch (error) {
      // ComfyUI 的校验错误在 400 响应体里，request 已经把正文带进错误消息了
      throw new Error(`提交失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 中断当前执行。
   * @returns {Promise<void>} 无。
   */
  async interrupt() {
    await this.request('/interrupt', { method: 'POST', body: {} })
  }

  /**
   * 等一次运行结束。
   * @param {string} promptId - prompt_id。
   * @param {{ onTick?: (info: { elapsedMs: number, queueRemaining?: number, running?: boolean }) => void }} [options] - 轮询回调。
   * @returns {Promise<any>} history 里该 prompt 的条目。
   */
  /**
   * 这个 prompt_id 是否真的存在（在队列里，或已在历史记录里）。
   * @param {string} promptId - 任务 id。
   * @returns {Promise<boolean>} 存在为 true。
   */
  async promptExists(promptId) {
    const history = await this.request(`/history/${encodeURIComponent(promptId)}`)
    if (history && typeof history === 'object' && history[promptId]) return true
    const queue = await this.queue()
    return [...(queue?.queue_pending ?? []), ...(queue?.queue_running ?? [])].some((item) => Array.isArray(item) && item[1] === promptId)
  }

  /**
   * 等到任务跑完，返回它在 /history 里的条目。
   * @param {string} promptId - 任务 id。
   * @param {object} [options] - assumeExists 为 true 表示"这个 id 是我们刚提交的"，此时不做提交前的存在性
   *   硬判定（见下方竞态说明）；resume 用户给的 id 时保持默认的严格判定，拼错立刻报错。
   */
  async waitForCompletion(promptId, options = {}) {
    const { pollIntervalMs, runTimeoutMs } = this.configOf()
    const assumeExists = options.assumeExists === true
    const graceChecks = typeof options.graceChecks === 'number' && options.graceChecks > 0 ? options.graceChecks : 5
    const startedAt = Date.now()
    // 先确认 prompt_id 真的存在。不做这一步的话，拼错的 id 会一直轮询到 runTimeoutMs（默认 30 分钟）才报错，
    // 白白把会话挂住；连不上服务器时也应该立刻说清楚，而不是陪它耗。
    if (!assumeExists) {
      let known
      try {
        known = await this.promptExists(promptId)
      } catch (error) {
        throw new Error(`查不到 prompt_id=${promptId} 的状态：连不上 ComfyUI（${error instanceof Error ? error.message : String(error)}）。`)
      }
      if (!known) throw new Error(`找不到 prompt_id=${promptId}：它既不在队列里，也不在 ComfyUI 的历史记录里（可能拼错了、或该任务已被清理）。可以调 comfyui_status 看当前队列。`)
    }
    let failures = 0
    // 刚提交的任务不能用"队列/历史里查不到"来立刻判死：ComfyUI 有个毫秒级竞态 —— 缓存命中的任务可能在
    // 我们第一次查询之前就已经从队列弹出、而历史条目还没落盘，两边都查不到（实测缓存全命中的模板运行
    // 只用约 10ms）。所以这里改成"连续若干轮都查不到"才认定它真的丢了。
    let invisible = 0
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > runTimeoutMs) throw new Error(`等待 ComfyUI 运行超时（${Math.round(runTimeoutMs / 1000)} 秒）：prompt_id=${promptId}。可以调 comfyui_status 看队列，或在 ComfyUI 界面里确认。`)
      let history
      try {
        history = await this.request(`/history/${encodeURIComponent(promptId)}`)
        failures = 0
      } catch (error) {
        failures++
        // ComfyUI 中途被关掉/失联时，不要一直轮询到超时
        if (failures >= 30) throw new Error(`连不上 ComfyUI（连续 ${failures} 次请求失败），没法继续等 prompt_id=${promptId}：${error instanceof Error ? error.message : String(error)}`)
        options.onTick?.({ elapsedMs })
        continue
      }
      const entry = history?.[promptId]
      if (entry) {
        const status = entry.status ?? {}
        if (status.status_str === 'error' || status.completed === false) {
          const messages = (status.messages ?? []).map((item) => (Array.isArray(item) ? item[1] : item))
          const failure = [...messages].reverse().find((message) => message?.exception_message || message?.exception_type)
          const detail = failure ? `${failure.exception_type ?? '执行错误'}：${failure.exception_message ?? ''}`.slice(0, 800) : JSON.stringify(messages).slice(0, 800)
          throw new Error(`ComfyUI 执行失败：${detail}`)
        }
        return entry
      }
      let queueRemaining
      let running
      let queueOk = false
      let queued = false
      try {
        const queue = await this.queue()
        const items = [...(queue?.queue_pending ?? []), ...(queue?.queue_running ?? [])]
        queueRemaining = items.length
        running = (queue?.queue_running ?? []).some((item) => item?.[1] === promptId)
        queued = items.some((item) => Array.isArray(item) && item[1] === promptId)
        queueOk = true
      } catch {}
      if (assumeExists && queueOk) {
        if (queued) invisible = 0
        else if (++invisible >= graceChecks) {
          throw new Error(`prompt_id=${promptId} 提交之后既不在队列里、也没进历史记录（连查 ${graceChecks} 次、约 ${Math.round((graceChecks * pollIntervalMs) / 1000)} 秒）。ComfyUI 可能把这个任务丢了，可以调 comfyui_status 看当前队列。`)
        }
      }
      options.onTick?.({ elapsedMs, queueRemaining, running })
    }
  }

  /**
   * 从 history 条目里收集产出文件。
   * @param {any} entry - history 条目。
   * @returns {MediaFile[]} 媒体清单。
   */
  collectMedia(entry) {
    const out = []
    const outputs = entry?.outputs ?? {}
    for (const nodeOutput of Object.values(outputs)) {
      const groups = [nodeOutput?.images, nodeOutput?.gifs, nodeOutput?.videos, nodeOutput?.audio, nodeOutput?.files]
      for (const group of groups) {
        if (!Array.isArray(group)) continue
        for (const item of group) {
          if (!item || typeof item.filename !== 'string') continue
          out.push({
            filename: item.filename,
            subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
            type: typeof item.type === 'string' ? item.type : 'output',
            kind: mediaKind(item.filename),
          })
        }
      }
    }
    return out
  }

  /**
   * 下载一个产出文件。
   * @param {MediaFile} file - 媒体引用。
   * @returns {Promise<Buffer>} 字节。
   */
  async fetchMedia(file) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const buffer = await this.request(`/view?${query.toString()}`, { responseType: 'buffer', timeoutMs: Math.max(60_000, this.configOf().requestTimeoutMs) })
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error(`取回文件失败（空内容）：${file.filename}`)
    return buffer
  }

  /**
   * 上传一张图到 ComfyUI 的 input 目录（img2img / 参考图用）。
   * @param {{ data: Uint8Array, filename: string }} input - 字节与文件名。
   * @returns {Promise<{ name: string, subfolder: string, type: string }>} 上传结果。
   */
  async uploadImage(input) {
    const form = new FormData()
    form.append('image', new Blob([input.data]), input.filename)
    form.append('overwrite', 'true')
    form.append('type', 'input')
    return await this.request('/upload/image', { method: 'POST', raw: form })
  }

  /** @returns {string} ComfyUI 的本体目录（如 `E:\ComfyUI\ComfyUI`）。 */
  get comfyuiDir() {
    return this.configOf().comfyuiDir
  }

  /** @returns {string} 画布工作流目录（用户保存在 `user/default/workflows` 的那些）。 */
  get workflowsDir() {
    const configured = this.configOf().workflowsDir
    if (configured && existsSync(configured)) return configured
    const candidates = [join(this.comfyuiDir, 'user', 'default', 'workflows'), join(this.comfyuiDir, 'workflows')]
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  }

  /** @returns {string} ComfyUI 的 output 目录。 */
  get outputDir() {
    return join(this.comfyuiDir, 'output')
  }

  /** @returns {string} ComfyUI 的 temp 目录（PreviewImage 之类写这里）。 */
  get tempDir() {
    return join(this.comfyuiDir, 'temp')
  }

  /** @returns {string} ComfyUI 的 input 目录（上传的参考图放这里）。 */
  get inputDir() {
    return join(this.comfyuiDir, 'input')
  }

  /**
   * input 目录里是否真有这张图。LoadImage 的 `image` 必须是 input 目录里的文件名，写错了 ComfyUI 只会
   * 回一句 "Invalid image file: ..."，所以在提交前先替用户把话说清楚。
   * @param {string} name - 文件名（可含子目录，如 `sub/a.png`）。
   * @returns {boolean} 存在为 true。
   */
  inputImageExists(name) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('..')) return false
    return existsSync(join(this.inputDir, ...name.split(/[\\/]+/)))
  }

  /**
   * 一个产出文件在本机的真实路径。
   * history 里的 `type` 决定它落在 output / temp / input 哪个目录，不能一律按 output 拼：
   * PreviewImage 写的 `ComfyUI_temp_*.png` 在 `ComfyUI/temp/` 下，拼成 output 会给出不存在的路径。
   * @param {{ filename: string, subfolder?: string, type?: string }} file - 媒体引用。
   * @returns {string} 绝对路径。
   */
  localPathOf(file) {
    const dir = file?.type === 'temp' ? this.tempDir : file?.type === 'input' ? this.inputDir : this.outputDir
    return [dir, file?.subfolder, file?.filename].filter(Boolean).join(sep)
  }

  /**
   * 列用户保存的画布工作流。
   * @returns {Promise<Array<{ name: string, file: string, bytes: number, modified: number }>>} 清单（名字去 `.json`）。
   */
  async listWorkflowFiles() {
    const dir = this.workflowsDir
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const full = join(dir, entry.name)
      const info = await stat(full).catch(() => undefined)
      out.push({ name: entry.name.replace(/\.json$/i, ''), file: full, bytes: info?.size ?? 0, modified: info?.mtimeMs ?? 0 })
    }
    return out.sort((a, b) => b.modified - a.modified)
  }

  /**
   * 读一个画布工作流文件。文件名可以是绝对路径，也可以是工作流目录下的名字。
   * @param {string} nameOrPath - 名字或路径。
   * @returns {Promise<{ graph: any, file: string }>} 画布 JSON 与真实路径。
   */
  async readWorkflow(nameOrPath) {
    const direct = resolve(nameOrPath)
    const candidates = [direct, join(this.workflowsDir, nameOrPath), join(this.workflowsDir, `${nameOrPath}.json`)]
    const found = candidates.find((candidate) => existsSync(candidate) && candidate.toLowerCase().endsWith('.json'))
    if (!found) throw new Error(`找不到画布工作流「${nameOrPath}」。可用 comfyui_workflows action:list 看有哪些。`)
    // 名字按画布工作流目录解析；也接受显式给的绝对路径（不做额外限制，调用方本来就有文件工具）
    const text = await readFile(found, 'utf8')
    return { graph: JSON.parse(text), file: found }
  }

  /**
   * 列 output 目录里的产出文件（按时间倒序）。
   * @param {{ limit?: number, filter?: string }} [options] - 筛选。
   * @returns {Promise<Array<{ filename: string, subfolder: string, type: string, kind: string, path: string, bytes: number, modified: number }>>} 文件清单。
   */
  async listOutputs(options = {}) {
    const dir = this.outputDir
    if (!existsSync(dir)) return []
    const limit = options.limit ?? 20
    const filter = options.filter?.toLowerCase()
    const out = []
    const walk = async (current, depth) => {
      if (depth > 3) return
      const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (filter && !entry.name.toLowerCase().includes(filter)) continue
        const info = await stat(full).catch(() => undefined)
        out.push({
          filename: entry.name,
          subfolder: relative(dir, current).split(sep).filter((part) => part !== '.').join('/'),
          type: 'output',
          kind: mediaKind(entry.name),
          path: full,
          bytes: info?.size ?? 0,
          modified: info?.mtimeMs ?? 0,
        })
      }
    }
    await walk(dir, 0)
    return out.sort((a, b) => b.modified - a.modified).slice(0, limit)
  }
}
