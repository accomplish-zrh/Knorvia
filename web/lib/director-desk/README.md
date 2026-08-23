# 白模预演（White-model Previs）— 移植说明

本目录是从 AIPAI（`AIPAI-Code`）的 `resources/director-desk` **逆向并移植**到 Knorvia
视频工作台的白模预演模块。内部仍保留 `DirectorDesk` 技术命名以兼容既有协议。预演台是一个自包含的 **React + Three.js** 静态 Web 应用，
通过 `window.postMessage` 暴露一套「二创接口」协议，供宿主（视频工作台）嵌入驱动。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `web/public/director-desk/` | 导演台静态构建（index.html + assets + models + local-assets） |
| `web/director-desk-src/` | 白模预演 React / Three.js 可维护源码（保留上游 MIT 许可） |
| `web/scripts/build-director-desk.mjs` | 构建源码并发布到 `web/public/director-desk/` |
| `web/lib/director-desk/protocol.ts` | 逆向得到的 postMessage 协议类型与常量 |
| `web/lib/director-desk/client.ts` | 宿主侧桥接器 `DirectorDeskClient`（request↔response 关联、ready 检测、截图订阅） |
| `web/lib/director-desk/use-director-desk.ts` | React hook（iframe + 客户端生命周期） |
| `web/lib/director-desk/camera-mapping.ts` | 导演台机位 → storyboard shot 的宽容映射（短运镜词 + 完整机位原文） |
| `web/components/video-studio/DirectorDeskPanel.tsx` | 集成面板（导出/上传/关键帧/工程 JSON/全景注入） |

修改白模预演后，在 `web/` 目录运行 `npm run build:previs`。不要直接编辑
`public/director-desk/assets` 中的压缩文件。

## 协议（逆向自 `director-desk/assets/main-*.js`）

### 嵌入 URL 参数

- `instanceId` — 作用域会话标识（每个工程一个，切换工程即换场景）
- `hostOrigin` — 允许回传消息的源（`"null"` → 通配 `*`）
- `theme` — `light | dark`
- `transport` — `tauri`（走 `window.__TAURI__.event`）或默认 postMessage

### 消息

| 方向 | type | payload |
| --- | --- | --- |
| 宿主 → 导演台 | `storyai:director-desk-session` | `{ instanceId, theme? }` 开会话 |
| 宿主 → 导演台 | `storyai:director-desk-panorama` | `{ edgeId, sourceNodeId, imageUrl, fileName }` 注入等距柱状全景 |
| 宿主 → 导演台 | `storyai:director-desk:request` | `{ requestId, action, options? }` RPC |
| 导演台 → 宿主 | `storyai:director-desk-ready` | — 挂载完成 |
| 导演台 → 宿主 | `storyai:director-desk:response` | `{ protocolVersion, requestId, action, ok, data? | error? }` |
| 导演台 → 宿主 | `storyai:director-desk-captures-sent` | `{ captures: [{ dataUrl, fileName }] }` 多方位截图 |

### RPC 动作

| action | options | 返回 `data` |
| --- | --- | --- |
| `capabilities.get` | — | `{ protocolVersion, projectSchemaVersion, actions, uiExports, protocolExports, assetPersistence }` |
| `project.get` | — | `{ projectFingerprint, project, portability }`（含机位/运镜数据） |
| `timeline.get` | — | `{ progress, timeSeconds, durationSeconds, playing, viewMode, activeCameraId }` |
| `export.frame` | `{ fileName?, position?, quality? }` | `{ dataUrl, fileName, position, progress, width, height }`（PNG） |
| `export.video` | `{ fileName?, fps?, quality? }` | `{ blob?, dataUrl?, fileName }`（MP4 参考视频） |
| `plugin.result.submit` | `{ result }` | 保存插件结果（如镜头建议），返回含 `id`/`stale` 的结果 |
| `plugin.results.list` | — | 插件结果列表 |

## 与视频工作台的联动

`DirectorDeskPanel` 被 `video-studio/page.tsx` 作为第三个视图模式（`director`）渲染：

1. **导出当前帧** → 下载 PNG，并可「上传为项目资产」或「设为当前选中镜头的关键帧」
   （`keyframe_asset_id`，复用 `saveVideoStoryboard` 的 CAS 保存链）。
2. **导出参考视频** → 下载 MP4，并可「上传为项目资产」（进入合成/时间轴素材池）。
3. **导出工程 JSON** → `project.get` 下载含机位与运镜数据的完整工程。
4. **注入全景** → 把选中角色的参考图以等距柱状全景注入导演台作为场景背景。
5. **实时监看** → 轮询 `timeline.get` 显示运镜进度 / 播放态 / 时间。
6. **多方位截图** → 导演台推送 `captures-sent` 后，面板把截图列出，可逐张上传或直接设为当前镜头关键帧。
7. **一键关键帧** → 选中镜头后，可跳过「下载 → 上传 → 绑定」三步，直接导出当前帧并绑定。
8. **加载兜底** → 30 秒未完成握手显示重载入口；切换工程会清理上一场导出的帧/视频与截图。
9. **工程持久化** → 就绪后每 20 秒比较 `projectFingerprint`，变化时通过
   `PUT /api/v1/video-studio/projects/{id}/director-desk` 把完整 `project.get`
   文档写入项目行；项目 ZIP 导出会随 `manifest.json` 带走该快照。
10. **机位 → 分镜** → 面板读取 `project.cameras`，可把单个机位应用到当前选中镜头，
    或按顺序同步全部机位到分镜（已有镜头覆盖，多出的追加）。
    宽容映射结果写入 `camera` + `director_camera_id` + `director_camera_json`。

## 素材来源与许可

> 当前逆向协议未发现 `project.set` / `timeline.set`。因此上述持久化用于备份、项目 ZIP
> 迁移和机位映射；场景回灌 iframe 暂不做，避免伪造不存在的协议动作。

素材库保留原始许可证文件：

- `local-assets/mixamo/SOURCES.md` — Mixamo 兼容人物/动作来源（GitHub 链接）
- `local-assets/guo-3d-assets/*/README.md`、`manifest.json` — guo-3d 骨骼人物/道具/场景预设
- `models/ue-mannequin-retopology.license.txt` — 默认人体模型许可

这些素材仅用于导演台本地内置人物/道具/动作预览。

## 移植时对构建产物做的唯一修改

`index-CrP06vEF.js` 内联了模型/道具清单，其中 434 处素材 URL 使用**根绝对路径**
`"/guo-3d-assets/..."`（AIPAI Electron 宿主在站点根挂载了该目录）。移植到
`/director-desk/` 子路径后，统一改写为相对路径 `"./local-assets/guo-3d-assets/..."`：

```js
// 前: "modelUrl":"/guo-3d-assets/guo-skeleton-models/models/0024_....fbx"
// 后: "modelUrl":"./local-assets/guo-3d-assets/guo-skeleton-models/models/0024_....fbx"
```

其余素材（mixamo、默认人体模型、基准全景）在构建产物里本就使用 `./` 相对路径，无需改动。
