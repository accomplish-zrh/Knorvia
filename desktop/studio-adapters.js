'use strict';

// Provider adapters for third-party media protocols (B11–B14). Each adapter
// maps Knorvia's single media-job lifecycle onto one official vendor API:
// Gemini/Veo long-running operations, Runway tasks, Replicate predictions.
// Adapters only translate request/response shapes; credential handling,
// redirects, size limits and usage normalization stay in studio-providers
// (which loads this module lazily). Everything is validated against local
// loopback fixtures — no paid API is contacted.

const asData = ref => ref && `data:${ref.mime};base64,${ref.bytes.toString('base64')}`;
const RUNWAY_DEFAULT_VERSION = '2024-11-06';
const RUNWAY_FAILED = new Set(['FAILED', 'CANCELLED']);
const REPLICATE_DONE = new Set(['succeeded', 'failed', 'canceled']);
const fail = message => { const error = new Error(message); error.rpc = { code: -32602, message }; throw error; };
const finiteUnit = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0;

// Gemini/Veo: instances[0] carries prompt and optional first-frame image;
// polling is a long-running operation, cancel is POST {name}:cancel.
const gemini = {
  inputCapabilities(p) {
    if (p.kind === 'image') return { maxReferences: 6, firstFrame: false, lastFrame: false, requiresFirstFrame: false, requiresLastFrame: false };
    return { maxReferences: 0, firstFrame: true, lastFrame: /^veo-3\.1/.test(p.model), requiresFirstFrame: false, requiresLastFrame: false };
  },
  async submit(p, input, refs, { request, signal }) {
    if (p.kind === 'image') {
      if (input.count !== 1) fail('Gemini 图片接口每个任务生成一张，请将数量设为 1');
      return { endpoint: `models/${encodeURIComponent(p.model)}:generateContent`, method: 'POST', body: { contents: [{ role: 'user', parts: [{ text: input.prompt }, ...refs.map(ref => ({ inlineData: { mimeType: ref.mime, data: ref.bytes.toString('base64') } }))] }], generationConfig: { ...p.extra, responseModalities: ['TEXT','IMAGE'], imageConfig: { ...(p.extra?.imageConfig??{}), aspectRatio: input.aspect } } } };
    }
    const first = refs.find(ref => ref.role === 'firstFrame');
    const last = refs.find(ref => ref.role === 'lastFrame');
    const endpoint = `models/${encodeURIComponent(p.model)}:predictLongRunning`;
    const body = {
      instances: [{ prompt: input.prompt, ...(first ? { image: { bytesBase64Encoded: first.bytes.toString('base64'), mimeType: first.mime } } : {}), ...(last ? { lastFrame: { bytesBase64Encoded: last.bytes.toString('base64'), mimeType: last.mime } } : {}) }],
      parameters: { ...p.extra, aspectRatio: input.aspect, durationSeconds: input.seconds },
    };
    return { endpoint, method: 'POST', body, headers: {} };
  },
  normalizeState(p, result, previous = {}) {
    if (p.kind === 'image') return { done: true, outputs: (result.candidates??[]).flatMap(c => c.content?.parts??[]).filter(part => part.inlineData?.data).map(part => ({ b64_json: part.inlineData.data })), metrics: result.usageMetadata };
    const name = result.name ?? previous.id;
    const samples = result.response?.generateVideoResponse?.generatedSamples ?? result.response?.generatedSamples ?? result.response?.generatedVideos ?? [];
    const outputs = samples.map(sample => sample?.video?.uri ?? sample?.uri).filter(Boolean).map(uri => new URL(uri, p.baseUrl).origin === new URL(p.baseUrl).origin ? { apiContent: uri } : uri);
    // Developer API has no documented remote cancellation for Veo. Stop
    // local tracking honestly; never invent an operation :cancel endpoint.
    return { id: name, statusUrl: name, done: result.done === true, failed: Boolean(result.error), outputs, progress: result.metadata?.progressPercent };
  },
  async poll(p, remote, { request, signal }) {
    return request(p, remote.statusUrl, { signal, headers: {} });
  },
  // Veo bills per generated second through the Google account; the
  // long-running operation payload carries no usage facts, so this stays
  // unknown rather than being estimated.
  normalizeUsage(p, remote) { if (p.kind !== 'image' || !remote.metrics) return undefined; return [['input_tokens','promptTokenCount'],['output_tokens','candidatesTokenCount']].filter(([,key]) => finiteUnit(remote.metrics[key])).map(([name,key]) => ({ name, value: Number(remote.metrics[key]) })); },
};

// Runway: separate image/text entrances, an explicit API version header,
// task polling with progress, DELETE-based cancellation.
const runway = {
  inputCapabilities(p) {
    return { maxReferences: 0, firstFrame: true, lastFrame: /^veo3\.1(?:_fast)?$/.test(p.model), requiresFirstFrame: /^gen4_turbo$/.test(p.model), requiresLastFrame: false };
  },
  async submit(p, input, refs, { request, signal }) {
    const first = refs.find(ref => ref.role === 'firstFrame');
    const last = refs.find(ref => ref.role === 'lastFrame');
    const endpoint = first || last ? 'image_to_video' : 'text_to_video';
    const ratio = ({ '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960', '4:3': '1104:832', '3:4': '832:1104', '21:9': '1584:672' })[input.aspect];
    if (!ratio) fail('Runway 不支持此画幅');
    if (/^veo3/.test(p.model) && (![4, 6, 8].includes(input.seconds) || !['16:9', '9:16'].includes(input.aspect))) fail('此 Runway Veo 模型支持 4、6、8 秒和 16:9 / 9:16 画幅');
    if (/^gen4/.test(p.model) && (input.seconds < 2 || input.seconds > 10)) fail('此 Runway 模型的视频时长须为 2–10 秒');
    const body = {
      ...p.extra, model: p.model,
      promptText: input.prompt,
      ratio,
      duration: input.seconds,
      ...(first ? { promptImage: last ? [{ uri: asData(first), position: 'first' }, { uri: asData(last), position: 'last' }] : asData(first) } : {}),
    };
    return { endpoint, method: 'POST', body, headers: { 'X-Runway-Version': String(p.custom?.apiVersion || RUNWAY_DEFAULT_VERSION) } };
  },
  normalizeState(p, result, previous = {}) {
    const id = result.id ?? previous.id;
    const status = String(result.status ?? '').toUpperCase();
    const outputs = Array.isArray(result.output) ? result.output : result.output ? [result.output] : [];
    return {
      id,
      statusUrl: id ? `tasks/${encodeURIComponent(id)}` : previous.statusUrl,
      cancelUrl: id ? `tasks/${encodeURIComponent(id)}` : previous.cancelUrl,
      cancelMethod: 'DELETE',
      cancelHeaders: { 'X-Runway-Version': String(p.custom?.apiVersion || RUNWAY_DEFAULT_VERSION) },
      done: status === 'SUCCEEDED',
      failed: RUNWAY_FAILED.has(status) || Boolean(result.failureCode),
      outputs,
      progress: Number(result.progress) || undefined,
      ...(result.failure ? { failure: result.failure } : {}),
    };
  },
  async poll(p, remote, { request, signal }) {
    return request(p, remote.statusUrl, { signal, headers: { 'X-Runway-Version': String(p.custom?.apiVersion || RUNWAY_DEFAULT_VERSION) } });
  },
  normalizeUsage() { return undefined; },
};

// Replicate: model-scoped prediction creation, explicit get/cancel URLs,
// output as URL string or array, metrics with token counts.
const replicate = {
  inputCapabilities(p) {
    return { maxReferences: 0, firstFrame: Boolean(p.custom?.imageInputField || p.custom?.firstFrameField), lastFrame: Boolean(p.custom?.lastFrameField), requiresFirstFrame: false, requiresLastFrame: false };
  },
  async submit(p, input, refs, { request, signal }) {
    const first = refs.find(ref => ref.role === 'firstFrame');
    const last = refs.find(ref => ref.role === 'lastFrame');
    const field = p.custom?.imageInputField || p.custom?.firstFrameField;
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.model)) fail('Replicate 模型应填写 owner/model');
    const endpoint = `models/${p.model}/predictions`;
    const body = {
      input: {
        ...p.extra,
        prompt: input.prompt,
        duration: input.seconds,
        aspect_ratio: input.aspect,
        ...(first ? { [field]: asData(first) } : {}),
        ...(last ? { [p.custom.lastFrameField]: asData(last) } : {}),
      },
    };
    return { endpoint, method: 'POST', body, headers: {} };
  },
  normalizeState(p, result, previous = {}) {
    const id = result.id ?? previous.id;
    const outputs = Array.isArray(result.output) ? result.output : result.output ? [result.output] : [];
    const metrics = result.metrics && typeof result.metrics === 'object' ? result.metrics : {};
    return {
      id,
      statusUrl: previous.statusUrl ?? (id ? `predictions/${encodeURIComponent(id)}` : undefined),
      cancelUrl: previous.cancelUrl ?? (id ? `predictions/${encodeURIComponent(id)}/cancel` : undefined),
      cancelMethod: 'POST',
      done: result.status === 'succeeded',
      failed: REPLICATE_DONE.has(result.status) && result.status !== 'succeeded',
      outputs,
      progress: result.status === 'processing' ? 50 : result.status === 'starting' ? 5 : undefined,
      ...(Object.keys(metrics).length ? { metrics } : {}),
      ...(result.error ? { error: String(result.error) } : {}),
    };
  },
  async poll(p, remote, { request, signal }) {
    return request(p, remote.statusUrl, { signal, headers: {} });
  },
  // Raw vendor units only: prediction time is not a credit figure, tokens are
  // reported as tokens; anything absent stays absent (never zero-filled).
  normalizeUsage(p, remote) {
    const metrics = remote?.metrics;
    if (!metrics) return undefined;
    const units = [];
    if (finiteUnit(metrics.predict_time)) units.push({ name: 'predict-time-seconds', value: Number(metrics.predict_time) });
    if (finiteUnit(metrics.input_token_count)) units.push({ name: 'input_tokens', value: Number(metrics.input_token_count) });
    if (finiteUnit(metrics.output_token_count)) units.push({ name: 'output_tokens', value: Number(metrics.output_token_count) });
    return units.length ? units : undefined;
  },
};

const ADAPTERS = { gemini, runway, replicate, comfyui: require('./studio-comfy') };
const adapterFor = protocol => ADAPTERS[protocol] ?? null;

module.exports = { adapterFor, ADAPTERS };
