# 语音识别阶段交付记录

日期：2026-11-15。范围：复用火山录音文件识别，保留本地 ASR 为可选兜底；不推进 LLM 高光升级或后续阶段。

## 已实现

- `asr-service.ts` 独立管理通道选择，与文本网关凭据解耦。
- 默认 `ASR_PROVIDER=auto`、`ASR_LOCAL_FALLBACK=0`：火山为主，不隐式调用本地。
- 显式开启 `ASR_LOCAL_FALLBACK=1`：火山未配置/失败时尝试本地；保留火山错误与实际来源。
- `ASR_PROVIDER=whisper` 手动本地，`ASR_PROVIDER=volc` 固定火山主通道，仍遵循兜底开关。
- 删除占位转写与通过文本网关调用 ASR 的路径。旧 `off/local/openai` 模式明确报错。
- 本地 Python Whisper 与 whisper.cpp 独立命令及 JSON 格式适配。cpp 需准备可执行文件与模型文件路径。
- 火山 HTTP 请求超时；鉴权错误不重试；并发任务结束后再清理临时文件。
- 部分失败不缓存为完整成功，避免重试读到永久缺失结果。重试目前会重新处理全片，不是只补缺失分片。
- 修复按整数秒舍入导致分片末尾不足一秒内容丢失的问题。
- 分析任务保存来源、兜底标记和警告；音轨/ASR 失败停止下游高光；重分析清空旧逐字稿与候选，已有剪辑保留。
- 侧边栏显示配置探测而非假定线上可用；`.env.example` 和 README 已同步。

## 已验证

- 自动化测试：16 项通过，0 失败、50 个断言。使用隔离通道、本地 HTTP 服务和测试 CLI，仅用于协议及错误处理验证，不冒充线上识别。
- 覆盖火山优先、显式兜底、双通道失败、手动本地、缺凭据、空结果、无效输入、缓存、轮询、HTTP 超时、401 鉴权、限流重试、部分失败重试、分片时间偏移、Python/cpp 协议。
- 后端 TypeScript 检查通过：`apps/web/node_modules/.bin/tsc --noEmit -p apps/server/tsconfig.json`。
- 前端构建通过：`bun run build`。
- API `/api/health` 返回 200；FFmpeg 可用。本机火山未配置、本地命令存在但兜底关闭，正确返回 `asrMode=unavailable`。
- 真实本地推理：对已有项目音频前 8 秒，通过 FFmpeg 切出临时 WAV，Python Whisper small 完成推理，返回 3 条时间戳字幕，耗时约 17.3 秒。临时音频已清理，未改写已有项目数据；未做人工准确率打分。

## 尚未完成的验收与限制

- 未配置 `VOLC_APP_ID` 和 `VOLC_ACCESS_TOKEN`，没有进行火山线上鉴权、识别质量、耗时和计费验收。
- 本机没有 whisper-cli，cpp 仅完成参数和 JSON 协议测试，未验证实际模型推理。
- 未进行浏览器完整分析流程的人工验收。
- 字幕细分依然按文本长度分配时间，不等同于词级强制对齐。
- 部分转写成功会保留真实结果并警告，缺失区间不会生成占位字幕；高光只依据已有文本。
- 持久化工作流、断点恢复和任务取消完善不属于本次阶段。

## 下一步

将真实火山凭据写入根目录 `.env`（不要提交版本库）。先运行凭据自检，再用一段已知原文的真实音频和一条较长视频做线上及页面验收。

```sh
cd apps/server
bun run scripts/verify-volc-asr.ts /absolute/path/to/audio.wav
bun test
```

验收结果确认前，不进入高光模型等下一阶段。

## 新版 API Key 接入与线上验证补充

- 官方文档确认新版语音服务使用 `X-Api-Key`，2.0 资源 ID 为 `volc.seedasr.auc`；旧版 AppID/Access Token 仍兼容。
- 已增加 `VOLC_API_KEY` 支持并优先使用新版鉴权；凭据保存在忽略提交的根目录 `.env`，不记录在本报告中。
- 已支持提交响应中的 `task_id` 作为查询 ID，未返回时兼容旧版请求 ID。
- 已通过现有服务链路对项目已有音频前 8 秒执行真实火山识别：关闭缓存、本地兜底与自动重试，约 2.04 秒返回 3 条带时间戳字幕，来源 `volc`。
- 这验证了鉴权、音频提交、轮询和分句解析；短样本耗时不代表长视频处理速度，也未完成长视频、页面及准确率验收。
- 新增 API Key 请求头及 task_id 协议测试后，自动化测试 17 项通过、0 失败，后端 TypeScript 检查通过。
- 本节更新前文“尚未配置火山凭据”的状态；浏览器验收及 whisper.cpp 真实推理限制仍然存在。
- 官方文档：https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=zh
