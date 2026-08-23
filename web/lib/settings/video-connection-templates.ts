// Preset connection templates for the videogen settings form (roadmap C7).
//
// Pure data + types: no side effects, no imports. The settings editor offers
// these as "Fill from template" so a brand-new user starts from a working
// endpoint instead of an empty form. A template fills the base URL, the
// per-model protocol (adapter) and appends recommended model rows — the API
// key is deliberately never filled; credentials are the user's own.
//
// `adapter` must mirror VIDEOGEN_ADAPTERS in
// knorvia/services/config/provider_runtime.py. Kling / Wan / Hailuo templates
// use their dedicated adapters (roadmap C2/C3: kling_async_task,
// wan_async_task, hailuo_async_task); SiliconFlow intentionally stays on the
// generic "async_task" protocol because its video models run behind its own
// submit/poll task API without a vendor-specific payload shape worth a
// dedicated adapter.
// `presetId`, when set, references a capability preset from
// knorvia/services/video_studio/capability_presets.py and is applied only if
// that preset is present in the list fetched from
// /api/v1/video-studio/capability-presets — no hard dependency on new ids.

export type VideoConnectionTemplate = {
  id: string
  /** Display name shown in the template dropdown. */
  label: string
  /** Protocol/adapter key — must exist in backend VIDEOGEN_ADAPTERS. */
  adapter: string
  baseUrl: string
  /** Short per-provider credential guide, localized inline. */
  authGuide: { en: string; zh: string }
  models: Array<{ modelId: string; label: string; presetId?: string }>
}

export const VIDEO_CONNECTION_TEMPLATES: VideoConnectionTemplate[] = [
  {
    id: 'volcengine-ark',
    label: 'Volcengine Ark (Seedance)',
    adapter: 'volcengine_async_task',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authGuide: {
      en: 'Create an API key in the Volcengine Ark console (API Key Management) and paste it below; requests are sent as a Bearer token straight to Ark.',
      zh: '在火山方舟控制台「API Key 管理」创建密钥并粘贴到下方；请求将以 Bearer Token 直连方舟。',
    },
    models: [
      {
        modelId: 'doubao-seedance-1-0-pro-250528',
        label: 'Seedance 1.0 Pro',
        presetId: 'seedance-standard-like',
      },
      {
        modelId: 'doubao-seedance-1-0-lite-250428',
        label: 'Seedance 1.0 Lite',
        presetId: 'seedance-mini-like',
      },
    ],
  },
  {
    id: 'kling',
    label: 'Kling AI',
    adapter: 'kling_async_task',
    baseUrl: 'https://api.klingai.com',
    authGuide: {
      en: 'Create an app on the Kling open platform for an Access Key + Secret Key pair and paste them below as "ak:sk"; every request is JWT-signed by the dedicated Kling adapter.',
      zh: '在可灵开放平台创建应用获取 Access Key / Secret Key，并以「ak:sk」格式粘贴到下方；可灵专用适配器会对每个请求做 JWT 签名。',
    },
    models: [
      { modelId: 'kling-v2-master', label: 'Kling V2 Master', presetId: 'kling-2.x-like' },
      { modelId: 'kling-v1-6', label: 'Kling V1.6', presetId: 'kling-2.x-like' },
    ],
  },
  {
    id: 'dashscope-wan',
    label: 'Alibaba DashScope (Wan)',
    adapter: 'wan_async_task',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    authGuide: {
      en: 'Create a DashScope API key in the Alibaba Cloud Bailian console and paste it below; the dedicated Wan adapter submits and polls DashScope tasks with a Bearer token.',
      zh: '在阿里云百炼控制台创建 DashScope API Key 并粘贴到下方；万相专用适配器以 Bearer Token 提交并轮询 DashScope 任务。',
    },
    models: [
      { modelId: 'wan2.5-t2v-preview', label: 'Wan 2.5 Text-to-Video', presetId: 'wan-2.x-like' },
      { modelId: 'wan2.5-i2v-preview', label: 'Wan 2.5 Image-to-Video', presetId: 'wan-2.x-like' },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax (Hailuo)',
    adapter: 'hailuo_async_task',
    baseUrl: 'https://api.minimax.chat/v1',
    authGuide: {
      en: 'Create a MiniMax API key in the MiniMax open platform console and paste it below; the dedicated Hailuo adapter drives the multi-reference submit/poll API, and the Hailuo H3 row applies the H3 capability preset.',
      zh: '在 MiniMax 开放平台控制台创建 API Key 并粘贴到下方；海螺专用适配器驱动多参考提交/轮询接口，海螺 H3 推荐行会自动套用 H3 能力预设。',
    },
    models: [
      { modelId: 'MiniMax-Hailuo-02', label: 'Hailuo 02' },
      { modelId: 'MiniMax-Hailuo-H3', label: 'Hailuo H3', presetId: 'hailuo-h3-like' },
    ],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    // SiliconFlow video models run behind its own submit/poll task API with a
    // plain payload shape, so the generic asynchronous-task protocol suffices.
    adapter: 'async_task',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authGuide: {
      en: 'Create a SiliconFlow API key in the SiliconFlow cloud console and paste it below; video models run behind its asynchronous submit/poll API with Bearer auth.',
      zh: '在硅基流动云控制台创建 API Key 并粘贴到下方；视频模型走其异步提交/轮询接口，使用 Bearer 鉴权。',
    },
    models: [
      { modelId: 'Wan-AI/Wan2.2-T2V-A14B', label: 'Wan 2.2 T2V' },
      { modelId: 'Wan-AI/Wan2.1-T2V-14B', label: 'Wan 2.1 T2V' },
    ],
  },
]
