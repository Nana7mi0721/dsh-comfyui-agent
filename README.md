# dsh-comfyui-agent

让 DeepSeek Harness 的 Agent 直接驱动你本机的 ComfyUI 干活：跑你画布里存好的工作流、用内置模板快速出图，产出的图片直接显示在对话里。

面向 **DSH 0.2.0-rc.2**（`@deepseek-ai/dsh-tools` 0.2.0-rc.2 / cordis 4.x）重写。社区的 `dsh-comfyui@0.5.4` 把 `@deepseek-ai/dsh-settings` 的 peer 范围锁在 `^0.1.x-alpha`，在 0.2.0-rc.2 上被判为不兼容（预发布版本号只匹配同一 x.y.z），这个插件只做那条主链路，不依赖 `dsh-settings`，因此可以直接装。

## 五个工具

| 工具 | 作用 |
| --- | --- |
| `comfyui_status` | 探活：ComfyUI 版本、队列长度、路径、可用模型清单。**先跑它**确认连得上 |
| `comfyui_nodes` | 搜节点类（`filter`）或查某个类的输入定义（`class`）。不确定某节点要什么输入时用它 |
| `comfyui_workflows` | 看你保存的画布工作流：`action:"list"` 列出名字/节点数/输出节点；`action:"params"` 列出**可调参数**（按节点分组，带取值范围）；`action:"get"` 打印完整 API 工作流（诊断用，很费 token） |
| `comfyui_run` | 真正跑图。三选一给 `file`（画布工作流名）/ `template`（`txt2img`、`img2img`）/ `workflow`（自己写的 API 工作流对象） |
| `comfyui_show` | `action:"latest"` 看最近产出（默认 6 张）、`action:"view"` 按文件名取、`action:"upload"` 把本地图片传进 ComfyUI 的 `input/`（img2img 要用） |

典型对话：

```
你：用 anima v2 那张画布出一张银发少女，然后把 step 改成 20 再出一张
Agent：comfyui_workflows {action:"params", name:"anima v2"}   → 看到节点 765:709 是 steps
       comfyui_run {file:"anima v2", inputs:{"765:709":{"value":12}}, savePrefix:"silver"}
       comfyui_run {file:"anima v2", inputs:{"765:709":{"value":20}}, savePrefix:"silver20"}
```

## 安装

装到 `~/.dsh/profiles/desktop`：

```bash
# 1) 打包
cd <这个目录>
npm pack --pack-destination dist   # 得到 dist/dsh-comfyui-agent-0.1.2.tgz

# 2) 装进 profile（desktop profile 只在应用运行时也能装，但装完必须重启）
node "/d/Program/deepseek harness desktop/resources/runtime/cli/bin/dsh.cmd" \
     plugin --profile desktop add <tgz 的绝对路径>

# 3) 确认 dsh.profile.bundles 里有 dsh-comfyui-agent（CLI 会自动加）
# 4) 重新启动 DSH 桌面端
```

装好后 `dsh plugin --profile desktop list` 里应能看到 `dsh-comfyui-agent@0.1.2`。

**换版本时注意**：`add` 之前如果旧版本的 tgz 已经被删掉，pnpm 会先解析旧依赖并报
`ENOENT: no such file or directory, open '...0.1.0.tgz'`；先
`dsh plugin --profile desktop remove dsh-comfyui-agent` 再 `add` 新 tgz 即可。

## 配置

安装时写进 `~/.dsh/profiles/desktop/cordis.patch.yml`（也可以事后改，改完重启）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址。ComfyUI 核心默认只听 `127.0.0.1`，换机器要加 `--listen` |
| `comfyuiDir` | `E:\ComfyUI\ComfyUI` | ComfyUI 本体目录（读 `output/`、`input/`、`user/default/workflows/`） |
| `workflowsDir` | 空 | 留空则用 `<comfyuiDir>/user/default/workflows` |
| `timeoutMs` | 120000 | 单次 HTTP 请求超时 |
| `pollIntervalMs` | 1200 | 等运行结果时的轮询间隔 |
| `runTimeoutMs` | 1800000 | 等一次运行跑完的上限（30 分钟） |
| `toolTimeoutMs` | 2400000 | 单个工具调用的上限（40 分钟） |

## 工作原理

- **浏览器不直连 ComfyUI**：所有请求都走 DSH 主进程（Node）→ `http://127.0.0.1:8188`。这样跨源/CORS、密钥下发、混合内容都不存在。ComfyUI 核心默认也没开 CORS，所以这条路径是必须的。
- **画布工作流（UI 格式）→ API 工作流**是核心难点，转换器在 `lib/graph.js`：
  - 按 `object_info` 的输入顺序对齐 `widgets_values`，被连线覆盖的输入以 `links` 为准；
  - 展开子图（`definitions.subgraphs`，内部节点 id 变成 `父id:子id`）；
  - 直通 `Reroute` / `mode:4`（bypass）/ `PrimitiveNode` / Set-Get 命名对；
  - 处理「动态 widget」：`AspectRatioAdvanced.ResolutionState`（一坨 JSON）、rgthree `Power Lora Loader` 的 `lora_N`、LoraManager 的 `loras`；
  - 展开后做**引用完整性检查**和**可达性剪枝**：只保留能回溯到输出节点的部分（ComfyUI 会校验 prompt 里每个节点的必填输入，散落的节点会让整次提交被拒）；
  - 转换结果里的 `warnings` / `skipped` 会附在工具回复里，不会静默丢参数。
- **出图回显**：产出文件经 `/view?filename=…&subfolder=…&type=…` 按文件寻址取回（不依赖 `/history`），用 `ctx.get('attachments').saveImage()` 存成会话附件，再以 attachment 引用回给模型。
- **超时分开**：`requestTimeoutMs` 管单次 HTTP，`runTimeoutMs` 管一次运行跑完。视频类工作流建议 `wait:false`（只提交），再用 `resume:"<prompt_id>"` 收结果。

## 行为细节（实测）

- **产出清单给的是本机绝对路径，且按 `type` 分目录**：`SaveImage` 落在 `ComfyUI/output/`，`PreviewImage` 落在 `ComfyUI/temp/`（不要一律按 output 拼，那样给出的路径打不开）。
- **同一张图只回显一次**：工作流里常见 `SaveImage` + `PreviewImage` 各写一份（如 `anima v2 ttp` 的 `#46` 与 `#896`），内容相同就合并报告，并注明「有 N 个产出与上面某张图内容完全相同」。判据是附件 id —— DSH 的附件库是**内容寻址**的，所以 id 相同即内容相同。
- **`params` 只喂内置模板**：`file` / `workflow` 运行时给 `params` 会得到一条明确提示（不静默忽略）；要改参数请用 `inputs` 按节点 id 覆盖，例如 `inputs:{"76":{"seed":123456}}`（节点 id 见 `comfyui_workflows { action:"params" }`）。`savePrefix` 同样只对 `txt2img` / `img2img` 生效。
- **`params.image` 容错**：`input:xxx.png` / `input：xxx.png`（全角冒号）/ `[input]xxx.png` / 带引号都会自动洗成 `xxx.png`；如果这张图不在 `ComfyUI/input/` 里，会**在提交前**报错并提示先用 `comfyui_show { action:"upload" }` 上传，而不是等 ComfyUI 回一句 `Invalid image file`。
- **种子照实回报**：`seed` 显式给了就是给了（`0` 也算给了），回报里的种子等于真正提交的值；`randomizeSeed:false` 时用画布工作流里存的种子。
- **回显上限**：默认最多把 4 张图带回对话（`maxImages` 可调）；超出时会在回复里说明「这次产出 N 张图，只回显了 M 张」并列出其余路径。
- **`resume` 的文案**：`comfyui_run { resume:"<prompt_id>" }` 不参与建图，回复渲染成「完成：resume（用时 X 秒）」，而不是「（0 个节点）」。

## 已知边界

- 本机 ComfyUI 0.35.1 + 48 个自定义节点包，实测 10 个画布工作流全部能转换成功（详见 `_research/`）。
- 纯前端节点（Note、Fast Muter、没有服务端实现的 rgthree 开关）会被跳过；它们**下游的连线**若因此断掉，会在 `warnings` 里说明。
- 只有连到输出节点的分支会参与运行；被 skip 的节点会列在回复里。
- 8 GB 显存（RTX 5060 Laptop）下别并发提交多个大工作流。
- ComfyUI 核心无鉴权，插件默认识别本机地址；要连局域网机器请自己确认网络可信。

## 排错

- `comfyui_status` 报连不上：确认 `绘世启动器` 已经点了「一键启动」，控制台里出现 `To see the GUI go to: http://127.0.0.1:8188`。
- 提交被拒并提示 `required_input_missing`：说明某个节点的必填输入没解析出来（常见于 bypass 链的中间节点），看工具回复里的 `warnings`，用 `comfyui_nodes {class:"…"}` 查该节点真正要什么输入。
- 找不到模型：`comfyui_status` 会列 `checkpoints`/`diffusion_models`/`text_encoders`/`vae`；本机没有 checkpoints，走的是 `UNETLoader + CLIPLoader + VAELoader` 路线。
- 工具没出现在对话里：看启动日志里有没有 `comfyui-agent: 已注册 5 个工具`。注册期抛错会让 5 个工具**全部**消失（cordis 只把这个插件标记为失败，不会影响其他插件）。

## 维护须知（改代码前必读）

DSH 0.2.0-rc.2 的 `@deepseek-ai/dsh-tools` 对工具定义做**严格校验**，两条规则踩了就全废：

1. **`output.schema` 的根节点不能有 `required`**（`items`、`oneOf` 分支同理）。
   只有「属性」节点才允许 `required: true`，它表示该属性在父对象里必填。
   违规原文：`JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL`（注册期抛，5 个工具全注册不上）。
2. **工具返回值必须是 lossless JSON**：对象里不能出现值为 `undefined` 的键。
   违规原文：`ToolOutputError: "value" must be a lossless JSON object`（每次调用都报错）。
   本插件在 `lib/tools.js` 用 `defineJsonTool()` 包住 `defineTool()`，返回前统一 `prune()` 掉 `undefined` 键。
   另外 `parameters` 本身是「属性表」（`{ filter: { type: 'string' } }`），不要再包一层 `{type:'object', properties:{…}}`。

改完**别只跑离线测试台**（它的 `dsh-tools` 是桩，不校验）。用真包验一遍：

```bash
mkdir -p /tmp/realtools && cd /tmp/realtools
npm i @deepseek-ai/dsh-tools@0.2.0-rc.2
mkdir -p node_modules/dsh-comfyui-agent
cp -r <这个目录>/lib <这个目录>/package.json node_modules/dsh-comfyui-agent/
node check.mjs   # 真 defineTool 注册 5 个工具
node run.mjs all # 真跑 execute + 真 validateJsonSchemaValue 校验返回值 + render
```

### 三条踩过的坑（别重新踩）

1. **不要对「自己刚提交的」`prompt_id` 做提交前硬判定。**
   ComfyUI 0.35.1 里，缓存全命中的任务约 10ms 就跑完：item 已从 `/queue` 弹出、`/history` 条目却还没落盘，
   这时两边都查不到。曾经用「先查存在性再轮询」的写法，导致**连续第二次同参运行**被误判成
   `找不到 prompt_id=…`。现在的做法是 `waitForCompletion(promptId, { assumeExists, graceChecks })`：
   严格判定只留给 `resume`（用户给的 id 可能是假的，要求秒失败）；自己提交的任务容忍连续 5 轮不可见后才报错。
2. **`/history` 条目的形状**（ComfyUI 0.35.1）：
   `{ [id]: { prompt: [number, id, promptDict, extra_data, outputs_to_execute], outputs, status, meta } }`，
   `status.status_str` 是 `success` / `error`，`status.messages` 是数组；
   `/queue` 则是 `{ queue_running: [[number, id, prompt, …]], queue_pending: [] }`。
   刚提交完立刻读 `/history` 拿到 `undefined` 是正常的（还没落盘/还在排队），要等运行结束再读。
3. **DSH 启动时把插件模块载入内存**：改 `node_modules` 里的文件不会热更，本会话的真工具调用仍在跑旧代码。
   验完 rig 要么重启 DSH，要么临时 `rm` + `cp` 同步安装副本再重启（同版本 tgz 无法靠 `pnpm install` 覆盖）。

### 测试台的语义局限

- 测试台里 `saveImage` 的替身用**原始 PNG 字节**算 sha，而真 DSH 的附件库是内容寻址（按归一化后的图算）。
  两个 PNG 哪怕像素相同，字节也可能不同（RGB vs RGBA、元数据、压缩级别），所以「同图去重」这条**在测试台里测不出来**，
  只能在真机上确认。
- 测试台从磁盘重新加载源码，所以它才是改完代码后立刻可用的验证途径（真 DSH 要重启）。

## 仓库结构

```
lib/                 插件源码（纯 ESM，无构建步骤）
  index.js           入口：配置 → ComfyUI 客户端 → 工具注册（挂在 cordis fiber 上）
  config.js          默认配置 / 路径推导
  tools.js           5 个工具的定义与执行
  comfy.js           ComfyUI HTTP 客户端（提交、轮询、取图、上传）
  graph.js           画布工作流（UI 格式）→ API 工作流转换器
  templates.js       内置 txt2img / img2img 模板
cordis.patch.yml     安装时插进 profile 的 patch（插件 id / name / config 默认值）
dist/*.tgz           npm pack 产物，可直接 `dsh plugin --profile desktop add` 安装
```

## 许可

MIT，见 [LICENSE](LICENSE)。
