/**
 * 插件入口。
 *
 * 为什么存在：把「配置 → ComfyUI 客户端 → 工具注册」三段接起来，
 * 并保证所有注册都挂在 cordis 的 fiber 上（插件卸载时干净收回）。
 *
 * 设计取舍：
 *  - 不做客户端 bundle：图片回显走 host 的 attachment ContentBlock，
 *    不需要自定义 toolview，省掉 tsdown / ModuleLoader / slots 一整套复杂度；
 *  - 不注册 settings 服务：配置写在 profile 的 cordis.patch.yml 里，
 *    改完重启 DSH 生效（设置页对「本地 ComfyUI 路径」这类一次性配置并不划算）；
 *  - tools 用 ctx.inject(['tools'], cb) 拿，不放进 `inject`——
 *    在无 tools 服务的宿主上优雅跳过而不是 boot 期炸掉。
 */

import z from '@deepseek-ai/schemastery'
import { ComfyClient } from './comfy.js'
import { registerComfyUITools } from './tools.js'

export const name = 'comfyui-agent'

export const Config = z.object({
  /** ComfyUI 服务地址（绘世启动器默认 127.0.0.1:8188）。 */
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  /** 本机 ComfyUI 本体目录（含 output/ input/ user/ 的那一层）。 */
  comfyuiDir: z.string().default('E:\\ComfyUI\\ComfyUI'),
  /** 画布工作流目录，留空自动用 `<comfyuiDir>/user/default/workflows`。 */
  workflowsDir: z.string().default(''),
  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs: z.number().default(120000),
  /** 等待运行结果时的轮询间隔（毫秒）。 */
  pollIntervalMs: z.number().default(1200),
  /** 一次运行最多等多久（毫秒），视频工作流请调大或给 wait:false。 */
  runTimeoutMs: z.number().default(1800000),
  /** 工具调用本身允许跑多久（毫秒），要大于 runTimeoutMs + 取图时间。 */
  toolTimeoutMs: z.number().default(2400000),
})

/**
 * 插件主体。
 * @param {any} ctx - cordis 上下文。
 * @param {any} config - 已按 Config 归一化的配置。
 * @returns {void} 无。
 */
export function apply(ctx, config) {
  /**
   * 现读配置：每次访问都重新组装，配置被热改时立即生效。
   * 两个超时是分开的——单次 HTTP 请求（requestTimeoutMs）与等一次运行跑完（runTimeoutMs）。
   */
  const resolve = () => ({
    baseUrl: String(config?.baseUrl ?? 'http://127.0.0.1:8188'),
    comfyuiDir: String(config?.comfyuiDir ?? 'E:\\ComfyUI\\ComfyUI'),
    workflowsDir: String(config?.workflowsDir ?? ''),
    requestTimeoutMs: Number(config?.timeoutMs ?? 120000),
    pollIntervalMs: Number(config?.pollIntervalMs ?? 1200),
    runTimeoutMs: Number(config?.runTimeoutMs ?? 1800000),
  })

  const client = new ComfyClient(resolve)

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = registerComfyUITools(sctx, { client, config: resolve, toolTimeoutMs: Number(config?.toolTimeoutMs ?? 2400000) })
      ctx.logger?.info?.('comfyui-agent: 已注册 %d 个工具', disposers.length)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {}
        }
      }
    }, 'comfyui-agent tools')
  })
}
