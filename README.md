# AI 智能切片

长视频 → AI 高光识别 → 人工精修 → 固定包框适配 → 批量导出 MP4。

深色创作工作台（黑底 + 荧光绿），6 页主流程，真实 ffmpeg 渲染。

---

## 快速开始

```bash
bun install                       # 根目录
cd apps/web && bun install
cd ../server && bun install

cd ../.. && bun run dev           # 同时启动 web(5180) + api(8788)
```

打开 http://localhost:5180

### 依赖

| 依赖 | 用途 | 检查 |
| --- | --- | --- |
| Bun ≥ 1.4 | 运行时 / 后端 | `bun -v` |
| ffmpeg + ffprobe | 探测、抽帧、渲染 | `ffprobe -version` |
| zip 或 ditto | 打包下载 | macOS 自带 |

侧边栏显示 FFmpeg 与模型配置探测状态；配置存在不等于线上模型调用已验证，实际结果以分析任务为准。

---

## 云端 AI 接入（可选）

语音识别与高光推荐独立配置。语音识别仅使用火山或本地 Whisper，不再复用文本网关。

### 语音转写：字节火山引擎 ASR

```bash
# 放在项目根目录的 .env，服务启动自动读取
VOLC_API_KEY=语音控制台的APIKey
VOLC_RESOURCE_ID=volc.seedasr.auc
```

走「录音文件识别·大模型」接口。实现要点：

- **长音频自动分片**：默认每 10 分钟一片（`VOLC_CHUNK_SECONDS`），2 小时视频约 12 片
- **时间戳回拼**：每片结果按片起始时间偏移，合并后仍是整片绝对时间
- **限并发**：默认 2 路（`VOLC_CONCURRENCY`），避免触发账号并发上限
- **异步轮询**：提交后轮询 query 接口，单次超时可调（`VOLC_POLL_TIMEOUT_MS`）
- **单片重试**：限流、网络抖动类错误按指数退避自动重试（`VOLC_RETRY_ATTEMPTS`），鉴权类错误不重试
- **部分成功保留**：个别分片最终失败时，其余分片结果照常保留，任务卡明确列出失败片号
- **句级细分**：ASR 返回的长句按标点切成字幕级片段，时间按字数比例重分配
- **边界去重**：分片切断句子时，接缝处重复的半句会被识别并合并
- **结果缓存**：同一段音频重复分析不重复计费，`ASR_CACHE=0` 可关闭
- **失败可见**：火山报错带状态码与中文原因写进任务卡；默认停止分析，显式开启本地兜底后才切换 Whisper
- **不生成占位字幕**：缺少音轨、凭据、有效识别结果或两个通道均失败时，停止高光分析

### 双语高光推荐：独立文本模型

```dotenv
HIGHLIGHT_API_KEY=文本模型的APIKey
HIGHLIGHT_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
HIGHLIGHT_MODEL=qwen-plus
```

兼容旧 `OPENAI_API_KEY / OPENAI_BASE_URL / CHAT_MODEL` 配置，但不使用火山语音 API Key。
未配置时会保留真实逐字稿并明确报错，不再静默以关键词规则冒充 AI 推荐。
配置后可在高光筛选页“重新生成”复用逐字稿，不重复调用 ASR。

处理流程：原语言 ASR → 中文翻译 → 独立文本复核 → 分段理解与召回 → 按用途联网搜索 → 可选候选原音频复听 → 五维全局复评 → 切点与原文校验。
原文始终保留，中文用于理解与审核，默认导出仍使用原文字幕。译文 reviewed 仅代表文字对照，不保证 ASR 或事实完全正确。

可选工具在 `.env.example` 中配置：

- `TAVILY_API_KEY`：通用联网检索，分别用于新闻、术语、背景和关键事实；只有新闻限定近期。
- `AUDIO_REVIEW_API_KEY / AUDIO_REVIEW_BASE_URL / AUDIO_REVIEW_MODEL`：Qwen-Omni 兼容原音频理解；每次最多5条、每条120秒，未配置不推断真实声音情绪。

搜索仅保留结果摘录和来源，当前不声称已完成原网页全文核实；关键词和文字反问只作文本线索。
完整规格见 `docs/highlight-recommendation-spec.md`，测试运行 `cd apps/server && bun test`。

新版使用 `VOLC_API_KEY`（X-Api-Key）；旧版 `VOLC_APP_ID` + `VOLC_ACCESS_TOKEN` 仍兼容。通用 AK/SK 不适用。

### 先自检凭据

拿到语音 API Key（或旧版 AppID / Access Token）后，可以先不进应用，直接验一条：

```bash
cd apps/server
bun run scripts/verify-volc-asr.ts                    # 只验鉴权和连通性
bun run scripts/verify-volc-asr.ts 你的音频.wav        # 顺便验识别质量
```

脚本会打印凭据掩码（不会泄露完整 token）、调用的 endpoint、耗时和识别结果。
鉴权失败会直接告诉你是 AppID/Token 的问题，而不是含糊的「调用失败」。

注意火山的鉴权失败返回 **HTTP 401 配 45000010 状态码**（`load grant: requested grant not found`），
不是常见的 55000001，所以判断时要先看 HTTP 状态再看业务码。

### 本地 ASR 可选兜底

默认 `ASR_PROVIDER=auto`、`ASR_LOCAL_FALLBACK=0`：使用火山，失败时明确报错。

```dotenv
# 自动兜底：火山未配置或失败时，尝试本地 Whisper
ASR_PROVIDER=auto
ASR_LOCAL_FALLBACK=1
LOCAL_WHISPER_BACKEND=python
LOCAL_WHISPER_BIN=whisper
LOCAL_WHISPER_MODEL=small
LOCAL_WHISPER_LANG=zh
```

`ASR_PROVIDER=volc` 固定火山为主通道（仍遵守兜底开关）；`ASR_PROVIDER=whisper` 手动选择本地识别。
本地 Python Whisper 需要事先准备好模型；首次执行可能下载模型，不能将“命令存在”等同于“推理已就绪”。

whisper.cpp 独立配置如下，不能使用 Python 的模型名称替代模型文件路径：

```dotenv
ASR_PROVIDER=whisper
LOCAL_WHISPER_BACKEND=cpp
LOCAL_WHISPER_BIN=whisper-cli
LOCAL_WHISPER_MODEL=/absolute/path/to/ggml-small.bin
```

只接受 `auto / volc / whisper`，旧的 `openai / local / off` 配置会明确报错，不再产生演示文本。
识别来源及兜底原因记录在分析任务中，部分分片缺失会显示警告；不缓存部分成功结果。
侧边栏只显示配置探测状态，不代表已完成线上鉴权或模型推理验证。

| 语音识别 | 高光推荐 | 效果 |
| --- | --- | --- |
| 火山或本地 Whisper | 未配置文本模型 | 保留真实原文，提示配置模型；可手动框选 |
| 火山或本地 Whisper | 已配置文本模型 | 真实字幕 + 大模型推荐 |
| 无可用真实识别通道 | 任意 | 分析失败，显示原因，不生成占位字幕或高光 |

运行 ASR 测试：`cd apps/server && bun test`。
测试中的替代通道和本地 HTTP 响应仅用于验证错误、切换与协议，不代表线上模型质量验收。

---

## 架构

```
apps/
  server/            Bun + Hono，端口 8788
    src/index.ts     全部 API 路由
    src/ffmpeg.ts    ffprobe 探测、抽帧、renderClip 渲染管线
    src/ai.ts        兼容入口与配置探测
    src/highlights/  翻译、复核、模型、联网工具、音频工具、五维评分工作流
    src/asr-service.ts 火山主通道与可选本地兜底编排
    src/asr.ts       火山录音文件识别、分片与缓存
    src/asr-local.ts Python Whisper / whisper.cpp 适配
    src/subtitles.ts Canvas 生成字幕透明 PNG（不依赖 libass）
    src/store.ts     SQLite 事务持久化（旧 JSON 自动备份迁移）
    data/            uploads / outputs / app.sqlite / backups（运行时生成）
  web/               Vite + React 18 + React Router，端口 5180
    src/pages/       6 个主页面 + 列表页
    src/ui/          design system（icons / kit / toast）
    src/styles.css   design tokens
```

前端 `/api` 与 `/files` 通过 Vite proxy 转发到 8788。

---

## 首页（创作入口）

`/` 是独立的创作首页，不带后台侧边栏：

- 深色底 + 柔和紫色光晕，居中大标题（关键词渐变），下方精选案例
- 中央大圆角面板：上传长视频 / 粘贴链接 双 Tab
- 上传后显示**真实缩略图**（ffmpeg 抽帧）、文件名、时长、分辨率、体积
- 底部三枚紧凑胶囊：切片时长 · 画面比例 · 切片数量，右下角「开始智能切片」
- 包框模板横向选择器，默认沿用上次使用（localStorage + 服务端 lastUsedAt）
- 切换画面比例时实时做**包框适配校验**，方向不一致直接禁用开始按钮并给出建议

`/dashboard` 保留原侧边栏工作台视图。

### 画面比例

| id | 名称 | 输出尺寸（1080P 档） |
| --- | --- | --- |
| fit | 适应包框 | 沿用模板画布 |
| 16:9 / 4:3 / 2.35:1 / 2:1 / 1.85:1 | 横屏族 | 1920×1080 / 1440×1080 / 2538×1080 / 2160×1080 / 1998×1080 |
| 9:16 / 3:4 / 1:2 | 竖屏族 | 1080×1920 / 1080×1440 / 1080×2160 |
| **5.8** | 5.8 寸 | **1170×2532**（手机屏幕主流规格） |
| 1:1 | 方形 | 1080×1080 |

下拉里每项都有按真实宽高比绘制的示意图。720P / 1440P 档按长边等比缩放，尺寸统一取偶数（H.264 要求）。

### 切片时长 / 数量

- 时长默认 **30 秒 ～ 2 分钟**，提供 5 个预设 + 自定义输入，上限受视频实际时长约束
- 数量默认 **AI 智能推荐**（`desiredCount: 0`），服务端按
  `理论可切条数 = 总时长 / 单条中位时长`，取其中 30% 作为高光预估，限制在 1–20
- 也可直接选 3/5/8/10/15/20 条
- 实际产出少于目标时不算失败，会在任务卡里说明「素材里符合该区间的完整片段只有这么多」

---

## 六页流程

| 页 | 路由 | 能力 |
| --- | --- | --- |
| 首页 | `/` | 上传/链接导入、缩略图、三项创作参数、包框选择与适配校验 |
| P2 分析 | `/projects/:id/analyzing` | 4 个真实子任务（音轨/转写/抽帧/高光），真实进度、失败重试、可取消 |
| P3 筛选 | `/projects/:id/highlights` | 高光条 + 逐字稿联动、预览、多选、手动框选、重新生成 |
| P4 剪辑 | `/projects/:id/editor/:clipId` | 三栏 + 四轨时间轴、拖动裁剪、字幕逐句编辑、素材替换、AI 指令、撤销 |
| P5 成片 | `/projects/:id/review` | 包框实时预览、缩放/偏移、封面抽帧或上传、标题样式、批量应用 |
| P6 导出 | `/projects/:id/export` | 比例/清晰度/字幕/封面配置、逐条进度、单条重试、打包下载 |

## 数据模型要点

- 时间单位统一 **毫秒**，UI 显示 `mm:ss`。
- `FrameTemplate` 的 `coverFrameUrl` 与 `bodyFrameUrl` 独立存储，服务端强制校验两者都存在。
- `Clip.subtitles` 随裁剪自动平移；`Clip.replacements` 用**片段内相对时间**。
- 每次剪辑动作都写入 `Clip.operations`（含 `payload` 与 `applied`），撤销是回放而非删除。
- 单条片段的 `transform` 覆盖模板默认值，不改模板本身。

---

## 渲染管线（renderClip）

```
输入片段 -ss/-t 裁切
  → scale+crop 适配模板 videoViewport
  → overlay 素材替换（按 enable 区间，可保留原声）
  → pad 到画布（黑底）
  → overlay 字幕 PNG（Canvas 生成，逐条 enable）
  → overlay 首屏封面（可配时长）
  → overlay 包框透明 PNG
  → libx264 + aac, yuv420p, faststart
```

字幕不用 `subtitles`/`drawtext` 滤镜，因此在**没有 libass 的 ffmpeg** 上也能烧录。

---

## 已知边界

| 项 | 状态 |
| --- | --- |
| 网络素材搜索 | 标记「即将支持」，不伪造结果 |
| AI 对话指令 | 支持：开头/结尾 ±N 秒、时长改为 N 秒、删除第 N 句字幕；无法识别时返回支持列表，不假装成功 |
| 平台发布 | 不做，产品终点是本地 MP4 |
| 手机端编辑 | 不做，首版桌面优先 |

---

## 验收清单

- [x] 双包框分别上传、缺一报错、保存后可复用
- [x] 分析四任务真实执行，进度真实
- [x] 高光推荐理由具体、可追溯到时间戳
- [x] 裁剪手柄可拖动，越界被拒绝
- [x] 字幕随裁剪平移，逐句可改
- [x] 素材替换保留原声、只影响指定区间
- [x] 包框导出真实生效（视频落在框内区域）
- [x] 字幕烧录到底部安全区
- [x] 首屏封面可配时长
- [x] 批量导出 MP4 可播放、可单独下载封面


## AI 剪辑模块第一阶段

已接入统一 EditPlan、多保留区间、源片/成片时间映射、精确撤销/重做、四频道品牌绑定和模板快照。旧 Clip 在读取时兼容转换，实际编辑时保存新版计划。

- 新任务先选择频道并确认封面、正文包框；既有项目在品牌页补充确认。
- 剪辑页「删除本句音画」删除整句对应区间；「撤销/重做」恢复完整字幕和素材。
- 品牌页「保存并生成成片预览」通过正式 FFmpeg 管线生成代理文件；页面示意图只用于调整参数。
- 预览及正式导出固定编辑/模板快照；继续修改后需要重新生成预览和新导出任务。失败重试仍使用原任务快照。
- B-roll 始终保留原口播。未接入 VAD、词级对齐前，不允许把字幕中间一小段当作已精确对齐的语音删除。

首次访问数据时将旧 `projects/templates/exports/assets.json` 备份到 `apps/server/data/backups/json-*/`，校验后在事务中导入 SQLite。旧 JSON 保留但不再更新，后续以数据库为准，不能靠修改旧 JSON 修改项目。运行中的导出在重启后明确标为失败、可重试；未开始的排队任务恢复执行。SQLite 与备份目录不通过 `/files` 提供访问。

完整交付和验收边界见 [第一阶段报告](docs/editing-stage-1-report.md)。后续阶段须确认后推进。


## 中文文字包装

成片确认页右侧可生成当前/全部片段的中文字幕及三组配对标题。复用已有译文，缺失才补译复核；原字幕保留供对照，原声不变。封面与正文标题分别编辑，字体、断句、高亮和位置可调整；文字样式支持批量应用而不复制各片文本。保存后更新真实成片预览，再导出。详见 [交付报告](docs/chinese-packaging-stage-report.md)。
