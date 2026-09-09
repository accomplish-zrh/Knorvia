'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createEncryptedConnectionStore, normalizeBaseUrl, normalizeApiKey } = require('./connection-config');
const fail = message => { const e = new Error(message); e.rpc = { code: -32602, message }; throw e; };
const text = (v, max = 2048) => typeof v === 'string' && !v.includes('\0') && v.length <= max ? v.trim() : fail('Invalid text field');
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(v) ? v : fail('Invalid identifier');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function safeObject(value, maxBytes = 32768) {
  let raw; try { raw = JSON.stringify(value ?? {}); } catch { fail('Invalid custom parameters'); }
  if (typeof raw !== 'string') fail('Invalid custom parameters');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) fail(`Custom parameters exceed ${Math.round(maxBytes / 1024)} KB`);
  const visit = (v, depth = 0) => {
    if (depth > 20) fail('Custom parameters are too deeply nested');
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('Invalid parameter key'); visit(child, depth + 1); }
  };
  const result = JSON.parse(raw); visit(result); return result;
}
function createProfiles({ home, safeStorage }) {
  const root = path.join(home, 'config', 'studio');
  const file = path.join(root, 'profiles.json');
  const secrets = new Map();
  let profiles = []; let warning;
  try {
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.profiles) || stored.profiles.length > 50) throw new Error();
      profiles = stored.profiles.map(p => { id(p.id); if (p.credentialId) id(p.credentialId); return normalize(p, p.id); });
      if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error();
    }
  } catch { profiles = []; warning = 'Saved model connections could not be read. The original file will be preserved when you save a new connection.'; }
  const keyStore = profileId => createEncryptedConnectionStore({ filePath: path.join(root, 'credentials', `${id(profileId)}.json`), safeStorage });
  function normalize(input, profileId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid model connection');
    const protocol = text(input.protocol);
    if (!['openai', 'fal', 'json', 'gemini', 'runway', 'replicate', 'comfyui'].includes(protocol)) fail('Unsupported protocol');
    const kind = text(input.kind); if (!['image', 'video'].includes(kind)) fail('Choose image or video');
    if (['runway', 'replicate'].includes(protocol) && kind !== 'video') fail('此协议当前只支持视频模型');
    const p = { id: profileId, name: text(input.name, 100), kind, protocol, baseUrl: normalizeBaseUrl(input.baseUrl), model: text(input.model, 256), authHeader: text(input.authHeader || (protocol === 'gemini' ? 'x-goog-api-key' : 'Authorization'), 100), authPrefix: input.authPrefix === '' || input.authPrefix === undefined && protocol === 'gemini' ? '' : text(input.authPrefix || (protocol === 'fal' ? 'Key' : 'Bearer'), 50), agentEnabled: input.agentEnabled === true, extra: safeObject(input.extra), custom: safeObject(input.custom, protocol === 'comfyui' ? 600 * 1024 : 32768), ...(input.credentialId ? { credentialId: id(input.credentialId) } : {}) };
    if (!p.name || !p.baseUrl || !p.model || !/^[A-Za-z][A-Za-z0-9-]*$/.test(p.authHeader) || /^(host|cookie|origin|content-length|content-type|connection|transfer-encoding|upgrade)$/i.test(p.authHeader) || /[\r\n]/.test(p.authPrefix)) fail('Invalid model connection');
    if (!p.extra || typeof p.extra !== 'object' || Array.isArray(p.extra) || !p.custom || typeof p.custom !== 'object' || Array.isArray(p.custom)) fail('Custom parameters must be JSON objects');
    for (const field of ['createPath', 'statusPathTemplate']) if (p.custom[field] !== undefined) {
      const endpoint = text(p.custom[field]); if (!endpoint || url(endpoint.replace(/\{\{id\}\}/g, 'example'), p.baseUrl).origin !== url(p.baseUrl).origin) fail('Custom endpoints must use the configured API origin');
    }
    for (const field of ['successValues', 'failureValues']) if (p.custom[field] !== undefined && (!Array.isArray(p.custom[field]) || p.custom[field].some(v => typeof v !== 'string'))) fail('Custom status values must be lists of strings');
    for (const field of ['firstFrameField', 'lastFrameField', 'referenceField', 'imageInputField']) if (p.custom[field] !== undefined && p.custom[field] !== '' && (typeof p.custom[field] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(p.custom[field]) || ['model', 'prompt', 'duration', 'aspect_ratio', 'num_images', 'image_size', 'constructor', 'prototype'].includes(p.custom[field]))) fail('Invalid image input field mapping');
    if (p.custom.referenceMode !== undefined && !['none', 'single', 'multiple'].includes(p.custom.referenceMode)) fail('Invalid reference image mode');
    const resolved = frameMapping(p);
    const fields = [resolved.first, resolved.last].filter(Boolean);
    if (new Set(fields).size !== fields.length) fail('First and last frames must use different fields');
    return p;
  }
  function key(p) { const stored = keyStore(p.credentialId || p.id).load(); return secrets.get(p.id) ?? (stored.baseUrl === p.baseUrl ? stored.apiKey : '') ?? ''; }
  function visible(p) { const { credentialId, ...visible } = p; return { ...visible, inputCapabilities: inputCapabilities(p), keyConfigured: Boolean(key(p)), keyPersistent: keyStore(p.credentialId || p.id).available }; }
  return {
    get warning() { return warning; },
    list: () => profiles.map(visible),
    get(profileId) { const p = profiles.find(v => v.id === profileId); if (!p) fail('Model connection not found'); const { credentialId, ...value } = p; return { ...value, apiKey: key(p) }; },
    save(input) {
      if (!input || typeof input !== 'object') fail('Invalid model connection');
      const profileId = input.id ? id(input.id) : crypto.randomUUID();
      const old = profiles.find(p => p.id === profileId);
      if (profiles.length >= 50 && !old) fail('Maximum 50 model connections');
      const p = normalize({ ...input, credentialId: undefined }, profileId);
      const apiKey = input.apiKey === undefined ? old && old.baseUrl === p.baseUrl ? key(old) : '' : normalizeApiKey(input.apiKey);
      if (/[\r\n]/.test(apiKey)) fail('API key must not contain a line break');
      // A new immutable credential record is committed by the metadata pointer.
      // A crash before that commit cannot change the old connection's key.
      p.credentialId = crypto.randomUUID(); const store = keyStore(p.credentialId);
      const next = [...profiles.filter(item => item.id !== profileId), p];
      try {
        if (store.available) store.save({ model: p.model, baseUrl: p.baseUrl, apiKey, hasApiKeySetting: true });
        if (warning && fs.existsSync(file)) fs.copyFileSync(file, `${file}.unreadable-${crypto.randomUUID()}`, fs.constants.COPYFILE_EXCL);
        atomic(file, { version: 1, profiles: next });
      } catch { store.restore({ exists: false }); fail('Could not save the model connection; the previous connection is unchanged'); }
      profiles = next; secrets.set(profileId, apiKey); warning = undefined;
      if (old) { try { fs.unlinkSync(path.join(root, 'credentials', `${old.credentialId || old.id}.json`)); } catch {} }
      return visible(p);
    },
    remove(profileId) {
      id(profileId); const old = profiles.find(p => p.id === profileId); const next = profiles.filter(p => p.id !== profileId); atomic(file, { version: 1, profiles: next }); profiles = next; secrets.delete(profileId);
      const secretFile = path.join(root, 'credentials', `${old?.credentialId || profileId}.json`); try { fs.unlinkSync(secretFile); } catch {}
      return { removed: true };
    },
  };
}

// Credentials follow only the explicitly configured API origin. Redirects on
// control requests are rejected; output redirects never carry API credentials.
function url(value, base) {
  let parsed; try { if (typeof value !== 'string' || !value) fail('Invalid provider address'); parsed = new URL(value, base ? `${base.replace(/\/$/, '')}/` : undefined); } catch { fail('Invalid provider address'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('Only credential-free HTTP(S) addresses are supported');
  return parsed;
}
async function request(p, target, { body, method = 'GET', signal, binary = false, output = false, emptyOk = false, headers: extraHeaders, downloadTo } = {}) {
  let address = url(target, p.baseUrl); const origin = url(p.baseUrl).origin;
  if (!output && address.origin !== origin) fail('Provider returned a control address on another origin');
  for (let redirect = 0; redirect < 5; redirect++) {
    const headers = { ...(extraHeaders ?? {}) };
    if (!output && p.apiKey) headers[p.authHeader] = `${p.authPrefix}${p.authPrefix ? ' ' : ''}${p.apiKey}`;
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetch(address, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(30000) }); }
    catch (error) { const e = new Error(error.name === 'AbortError' ? 'Request stopped' : 'Provider connection interrupted; the remote outcome may be unknown'); e.uncertain = true; e.expose = true; throw e; }
    if (response.status >= 300 && response.status < 400 && output) { address = url(response.headers.get('location'), address.toString()); await response.body?.cancel(); continue; }
    if (!response.ok) { await response.body?.cancel(); const e = new Error(`Provider returned HTTP ${response.status}`); e.httpStatus = response.status; const retry = response.headers.get('retry-after'); if (retry) e.retryAfter = retry; e.expose = true; throw e; }
    const limit = binary ? 256 * 1024 * 1024 : 64 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail('Provider response exceeds size limit'); }
    if (binary && downloadTo) {
      const handle = await fs.promises.open(downloadTo, 'wx'); let size = 0, head = Buffer.alloc(0); const hash = crypto.createHash('sha256');
      try {
        for await (const chunk of response.body) { size += chunk.length; if (size > limit) fail('Provider response exceeds size limit'); if (head.length < 64) head = Buffer.concat([head, Buffer.from(chunk).subarray(0, 64 - head.length)]); hash.update(chunk); let offset = 0; while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) fail('Could not save media output'); offset += result.bytesWritten; } }
        await handle.sync(); return { file: downloadTo, size, head, sha256: hash.digest('hex'), mime: response.headers.get('content-type')?.split(';')[0] };
      } catch (error) { await handle.close(); try { await fs.promises.unlink(downloadTo); } catch {} throw error; }
      finally { await handle.close().catch(() => {}); }
    }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > limit) { fail('Provider response exceeds size limit'); } chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    if (binary) return { bytes, mime: response.headers.get('content-type')?.split(';')[0] };
    // Cancellation endpoints may answer 200 with an empty body; that is an
    // accepted cancel, not an unknown outcome.
    if (emptyOk && bytes.length === 0) return {};
    try { return JSON.parse(bytes.toString('utf8')); } catch { const e = new Error('Provider returned invalid JSON; remote outcome may be unknown'); e.uncertain = true; e.expose = true; throw e; }
  }
  fail('Too many output redirects');
}
function at(value, field) { return String(field || '').split('.').filter(Boolean).reduce((v, key) => v?.[key], value); }
function expand(value, vars) {
  if (typeof value === 'string') { const match = value.match(/^\{\{(\w+)\}\}$/); if (match) return vars[match[1]]; return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? '')); }
  if (Array.isArray(value)) return value.map(item => expand(item, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}
function remoteState(p, result, previous = {}) {
  if (p.protocol === 'openai') {
    if (p.kind === 'image') return { done: true, outputs: result.data ?? [], ...(result.usage ? { usage: result.usage } : {}) };
    const remoteId = result.id ?? previous.id;
    return { id: remoteId, statusUrl: `videos/${encodeURIComponent(remoteId)}`, progress: result.progress, done: result.status === 'completed', failed: ['failed', 'cancelled'].includes(result.status), outputs: result.status === 'completed' ? [{ apiContent: `videos/${encodeURIComponent(remoteId)}/content` }] : [], ...(result.usage ? { usage: result.usage } : {}) };
  }
  if (p.protocol === 'fal') return { ...previous, id: result.request_id ?? previous.id, statusUrl: result.status_url ?? previous.statusUrl, resultUrl: result.response_url ?? previous.resultUrl, cancelUrl: result.cancel_url ?? previous.cancelUrl, done: result.status === 'COMPLETED', failed: Boolean(result.error), outputs: result.images ?? (result.video ? [result.video] : []), progress: result.status === 'IN_PROGRESS' ? 50 : 0, ...(result.usage ? { usage: result.usage } : {}) };
  const c = p.custom, remoteId = at(result, c.idPath || 'id') ?? previous.id;
  const state = String(at(result, c.statusPath || 'status') ?? '');
  const outputs = at(result, c.outputPath || 'data');
  const usage = c.usagePath ? at(result, c.usagePath) : undefined;
  return { ...previous, id: remoteId, statusUrl: c.statusPathTemplate ? expand(c.statusPathTemplate, { id: encodeURIComponent(remoteId) }) : previous.statusUrl, done: !c.statusPathTemplate || (c.successValues || ['completed', 'succeeded']).includes(state), failed: (c.failureValues || ['failed', 'cancelled']).includes(state), progress: Number(at(result, c.progressPath || 'progress')) || 0, outputs: Array.isArray(outputs) ? outputs : outputs ? [outputs] : [], ...(usage ? { usage } : {}) };
}
// An adapter contract, not a claim that an arbitrary third-party model supports
// every input. Unknown endpoints can declare their actual fields in custom.
function frameMapping(p) {
  const c = p.custom || {}, model = p.model.replace(/\/$/, '');
  let first = 'image_url', last = '', required = false, both = false;
  if (model === 'fal-ai/wan-flf2v') { first = 'start_image_url'; last = 'end_image_url'; required = both = true; }
  if (/^fal-ai\/wan\/v2\.7\/image-to-video$/.test(model)) { last = 'end_image_url'; required = true; }
  if (/^fal-ai\/kling-video\/v3\/(standard|pro|4k)\/image-to-video$/.test(model)) { first = 'start_image_url'; last = 'end_image_url'; required = true; }
  return { first: c.firstFrameField ?? first, last: c.lastFrameField ?? last, required, both };
}
function inputCapabilities(p) {
  const c = p.custom || {}, template = c.requestTemplate === undefined ? null : JSON.stringify(c.requestTemplate);
  if (['comfyui','gemini'].includes(p.protocol)) return require('./studio-adapters').adapterFor(p.protocol).inputCapabilities(p);
  const uses = name => template === null || template.includes(`{{${name}}}`);
  if (p.kind === 'image') {
    const maxReferences = p.protocol === 'openai' ? (p.model === 'dall-e-3' ? 0 : p.model === 'dall-e-2' ? 1 : 6)
      : p.protocol === 'json' ? (uses('images') ? 6 : 0) : c.referenceMode === 'none' ? 0 : c.referenceMode === 'multiple' ? 6 : 1;
    return { maxReferences, firstFrame: false, lastFrame: false, requiresFirstFrame: false, requiresLastFrame: false };
  }
  const adapter = require('./studio-adapters').adapterFor(p.protocol);
  if (adapter) return adapter.inputCapabilities(p);
  const mapping = frameMapping(p);
  return { maxReferences: 0, firstFrame: p.protocol === 'openai' || (p.protocol === 'fal' ? Boolean(mapping.first) : uses('first_frame') || uses('images')),
    lastFrame: p.protocol === 'fal' ? Boolean(mapping.last) : p.protocol === 'json' && uses('last_frame'),
    requiresFirstFrame: p.protocol === 'fal' && mapping.required, requiresLastFrame: p.protocol === 'fal' && mapping.both };
}
function validateInputs(p, input) {
  const caps = inputCapabilities(p);
  if (input.references.length > caps.maxReferences) fail(`此模型最多支持 ${caps.maxReferences} 张参考图，请切换模型或移除多余素材`);
  if (input.firstFrame && !caps.firstFrame) fail('此模型连接未配置首帧支持，请切换模型或检查输入映射');
  if (input.lastFrame && !caps.lastFrame) fail('此模型连接未配置尾帧支持，请切换支持首尾帧的模型');
  if ((input.lastFrame || caps.requiresFirstFrame) && !input.firstFrame) fail('请先添加视频首帧');
  if (caps.requiresLastFrame && !input.lastFrame) fail('此模型需要同时添加首帧和尾帧');
}
async function submit(p, input, references, signal) {
  const asData = ref => ref && `data:${ref.mime};base64,${ref.bytes.toString('base64')}`;
  const first = references.find(ref => ref.role === 'firstFrame') ?? (p.kind === 'video' ? references.find(ref => !ref.role) : undefined);
  const last = references.find(ref => ref.role === 'lastFrame');
  const caps = inputCapabilities(p);
  if (last && !caps.lastFrame) fail('此模型连接未配置尾帧支持');
  const vars = { ...input, model: p.model, images: references.filter(ref => ref.role !== 'lastFrame').map(asData), first_frame: asData(first), last_frame: asData(last) };
  const adapter = require('./studio-adapters').adapterFor(p.protocol);
  if (adapter) {
    const planned = await adapter.submit(p, input, references, { request, signal });
    const result = await request(p, planned.endpoint, { method: planned.method ?? 'POST', body: planned.body, headers: planned.headers, signal });
    return adapter.normalizeState(p, result);
  }
  let endpoint; let body;
  if (p.protocol === 'openai') {
    body = { ...p.extra, model: p.model, prompt: input.prompt, size: input.size };
    if (p.kind === 'image') { body.n = input.count; if (input.quality !== 'auto') body.quality = input.quality; endpoint = references.length ? 'images/edits' : 'images/generations'; }
    else { body.seconds = String(input.seconds); endpoint = 'videos'; }
    if (references.length || p.kind === 'video') {
      const form = new FormData(); for (const [k, v] of Object.entries(body)) if (v !== undefined) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      references.forEach(ref => form.append(p.kind === 'image' ? (p.model === 'dall-e-2' ? 'image' : 'image[]') : 'input_reference', new Blob([ref.bytes], { type: ref.mime }), ref.name)); body = form;
    }
  } else if (p.protocol === 'fal') {
    endpoint = p.model; body = { prompt: input.prompt, ...p.extra };
    if (p.kind === 'image') { body.num_images = input.count; const [width, height] = input.size.split('x').map(Number); body.image_size = { width, height }; }
    else { body.duration = String(input.seconds); body.aspect_ratio = input.aspect; }
    if (p.kind === 'image' && references.length) {
      const multiple = p.custom.referenceMode === 'multiple';
      body[p.custom.referenceField || (multiple ? 'image_urls' : 'image_url')] = multiple ? vars.images : vars.images[0];
    } else if (p.kind === 'video') {
      const mapping = frameMapping(p);
      if (first) body[mapping.first] = vars.first_frame;
      if (last) body[mapping.last] = vars.last_frame;
    }
  } else { endpoint = p.custom.createPath || 'generate'; body = expand(p.custom.requestTemplate || { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', seconds: '{{seconds}}', n: '{{count}}', images: '{{images}}', first_frame: '{{first_frame}}', last_frame: '{{last_frame}}' }, vars); body = { ...p.extra, ...body }; }
  return remoteState(p, await request(p, endpoint, { method: 'POST', body, signal }));
}
async function poll(p, remote, signal) {
  if (!remote.statusUrl) fail('Provider did not return a queryable job identifier');
  const adapter = require('./studio-adapters').adapterFor(p.protocol);
  if (adapter) {
    const result = await adapter.poll(p, remote, { request, signal });
    return adapter.normalizeState(p, result, remote);
  }
  let state = remoteState(p, await request(p, remote.statusUrl, { signal }), remote);
  if (p.protocol === 'fal' && state.done && !state.failed) { const result = await request(p, state.resultUrl, { signal }); state.outputs = result.images ?? (result.video ? [result.video] : []); if (result.usage) state.usage = result.usage; if (result.error) state.failed = true; }
  return state;
}
// Frozen media usage schema (night-shift contract v1, A-aggregated):
// provider raw units only — no prices, no fabricated zeros. When the provider
// returned nothing, known stays false and units stay empty.
function protocolName(p) {
  if (p.protocol === 'openai') return p.kind === 'image' ? 'openai-images' : 'openai-videos';
  if (p.protocol === 'fal') return 'fal-queue';
  if (p.protocol === 'gemini') return p.kind === 'image' ? 'gemini-images' : 'gemini-veo';
  if (p.protocol === 'runway') return 'runway-tasks';
  if (p.protocol === 'replicate') return 'replicate-predictions';
  if (p.protocol === 'comfyui') return 'comfyui-workflow';
  return 'json';
}
function extractUnits(raw) {
  const units = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return units;
  const grab = (name, ...values) => {
    const value = values.filter(v => typeof v === 'number' || typeof v === 'string' && v.trim() !== '').map(Number).find(v => Number.isFinite(v) && v >= 0);
    if (value !== undefined) units.push({ name, value });
  };
  const detail = key => raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
  const promptDetails = detail('prompt_tokens_details'), completionDetails = detail('output_tokens_details'), completionDetailsAlt = detail('completion_tokens_details');
  grab('input_tokens', raw.input_tokens, raw.prompt_tokens);
  grab('output_tokens', raw.output_tokens, raw.completion_tokens);
  grab('cache_read_tokens', raw.cache_read_tokens, promptDetails.cached_tokens);
  grab('reasoning_tokens', raw.reasoning_tokens, completionDetails.reasoning_tokens, completionDetailsAlt.reasoning_tokens);
  grab('images', raw.images, raw.image_count);
  grab('video-seconds', raw.video_seconds, raw.seconds);
  grab('credits', raw.credits, raw.credit);
  return units;
}
function normalizeUsage(p, remote, { requestId, at } = {}) {
  // Adapter protocols report their own raw units (Replicate metrics);
  // Veo and Runway carry no usage facts, so known stays false — never a guess.
  const adapter = require('./studio-adapters').adapterFor(p.protocol);
  let known; let units;
  if (adapter) {
    const adapterUnits = adapter.normalizeUsage ? adapter.normalizeUsage(p, remote) : undefined;
    known = Boolean(adapterUnits?.length);
    units = adapterUnits ?? [];
  } else {
    units = extractUnits(remote?.usage);
    known = units.length > 0;
  }
  return {
    providerId: p.id ?? p.protocol, protocol: protocolName(p), model: p.model,
    requestId: requestId ?? null,
    attempts: [{ at: at ?? new Date().toISOString(), recordedAtMs: at ? Date.parse(at) : Date.now(), known, units }],
  };
}
module.exports = { createProfiles, request, submit, poll, inputCapabilities, validateInputs, id, text, fail, atomic, safeObject, normalizeUsage, protocolName };
