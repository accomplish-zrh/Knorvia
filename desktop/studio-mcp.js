'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const referenceSchema = { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false };
const generation = kind => ({
  name: `${kind}gen`,
  description: `Create ${kind === 'image' ? 'an image or edit reference images' : 'a video with optional firstFrame and lastFrame'} using a user-configured model. Call media_models first and check inputCapabilities; never drop an unsupported reference or frame. Only connections enabled for Agent use can run. This may consume provider credits. Return the durable job; use media_status to follow progress and never resubmit a running or uncertain job. Reuse idempotencyKey for an identical retry. Select personal-library IDs and pinned versions using media_references. ${kind === 'video' ? 'Use firstFrame and lastFrame separately; lastFrame needs a firstFrame. The legacy single references entry means firstFrame.' : 'Use references for up to the model reference limit; input order is preserved.'}`,
  inputSchema: { type: 'object', properties: {
    profileId: { type: 'string' }, prompt: { type: 'string' }, idempotencyKey: { type: 'string' },
    size: { type: 'string', description: 'Widthxheight, e.g. 1024x1024 or 1280x720' }, seconds: { type: 'integer' }, count: { type: 'integer' }, aspect: { type: 'string' }, quality: { type: 'string' },
    references: { type: 'array', maxItems: kind === 'image' ? 6 : 1, items: referenceSchema },
    ...(kind === 'video' ? { firstFrame: { ...referenceSchema, description: 'Image used at the start of the video' }, lastFrame: { ...referenceSchema, description: 'Image used at the end; requires inputCapabilities.lastFrame and firstFrame' } } : {}),
  }, required: ['profileId', 'prompt', 'idempotencyKey'], additionalProperties: false },
});
const byId = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
const expose = text => { const e = new Error(text); e.expose = true; return e; };
const shotSchema = { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, profileId: { type: 'string' }, seconds: { type: 'integer' }, continuity: { type: 'string', enum: ['previous-tail', 'none'], description: 'previous-tail pins the previous completed shot real last frame as this shot first frame' }, firstFrame: { ...referenceSchema, required: ['id', 'version'], description: 'Pinned library image and SHA-256 version, used when continuity is none. Required for image-to-video-only models. Automatic previous-tail takes precedence.' }, templateId: { type: 'string' }, templateRevision: { type: 'integer' }, templateParams: { type: 'object' } }, required: ['prompt'], additionalProperties: false };
const TOOLS = [generation('image'), generation('video'),
  { name: 'article_video', description: require('./article-video').guide, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'list', 'read', 'save', 'voice', 'import-audio', 'build', 'render', 'cancel', 'playback'] }, id: { type: 'string' }, revision: { type: 'integer' }, idempotencyKey: { type: 'string' }, title: { type: 'string' }, article: { type: 'string' }, audience: { type: 'string' }, narration: { type: 'string' }, aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, scenes: { type: 'array', maxItems: 80, items: { type: 'object', properties: { heading: { type: 'string' }, detail: { type: 'string' }, reference: referenceSchema }, required: ['heading'], additionalProperties: false } }, voice: { type: 'string' }, sample: { type: 'boolean' }, preview: { type: 'boolean' }, reference: referenceSchema, srt: { type: 'string' }, kind: { type: 'string', enum: ['sample', 'audio', 'preview', 'output'] } }, required: ['action'], additionalProperties: false } },
  { name: 'pet_create', description: 'Only when the user asks to create a pet: start one grounded imagegen identity and nine pose rows through an Agent-enabled image model. Up to ten provider generations may be billed. Returns a durable job; pet_status follows it. Never substitute generated scenes or tiled single pictures for missing poses. The completed candidate requires visual review before selecting.', inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, reference: referenceSchema, idempotencyKey: { type: 'string' } }, required: ['profileId', 'name', 'prompt', 'idempotencyKey'], additionalProperties: false } },
  { name: 'pet_status', description: 'Read progress of a pet hatch job; optional jobId returns a single durable job, otherwise list candidates and pending jobs. A paused/unknown child generation must not be resubmitted.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, additionalProperties: false } },
  { name: 'media_models', description: 'List user-configured image/video model connections and whether Agent use is enabled. No credentials are returned.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'media_status', description: 'Read the durable media job status, error, and local output metadata. A paused job can be resumed from the creation studio. An unknown submission must not be silently generated again.', inputSchema: byId },
  { name: 'media_cancel', description: 'Stop local tracking and request provider cancellation where supported. The provider may continue and charge for a running generation; cancellation is not a refund guarantee.', inputSchema: byId },
  { name: 'media_save', description: 'Copy a generated output into the personal library without overwriting existing files.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, index: { type: 'integer' }, path: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'media_references', description: 'List personal-library images for use as generation or editing references.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'media_extract_frame', description: 'Export the real last displayed frame of a completed video job (decoded by PTS, not duration arithmetic) into an immutable personal-library image. Returns the library entry and provenance (source hash, stream index, pts).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, index: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
  { name: 'media_sequence_create', description: 'Create a durable storyboard sequence of video shots sharing a global prompt. Each shot with continuity "previous-tail" is automatically chained: after the previous shot finishes and its real tail frame is stored, that frame becomes the next shot first frame. Shots submit strictly in order; same-chain generations never run in parallel. This may consume provider credits.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, globalPrompt: { type: 'string' }, defaults: { type: 'object', properties: { profileId: { type: 'string' }, seconds: { type: 'integer' } }, required: ['profileId'], additionalProperties: false }, shots: { type: 'array', items: shotSchema }, start: { type: 'boolean' }, idempotencyKey: { type: 'string' } }, required: ['title', 'defaults', 'shots'], additionalProperties: false } },
  { name: 'media_sequence_status', description: 'Read a storyboard sequence: per-shot status, pinned first frames, tail-frame library versions, and blocked reasons. Unknown submissions are visible here and never auto-resubmit.', inputSchema: byId },
  { name: 'media_sequence_control', description: 'Start, pause, resume, or cancel a storyboard sequence. Pause stops dispatching new shots but keeps tracking the running one; cancel stops local tracking and may leave the provider running. Resuming never resubmits an unknown-outcome shot.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['start', 'pause', 'resume', 'cancel'] } }, required: ['id', 'action'], additionalProperties: false } },
  { name: 'media_templates', description: 'List, read, render, save or remove personal prompt templates. Read first and pass expectedRevision when editing/removing to avoid overwriting another window. Saved sequences preserve their accepted content.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'render', 'save', 'remove'] }, id: { type: 'string' }, query: { type: 'string' }, revision: { type: 'integer' }, expectedRevision: { type: 'integer' }, params: { type: 'object' }, name: { type: 'string' }, kind: { type: 'string', enum: ['any', 'image', 'video'] }, prompt: { type: 'string' }, defaults: { type: 'object' } }, required: ['action'], additionalProperties: false } },
];
TOOLS.push({ name: 'media_edit', description: 'Edit completed storyboard videos locally without model charges. create takes a sequenceId and opens its durable edit project. read returns immutable sources and a 30 fps frame-based edit. update requires the current revision and edit {aspect,clips:[{id,startFrame,endFrame,volume,fadeFrames}]}. export takes project id, revision and idempotencyKey and snapshots a render job; status/cancel take the render id. Original clips are preserved; exported MP4 is saved in the personal library.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'read', 'update', 'export', 'status', 'cancel'] }, sequenceId: { type: 'string' }, id: { type: 'string' }, revision: { type: 'integer' }, edit: { type: 'object', properties: { aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, clips: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, startFrame: { type: 'integer' }, endFrame: { type: 'integer' }, volume: { type: 'number' }, fadeFrames: { type: 'integer' } }, required: ['id', 'startFrame', 'endFrame'], additionalProperties: false } } }, required: ['clips'], additionalProperties: false }, idempotencyKey: { type: 'string' } }, required: ['action'], additionalProperties: false } });
const editTool = TOOLS.find(t => t.name === 'media_edit');
editTool.description += ' You can also import existing MP4/WebM library videos: sources lists available library IDs and SHA-256 versions; import requires ordered references [{id,version}], title and idempotencyKey. list returns saved project summaries with nextOffset for pagination. Imported originals are preserved. Clip options fit (contain or cover), rotation (clockwise 0/90/180/270) and mirror (horizontal after rotation) are applied when exporting.';
editTool.inputSchema.properties.action.enum.push('import', 'list', 'sources');
Object.assign(editTool.inputSchema.properties, { title: { type: 'string', maxLength: 100 }, offset: { type: 'integer', minimum: 0 }, references: { type: 'array', minItems: 1, maxItems: 40, items: { ...referenceSchema, required: ['id', 'version'] } } });
Object.assign(editTool.inputSchema.properties.edit.properties.clips.items.properties, { fit: { type: 'string', enum: ['contain', 'cover'] }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, mirror: { type: 'boolean' } });
const captionSchema = { type: 'object', properties: { startFrame: { type: 'integer' }, endFrame: { type: 'integer' }, text: { type: 'string' } }, required: ['startFrame', 'endFrame', 'text'], additionalProperties: false };
TOOLS.find(t => t.name === 'media_edit').inputSchema.properties.edit.properties.captions = { type: 'array', maxItems: 3000, items: captionSchema };
TOOLS.push({ name: 'media_subtitles', description: 'Transcribe edit audio locally with the user-configured whisper.cpp program/model. No remote model charges. start takes project id, revision and idempotencyKey; status/cancel take subtitle job id. apply takes subtitle job id and unchanged project revision; never overwrite a changed edit. import/export take project id and revision, import also needs SRT content. Recognition is provisional until reviewed; results are saved in the personal library. Edit caption text/timing with media_edit update. Configuration must be set by the user in the UI.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'status', 'cancel', 'apply', 'import', 'export'] }, id: { type: 'string' }, revision: { type: 'integer' }, idempotencyKey: { type: 'string' }, content: { type: 'string' } }, required: ['action', 'id'], additionalProperties: false } });
TOOLS.push({ name: 'media_retake', description: 'Regenerate a selected segment using a video model that supports both firstFrame and lastFrame. This is boundary-frame-conditioned generation, not video-conditioned editing. start takes project id/revision, clipId, source-relative startFrame/endFrame (30 fps), profileId, prompt and idempotencyKey. Uses provider credits and Agent-enabled connections only. Original media is preserved. Read status, preview in UI, then apply with the unchanged project revision. Candidate is retimed to exactly replace the range; undo takes project id/revision and works only before further edits. Cancellation cannot guarantee remote billing stops. Never resubmit uncertain child jobs.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'status', 'cancel', 'apply', 'undo'] }, id: { type: 'string' }, revision: { type: 'integer' }, clipId: { type: 'string' }, startFrame: { type: 'integer' }, endFrame: { type: 'integer' }, profileId: { type: 'string' }, prompt: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['action', 'id'], additionalProperties: false } });
// Single dispatch shared by the Kernel MCP endpoint and the external creative
// CLI, so both entrances apply identical revision/idempotency semantics.
async function callMediaTool({ studio, library, name, params = {} }) {
  if (!studio) throw expose('Media service is starting');
  let value;
  try {
    if (['imagegen', 'videogen'].includes(name)) {
      if (studio.profiles.get(params.profileId).kind !== (name === 'imagegen' ? 'image' : 'video')) throw expose('Choose a matching media model');
      value = await studio.create(params, true);
    } else if (name === 'pet_create') value = await studio.pets.create(params, true);
    else if (name === 'pet_status') value = params.jobId ? await studio.handlers['studio/pet/read'](params) : await studio.handlers['studio/pet/list']();
    else if (name === 'media_models') value = await studio.handlers['studio/models']();
    else if (name === 'media_status') value = await studio.handlers['studio/read'](params);
    else if (name === 'media_cancel') value = await studio.handlers['studio/cancel'](params);
    else if (name === 'media_save') value = await studio.handlers['studio/library'](params);
    else if (name === 'media_references') { const index = await library.handlers['library/list'](); value = index.entries.filter(e => /\.(png|jpe?g|webp|gif)$/i.test(e.name) && !e.trashedAt).slice(0, 100).map(e => ({ id: e.id, name: e.name, version: e.sha256 })); }
    else if (name === 'media_extract_frame') value = await studio.handlers['studio/frame/export']({ id: params.id, index: params.index });
    else if (name === 'media_sequence_create') {
      for (const shot of params.shots ?? []) {
        const profile = studio.profiles.get(shot.profileId || params.defaults?.profileId);
        if (!profile.agentEnabled) throw expose('This model is not enabled for Agent use');
      }
      value = await studio.handlers['studio/sequence/create']({ ...params, agentRequested: true });
    }
    else if (name === 'media_sequence_status') value = await studio.handlers['studio/sequence/read'](params);
    else if (name === 'media_edit') {
      if (params.action === 'sources') {
        const index = await library.handlers['library/list']();
        const all = index.entries.filter(e => !e.trashedAt && !e.folder && /\.(mp4|webm)$/i.test(e.name));
        const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
        value = { sources: all.slice(offset, offset + 100).map(e => ({ id: e.id, version: e.sha256, name: e.name, size: e.size })), nextOffset: offset + 100 < all.length ? offset + 100 : null, limited: index.limited };
      } else {
        const method = { import: 'import', list: 'list', create: 'create', read: 'read', update: 'update', export: 'export', status: 'render/read', cancel: 'render/cancel' }[params.action];
        if (!method) throw expose('Invalid edit action');
        value = await studio.handlers[`studio/edit/${method}`](params);
      }
    }
    else if (name === 'article_video') {
      if (!['create', 'list', 'read', 'save', 'voice', 'import-audio', 'build', 'render', 'cancel', 'playback'].includes(params.action)) throw expose('Invalid article video action');
      value = await studio.handlers[`studio/article/${params.action}`](params);
    }
    else if (name === 'media_subtitles') {
      const action = { start: 'start', status: 'read', cancel: 'cancel', apply: 'apply', import: 'import', export: 'export' }[params.action];
      if (!action) throw expose('Invalid subtitle action');
      value = await studio.handlers[`studio/edit/subtitles/${action}`](params);
    }
    else if (name === 'media_retake') {
      const action = { start: 'start', status: 'read', cancel: 'cancel', apply: 'apply', undo: 'undo' }[params.action];
      if (!action) throw expose('Invalid retake action');
      value = await studio.handlers[`studio/edit/retake/${action}`]({ ...params, agentRequested: true });
    }
    else if (name === 'media_sequence_control') {
      const action = params.action;
      if (!['start', 'pause', 'resume', 'cancel'].includes(action)) throw expose('Invalid sequence action');
      if (['start', 'resume'].includes(action)) {
        const sequence = await studio.handlers['studio/sequence/read']({ id: params.id });
        for (const shot of sequence.shots.filter(s => !s.jobId)) if (!studio.profiles.get(shot.profileId).agentEnabled) throw expose('This model is not enabled for Agent use');
      }
      value = await studio.handlers[`studio/sequence/${action}`]({ id: params.id, agentRequested: true });
    }
    else if (name === 'media_templates') {
      const action = params.action ?? 'list';
      if (action === 'list') value = await studio.handlers['studio/template/list']({ query: params.query });
      else if (action === 'read') value = await studio.handlers['studio/template/read']({ id: params.id, revision: params.revision });
      else if (action === 'render') value = await studio.handlers['studio/template/render']({ id: params.id, revision: params.revision, params: params.params });
      else if (action === 'save') value = await studio.handlers['studio/template/save']({ id: params.id, expectedRevision: params.expectedRevision, name: params.name, kind: params.kind, prompt: params.prompt, defaults: params.defaults });
      else if (action === 'remove') value = await studio.handlers['studio/template/remove']({ id: params.id, expectedRevision: params.expectedRevision });
      else throw expose('Invalid template action');
    }
    else throw expose('Unknown media tool');
    return value;
  } catch (error) {
    // Provider/daemon messages carry a deliberate wording (rpc.message or
    // expose); anything else must not leak local paths or internals.
    console.error('[studio-mcp] tool failed', name, error);
    throw error;
  }
}

async function createStudioMcp({ getStudio, getLibrary, getLearning, getCatalog }) {
  const token = crypto.randomBytes(32).toString('hex');
  // Learning/catalog packs extend the Kernel's tool surface with the same
  // descriptors the creative CLI serves; hosts opt in by passing the getters.
  const packTools = () => [...(getLearning?.()?.toolDescriptors?.() ?? []), ...(getCatalog?.()?.toolDescriptors?.() ?? [])];
  const callPackTool = async (name, params) => {
    const learningValue = await getLearning?.()?.callTool?.(name, params);
    if (learningValue !== undefined) return learningValue;
    return getCatalog?.()?.callTool?.(name, params);
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, result) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(result ? JSON.stringify(result) : undefined); };
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { send(403); return; }
    if (req.method !== 'POST') { send(405); return; }
    let length = 0; const chunks = []; let message;
    try { for await (const chunk of req) { length += chunk.length; if (length > 3 * 1024 * 1024) { send(413); return; } chunks.push(chunk); } message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { send(400); return; }
    const reply = result => send(200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') { reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'knorvia-media', version: '1.0.0' } }); return; }
    if (message.id === undefined) { send(202); return; }
    if (message.method === 'ping') { reply({}); return; }
    if (message.method === 'tools/list') { reply({ tools: [...TOOLS, ...packTools()] }); return; }
    if (message.method !== 'tools/call') { send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    try {
      const studio = getStudio();
      const library = typeof getLibrary === 'function' ? getLibrary() : null;
      const { name, arguments: params = {} } = message.params || {};
      let value;
      try {
        const packValue = await callPackTool(name, params);
        value = packValue !== undefined ? packValue : await callMediaTool({ studio, library, name, params });
      } catch (error) {
        const replyText = error.rpc?.message || (error.expose === true ? error.message : 'The media request failed unexpectedly; details were written to the application log');
        reply({ content: [{ type: 'text', text: replyText }], isError: true });
        return;
      }
      reply({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
    } catch (error) {
      console.error('[studio-mcp] tools/call failed', error);
      send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { env: { KNORVIA_STUDIO_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, KNORVIA_STUDIO_MCP_TOKEN: token }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createStudioMcp, callMediaTool, TOOLS };
