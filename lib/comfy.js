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
  async waitForCompletion(promptId, options = {}) {
    const { pollIntervalMs, runTimeoutMs } = this.configOf()
    const startedAt = Date.now()
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > runTimeoutMs) throw new Error(`等待 ComfyUI 运行超时（${Math.round(runTimeoutMs / 1000)} 秒）：prompt_id=${promptId}。可以调 comfyui_status 看队列，或在 ComfyUI 界面里确认。`)
      let history
      try {
        history = await this.request(`/history/${encodeURIComponent(promptId)}`)
      } catch (error) {
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
      try {
        const queue = await this.queue()
        queueRemaining = (queue?.queue_pending?.length ?? 0) + (queue?.queue_running?.length ?? 0)
        running = (queue?.queue_running ?? []).some((item) => item?.[1] === promptId)
      } catch {}
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
    // 只允许读 ComfyUI 目录内或显式给出的绝对路径，避免被当成任意文件读取器
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
