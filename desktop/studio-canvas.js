'use strict';

// Canvas domain engine. Manages personal infinite canvases stored in the personal
// library as `画布/<uuid>.knorvia-canvas.json`, applying strict CAS revision
// concurrency, graph DAG validation, server-owned job fields, and durable
// generation intents with upstream wire composition.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./studio-providers');
const { withLock } = require('./media-lock');

function fail(message, code = -32602) {
  const e = new Error(message);
  e.rpc = { code, message };
  e.expose = true;
  throw e;
}

function formatStudioIdempotencyKey(canvasId, nodeId, idempotencyKey) {
  const hash = crypto.createHash('sha256').update(`canvas:${canvasId}:${nodeId}:${idempotencyKey}`).digest('hex');
  return `canvas-${hash.slice(0, 64)}`;
}

const METHODS = [
  'studio/canvas/list',
  'studio/canvas/create',
  'studio/canvas/read',
  'studio/canvas/save',
  'studio/canvas/generate',
];

const MAX_NODES = 80;
const MAX_EDGES = 200;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024; // 2 MiB limit for canvas document
const MAX_TITLE_LENGTH = 120;
const MAX_PROMPT_LENGTH = 8000;
const MAX_GLOBAL_PROMPT_LENGTH = 8000;
const CANVAS_DIR = '画布';
const CANVAS_EXT = '.knorvia-canvas.json';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;
const NODE_KINDS = new Set(['text', 'asset', 'image', 'video']);
const EDGE_ROLES = new Set(['context', 'reference', 'firstFrame', 'lastFrame']);
const now = () => new Date().toISOString();

function canvasPath(id) {
  if (!id || !UUID_REGEX.test(id)) fail('Invalid canvas ID');
  return `${CANVAS_DIR}/${id}${CANVAS_EXT}`;
}

// Multi-chunk library reader to safely handle documents > 512 KiB (up to 2 MiB)
async function readLibraryFileText(library, entryId, pinnedSha) {
  let offset = 0;
  let totalBytes = 0;
  const chunks = [];
  do {
    const part = await library.handlers['library/read']({
      id: entryId,
      version: pinnedSha,
      offset,
    });
    const buf = Buffer.from(part.base64, 'base64');
    totalBytes += buf.length;
    if (totalBytes > MAX_DOCUMENT_BYTES) {
      fail('画布文件超出大小上限');
    }
    chunks.push(buf);
    offset = part.nextOffset;
  } while (offset !== null);
  return Buffer.concat(chunks).toString('utf8');
}

// Verify that an image reference exists in the library with the exact pinned SHA and valid image bytes
async function verifyLibraryImage(library, entryId, version) {
  if (!version || !SHA256_REGEX.test(version)) {
    fail(`Invalid image reference SHA256 version: ${version}`);
  }
  const part = await library.handlers['library/read']({
    id: entryId,
    version,
    offset: 0,
  }).catch(() => {
    fail(`参考资料在资料库中不存在或版本不匹配: ${entryId} (${version})`, -32004);
  });
  const buf = Buffer.from(part.base64, 'base64');
  if (buf.length < 8) fail('参考图片文件损坏或不完整');
  const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  const isGif = /^GIF8[79]a/.test(buf.toString('ascii', 0, 6));
  if (!isPng && !isJpg && !isWebp && !isGif) {
    fail('参考资料不是支持的有效图片格式 (PNG/JPG/WEBP/GIF)');
  }
}

function validateGraph(nodes, edges) {
  if (!Array.isArray(nodes)) fail('nodes must be an array');
  if (nodes.length > MAX_NODES) fail(`Canvas cannot exceed ${MAX_NODES} nodes`);
  if (!Array.isArray(edges)) fail('edges must be an array');
  if (edges.length > MAX_EDGES) fail(`Canvas cannot exceed ${MAX_EDGES} edges`);

  const nodeIds = new Set();
  const cleanNodes = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Invalid node');
    const id = P.id(raw.id, 80);
    if (nodeIds.has(id)) fail(`Duplicate node id: ${id}`);
    nodeIds.add(id);

    const kind = P.text(raw.kind, 20);
    if (!NODE_KINDS.has(kind)) fail(`Invalid node kind: ${kind}`);

    const title = P.text(raw.title || '', MAX_TITLE_LENGTH);
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`Node ${id} coordinates must be finite numbers`);

    const node = { id, kind, title, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };

    if (raw.prompt !== undefined && raw.prompt !== null) {
      node.prompt = P.text(raw.prompt, MAX_PROMPT_LENGTH);
    }
    if (raw.profileId !== undefined && raw.profileId !== null && raw.profileId !== '') {
      node.profileId = P.text(raw.profileId, 100);
    }
    if (raw.reference) {
      if (typeof raw.reference !== 'object' || Array.isArray(raw.reference)) fail('Invalid reference object');
      const refId = P.text(raw.reference.id, 100);
      const version = P.text(raw.reference.version, 64);
      if (!SHA256_REGEX.test(version)) fail('Reference version must be a 64-character SHA-256 hash');
      const refObj = { id: refId, version };
      if (raw.reference.name !== undefined && raw.reference.name !== null) {
        refObj.name = P.text(raw.reference.name, 120);
      }
      node.reference = refObj;
    }
    if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
      node.settings = {};
      if (raw.settings.size) node.settings.size = P.text(raw.settings.size, 20);
      if (raw.settings.aspect) node.settings.aspect = P.text(raw.settings.aspect, 20);
      if (Number.isInteger(raw.settings.count) && raw.settings.count > 0 && raw.settings.count <= 10) {
        node.settings.count = raw.settings.count;
      }
      if (Number.isInteger(raw.settings.seconds) && raw.settings.seconds > 0 && raw.settings.seconds <= 60) {
        node.settings.seconds = raw.settings.seconds;
      }
      if (raw.settings.quality) node.settings.quality = P.text(raw.settings.quality, 20);
    }

    cleanNodes.push(node);
  }

  const nodeMap = new Map(cleanNodes.map(n => [n.id, n]));
  const edgeIds = new Set();
  const edgePairs = new Set();
  const incomingFirstFrame = new Map();
  const incomingLastFrame = new Map();
  const incomingReference = new Map();
  const cleanEdges = [];

  for (const raw of edges) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Invalid edge');
    const id = P.id(raw.id, 80);
    if (edgeIds.has(id)) fail(`Duplicate edge id: ${id}`);
    edgeIds.add(id);

    const from = P.id(raw.from, 80);
    const to = P.id(raw.to, 80);
    const role = P.text(raw.role, 30);

    if (!nodeIds.has(from)) fail(`Edge from node does not exist: ${from}`);
    if (!nodeIds.has(to)) fail(`Edge to node does not exist: ${to}`);
    if (from === to) fail(`Edge cannot connect node to itself: ${from}`);
    if (!EDGE_ROLES.has(role)) fail(`Invalid edge role: ${role}`);

    const pairKey = `${from}->${to}:${role}`;
    if (edgePairs.has(pairKey)) fail(`Duplicate edge between ${from} and ${to} with role ${role}`);
    edgePairs.add(pairKey);

    const fromNode = nodeMap.get(from);
    const toNode = nodeMap.get(to);

    // Validate edge role & node kind constraints
    if (role === 'context') {
      if (fromNode.kind !== 'text') {
        fail(`context edge from node must be 'text', got '${fromNode.kind}'`);
      }
      if (toNode.kind === 'asset') {
        fail("context edge cannot connect to 'asset' node");
      }
    } else if (role === 'reference') {
      if (!['asset', 'image'].includes(fromNode.kind)) {
        fail(`reference edge from node must be 'asset' or 'image', got '${fromNode.kind}'`);
      }
      if (toNode.kind !== 'image') {
        fail(`reference edge to node must be 'image', got '${toNode.kind}'`);
      }
      const refCount = (incomingReference.get(to) || 0) + 1;
      if (refCount > 6) {
        fail(`图片节点参考图连线不能超过 6 条: ${to}`);
      }
      incomingReference.set(to, refCount);
    } else if (role === 'firstFrame') {
      if (!['asset', 'image', 'video'].includes(fromNode.kind)) {
        fail(`firstFrame edge from node must be 'asset', 'image' or 'video', got '${fromNode.kind}'`);
      }
      if (toNode.kind !== 'video') {
        fail(`firstFrame edge to node must be 'video', got '${toNode.kind}'`);
      }
      const ffCount = (incomingFirstFrame.get(to) || 0) + 1;
      if (ffCount > 1) {
        fail(`视频节点只能有一条 firstFrame 连线: ${to}`);
      }
      incomingFirstFrame.set(to, ffCount);
    } else if (role === 'lastFrame') {
      if (!['asset', 'image'].includes(fromNode.kind)) {
        fail(`lastFrame edge from node must be 'asset' or 'image', got '${fromNode.kind}'`);
      }
      if (toNode.kind !== 'video') {
        fail(`lastFrame edge to node must be 'video', got '${toNode.kind}'`);
      }
      const lfCount = (incomingLastFrame.get(to) || 0) + 1;
      if (lfCount > 1) {
        fail(`视频节点只能有一条 lastFrame 连线: ${to}`);
      }
      incomingLastFrame.set(to, lfCount);
    }

    cleanEdges.push({ id, from, to, role });
  }

  // Cycle check
  const adj = new Map();
  for (const n of cleanNodes) adj.set(n.id, []);
  for (const e of cleanEdges) adj.get(e.from).push(e.to);

  const visited = new Set();
  const recStack = new Set();

  function hasCycle(curr) {
    visited.add(curr);
    recStack.add(curr);
    for (const neighbor of adj.get(curr) || []) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(curr);
    return false;
  }
  for (const n of cleanNodes) {
    if (!visited.has(n.id)) {
      if (hasCycle(n.id)) fail('Canvas connections cannot contain cycles');
    }
  }

  return { nodes: cleanNodes, edges: cleanEdges };
}

function createCanvasEngine({ home, rpc, library, studio }) {
  const root = studio?.root ? path.join(studio.root, 'canvas') : path.join(home, 'artifacts', 'media-studio', 'canvas');
  fs.mkdirSync(root, { recursive: true });
  const lockDir = path.join(root, 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const intentDir = path.join(root, 'intents');
  fs.mkdirSync(intentDir, { recursive: true });
  const createIntentDir = path.join(root, 'create-intents');
  fs.mkdirSync(createIntentDir, { recursive: true });

  const lockFile = id => path.join(lockDir, `${P.id(id)}.lock`);
  const intentFile = (canvasId, nodeId) => path.join(intentDir, `${P.id(canvasId)}-${P.id(nodeId)}.json`);
  const createIntentFile = key => path.join(createIntentDir, `${crypto.createHash('sha256').update(key).digest('hex')}.json`);

  async function readJobDirect(jobId) {
    if (studio && typeof studio.readJob === 'function') {
      return await studio.readJob(jobId);
    }
    if (rpc) {
      const job = await rpc('job/read', { id: P.id(jobId) }).catch(() => null);
      if (job) return studio?.publicJob ? studio.publicJob(job) : job;
    }
    if (studio && typeof studio.read === 'function') {
      return await studio.read(jobId);
    }
    if (studio?.handlers?.['studio/read']) {
      return await studio.handlers['studio/read']({ id: jobId });
    }
    fail(`Cannot read job: ${jobId}`);
  }

  async function getCanvasFileEntry(id) {
    const rel = canvasPath(id);
    const { entries } = await library.handlers['library/list']();
    const entry = entries.find(e => !e.trashedAt && !e.folder && e.path === rel);
    return entry || null;
  }

  async function readCanvasDocument(id) {
    const entry = await getCanvasFileEntry(id);
    if (!entry) fail('找不到该画布', -32004);
    const text = await readLibraryFileText(library, entry.id, entry.sha256);
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      fail('画布文件解析失败');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('画布数据格式错误');
    if (doc.schemaVersion !== 1) fail('画布数据版本不匹配');
    if (doc.id !== id) fail('画布标识不匹配');
    if (!Number.isInteger(doc.revision) || doc.revision < 1) fail('画布版本号错误');
    if (typeof doc.title !== 'string') fail('画布标题格式错误');
    if (typeof doc.globalPrompt !== 'string') fail('画布全局提示词格式错误');
    if (!Array.isArray(doc.nodes)) fail('画布节点列表格式错误');
    if (!Array.isArray(doc.edges)) fail('画布连线列表格式错误');
    return { doc, entry };
  }

  async function hydrateNodeJobs(nodes) {
    const hydrated = [];
    for (const node of nodes) {
      const copy = { ...node };
      if (copy.jobId) {
        try {
          const job = await readJobDirect(copy.jobId);
          copy.job = job;
        } catch {
          copy.job = undefined;
        }
      } else {
        delete copy.job;
      }
      hydrated.push(copy);
    }
    return hydrated;
  }

  async function list(params = {}) {
    const threadId = params.threadId ? P.text(params.threadId, 100) : undefined;
    const query = params.query ? P.text(params.query, 100).toLowerCase() : undefined;
    const { entries } = await library.handlers['library/list']();
    const canvasEntries = entries.filter(e => !e.trashedAt && !e.folder && e.path.startsWith(`${CANVAS_DIR}/`) && e.path.endsWith(CANVAS_EXT));

    const canvases = [];
    for (const entry of canvasEntries) {
      try {
        const text = await readLibraryFileText(library, entry.id, entry.sha256);
        const doc = JSON.parse(text);
        if (doc && doc.schemaVersion === 1) {
          if (threadId && doc.threadId !== threadId) continue;
          if (query && !doc.title.toLowerCase().includes(query)) continue;
          canvases.push({
            id: doc.id,
            title: doc.title,
            ...(doc.threadId ? { threadId: doc.threadId } : {}),
            revision: doc.revision,
            updatedAt: doc.updatedAt,
            nodeCount: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
          });
        }
      } catch {
        // Skip corrupted canvas files
      }
    }

    canvases.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { canvases };
  }

  async function create(params = {}) {
    const rawKey = params.idempotencyKey ? P.text(params.idempotencyKey, 128) : null;
    const title = P.text(params.title || params.name || '未命名画布', MAX_TITLE_LENGTH);
    const threadId = params.threadId ? P.text(params.threadId, 100) : undefined;
    const globalPrompt = P.text(params.globalPrompt || '', MAX_GLOBAL_PROMPT_LENGTH);
    const { nodes: cleanNodes, edges: cleanEdges } = validateGraph(params.nodes || [], params.edges || []);

    for (const n of cleanNodes) {
      delete n.jobId;
      delete n.job;
    }

    const requestBody = {
      title,
      threadId: threadId || null,
      globalPrompt,
      nodes: cleanNodes.map(n => ({ id: n.id, kind: n.kind, title: n.title, x: n.x, y: n.y, prompt: n.prompt, profileId: n.profileId, reference: n.reference, settings: n.settings })),
      edges: cleanEdges.map(e => ({ id: e.id, from: e.from, to: e.to, role: e.role })),
    };
    const bodyStr = JSON.stringify(requestBody);

    if (rawKey) {
      const lockKey = `create-${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
      return withLock(lockFile(lockKey), async () => {
        const cPath = createIntentFile(rawKey);
        const currentHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
        if (fs.existsSync(cPath)) {
          let record;
          try {
            record = JSON.parse(fs.readFileSync(cPath, 'utf8'));
          } catch {
            fail('Corrupted create intent record', -32005);
          }
          if (record && record.requestBodyHash) {
            if (record.requestBodyHash !== currentHash) {
              fail('Idempotency key conflict: parameters do not match previous create request', -32602);
            }
            try {
              const existing = await readCanvasDocument(record.canvasId);
              if (existing && existing.doc) {
                return { ...existing.doc, nodes: await hydrateNodeJobs(existing.doc.nodes) };
              }
            } catch (readErr) {
              if (readErr.rpc?.code !== -32004 && !readErr.message?.includes('找不到该画布')) {
                throw readErr;
              }
            }

            const id = record.canvasId;
            const doc = {
              schemaVersion: 1,
              id,
              title,
              ...(threadId ? { threadId } : {}),
              revision: 1,
              globalPrompt,
              nodes: cleanNodes,
              edges: cleanEdges,
              createdAt: record.createdAt || now(),
              updatedAt: now(),
            };

            const docText = JSON.stringify(doc, null, 2);
            if (Buffer.byteLength(docText, 'utf8') > MAX_DOCUMENT_BYTES) fail('画布大小超过限制');

            await library.handlers['library/write']({
              path: canvasPath(id),
              text: docText,
            });

            record.status = 'created';
            record.updatedAt = now();
            P.atomic(cPath, record);

            return doc;
          }
        }

        const id = crypto.randomUUID();
        const record = {
          idempotencyKey: rawKey,
          canvasId: id,
          requestBodyHash: currentHash,
          status: 'pending',
          createdAt: now(),
          updatedAt: now(),
        };
        P.atomic(cPath, record);

        const doc = {
          schemaVersion: 1,
          id,
          title,
          ...(threadId ? { threadId } : {}),
          revision: 1,
          globalPrompt,
          nodes: cleanNodes,
          edges: cleanEdges,
          createdAt: now(),
          updatedAt: now(),
        };

        const docText = JSON.stringify(doc, null, 2);
        if (Buffer.byteLength(docText, 'utf8') > MAX_DOCUMENT_BYTES) fail('画布大小超过限制');

        await library.handlers['library/write']({
          path: canvasPath(id),
          text: docText,
        });

        record.status = 'created';
        record.updatedAt = now();
        P.atomic(cPath, record);

        return doc;
      });
    }

    const id = crypto.randomUUID();
    const doc = {
      schemaVersion: 1,
      id,
      title,
      ...(threadId ? { threadId } : {}),
      revision: 1,
      globalPrompt,
      nodes: cleanNodes,
      edges: cleanEdges,
      createdAt: now(),
      updatedAt: now(),
    };

    const docText = JSON.stringify(doc, null, 2);
    if (Buffer.byteLength(docText, 'utf8') > MAX_DOCUMENT_BYTES) fail('画布大小超过限制');

    await library.handlers['library/write']({
      path: canvasPath(id),
      text: docText,
    });

    return doc;
  }

  async function read(params) {
    const id = P.id(params?.id);
    if (!UUID_REGEX.test(id)) fail('Invalid canvas ID');
    const { doc } = await readCanvasDocument(id);
    const hydratedNodes = await hydrateNodeJobs(doc.nodes);
    return { ...doc, nodes: hydratedNodes };
  }

  async function save(params) {
    const id = P.id(params?.id);
    if (!UUID_REGEX.test(id)) fail('Invalid canvas ID');
    const revision = params?.revision ?? params?.expectedRevision;
    if (!Number.isInteger(revision) || revision < 1) fail('Invalid revision');

    // Rule 9: Reject missing / non-array nodes or edges
    if (!Array.isArray(params?.nodes) || !Array.isArray(params?.edges)) {
      fail('nodes and edges arrays are required for save');
    }

    return withLock(lockFile(id), async () => {
      const { doc: existing, entry: existingEntry } = await readCanvasDocument(id);
      if (existing.revision !== revision) {
        fail('画布已被另一个窗口修改，请刷新后重试', -32005);
      }

      const title = P.text(params.title || params.name || existing.title || '未命名画布', MAX_TITLE_LENGTH);
      const globalPrompt = P.text(params.globalPrompt !== undefined ? params.globalPrompt : existing.globalPrompt || '', MAX_GLOBAL_PROMPT_LENGTH);
      const { nodes: cleanNodes, edges: cleanEdges } = validateGraph(params.nodes, params.edges);

      // Rule 3: Check running nodes AND pending intents
      const existingNodeMap = new Map(existing.nodes.map(n => [n.id, n]));
      for (const exNode of existing.nodes) {
        const iPath = intentFile(id, exNode.id);
        let hasPendingIntent = false;
        if (fs.existsSync(iPath)) {
          let intent;
          try {
            intent = JSON.parse(fs.readFileSync(iPath, 'utf8'));
          } catch {
            fail(`Bad intent file for node ${exNode.id}`, -32005);
          }
          if (intent && intent.status !== 'completed') {
            if (!intent.jobId) {
              hasPendingIntent = true;
            } else {
              const job = await readJobDirect(intent.jobId).catch(() => null);
              if (!job || job.phase === 'unknown' || job.remoteMayContinue || !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
                hasPendingIntent = true;
              }
            }
          }
        }

        let isRunning = hasPendingIntent;
        if (exNode.jobId) {
          const job = await readJobDirect(exNode.jobId).catch(() => null);
          if (!job || job.phase === 'unknown' || job.remoteMayContinue || !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
            isRunning = true;
          }
        }

        if (isRunning) {
          const matchingNewNode = cleanNodes.find(n => n.id === exNode.id);
          if (!matchingNewNode) {
            fail(`正在生成中或有未决意图的节点不能被删除: ${exNode.title || exNode.id}`);
          }
          if (matchingNewNode.kind !== exNode.kind) {
            fail(`正在生成中的节点不能更改类型: ${exNode.title || exNode.id}`);
          }
        }
      }

      // Rule 9: Reconcile nodes: preserve server-owned runtime properties (jobId)
      // If kind changed, do NOT inherit mismatched jobId!
      const reconciledNodes = cleanNodes.map(n => {
        const copy = { ...n };
        const exNode = existingNodeMap.get(n.id);
        if (exNode && exNode.jobId && exNode.kind === n.kind) {
          copy.jobId = exNode.jobId;
        } else {
          const iPath = intentFile(id, n.id);
          if (fs.existsSync(iPath)) {
            try {
              const intent = JSON.parse(fs.readFileSync(iPath, 'utf8'));
              if (intent && intent.jobId && (!exNode || exNode.kind === n.kind)) {
                copy.jobId = intent.jobId;
              }
            } catch {}
          }
          if (!copy.jobId) delete copy.jobId;
        }
        delete copy.job;
        return copy;
      });

      const nextDoc = {
        ...existing,
        title,
        revision: existing.revision + 1,
        globalPrompt,
        nodes: reconciledNodes,
        edges: cleanEdges,
        updatedAt: now(),
      };

      const docText = JSON.stringify(nextDoc, null, 2);
      if (Buffer.byteLength(docText, 'utf8') > MAX_DOCUMENT_BYTES) fail('画布大小超过限制');

      await library.handlers['library/write']({
        path: canvasPath(id),
        text: docText,
        expectedSha256: existingEntry.sha256,
      });

      const hydratedNodes = await hydrateNodeJobs(nextDoc.nodes);
      return { ...nextDoc, nodes: hydratedNodes };
    });
  }

  async function resolveImageReference(srcNode) {
    if (srcNode.kind === 'asset') {
      if (!srcNode.reference || !srcNode.reference.id || !srcNode.reference.version) {
        fail(`上游素材节点缺少引用资料: ${srcNode.title || srcNode.id}`);
      }
      await verifyLibraryImage(library, srcNode.reference.id, srcNode.reference.version);
      const name = srcNode.reference.name ? P.text(srcNode.reference.name, 120) : (P.text(srcNode.title || '', 120) || undefined);
      return { id: srcNode.reference.id, version: srcNode.reference.version, ...(name ? { name } : {}) };
    }
    if (srcNode.kind === 'image') {
      if (!srcNode.jobId) {
        fail(`上游图片节点尚未生成: ${srcNode.title || srcNode.id}`);
      }
      const job = await readJobDirect(srcNode.jobId).catch(() => null);
      if (!job) fail(`上游节点任务不存在: ${srcNode.jobId}`);
      if (job.status !== 'succeeded') {
        fail(`上游节点未生成成功 (状态: ${job.status}): ${srcNode.title || srcNode.id}`);
      }
      const output = job.outputs?.[0] || job.output;
      if (!output || !output.name) fail('上游节点无可用生成产物');
      const sha256 = output.sha256;
      if (!sha256 || !SHA256_REGEX.test(sha256)) fail('上游节点生成产物缺少有效 SHA256 校验和');

      const destination = `创作/${output.name}`;
      const { entries } = await library.handlers['library/list']();
      let entry = entries.find(item => !item.trashedAt && item.path === destination && item.sha256 === sha256);
      if (!entry) {
        entry = await studio.handlers['studio/library']({ id: srcNode.jobId, index: 0 }).catch(() => null);
      }
      if (!entry || !entry.id) {
        const { entries: updated } = await library.handlers['library/list']();
        entry = updated.find(item => !item.trashedAt && item.path === destination && item.sha256 === sha256);
      }
      if (!entry || !entry.id) {
        fail(`无法将上游产物存入个人资料库作为有效引用: ${output.name}`);
      }
      await verifyLibraryImage(library, entry.id, entry.sha256 || sha256);
      const name = P.text(output.name, 120);
      return { id: entry.id, version: entry.sha256 || sha256, ...(name ? { name } : {}) };
    }
    fail(`不支持作为图片引用的节点类型: ${srcNode.kind}`);
  }

  async function resolveVideoFrame(srcNode, role) {
    if (srcNode.kind === 'asset') {
      if (!srcNode.reference || !srcNode.reference.id || !srcNode.reference.version) {
        fail(`上游素材节点缺少引用资料: ${srcNode.title || srcNode.id}`);
      }
      await verifyLibraryImage(library, srcNode.reference.id, srcNode.reference.version);
      const name = srcNode.reference.name ? P.text(srcNode.reference.name, 120) : (P.text(srcNode.title || '', 120) || undefined);
      return { id: srcNode.reference.id, version: srcNode.reference.version, ...(name ? { name } : {}) };
    }
    if (srcNode.kind === 'image') {
      return await resolveImageReference(srcNode);
    }
    if (srcNode.kind === 'video') {
      if (role !== 'firstFrame') {
        fail("只有 'firstFrame' 角色支持从视频节点导出首尾帧");
      }
      if (!srcNode.jobId) fail(`上游视频节点尚未开始生成: ${srcNode.title || srcNode.id}`);
      const job = await readJobDirect(srcNode.jobId).catch(() => null);
      if (!job || job.status !== 'succeeded') {
        fail(`上游视频节点尚未生成成功: ${srcNode.title || srcNode.id}`);
      }
      const frameRecord = await studio.handlers['studio/frame/export']({ id: srcNode.jobId, index: 0 });
      const id = frameRecord.libraryId || frameRecord.library?.id || frameRecord.id;
      const version = frameRecord.libraryVersion || frameRecord.library?.version || frameRecord.sha256;
      if (!id || !version) fail('导出尾帧失败，未获取到有效资料库编号或版本');
      await verifyLibraryImage(library, id, version);
      const name = frameRecord.name ? P.text(frameRecord.name, 120) : 'frame.png';
      return { id, version, name };
    }
    fail(`不支持作为帧引用的节点类型: ${srcNode.kind}`);
  }

  async function generate(params) {
    const id = P.id(params?.id);
    if (!UUID_REGEX.test(id)) fail('Invalid canvas ID');
    const revision = params?.revision ?? params?.expectedRevision;
    const nodeId = P.id(params?.nodeId, 80);
    if (!nodeId) fail('nodeId is required');
    const idempotencyKey = P.text(params?.idempotencyKey, 128);
    if (!idempotencyKey) fail('idempotencyKey is required');
    const agentRequested = Boolean(params?.agentRequested);

    return withLock(lockFile(id), async () => {
      const { doc, entry } = await readCanvasDocument(id);
      const node = doc.nodes.find(n => n.id === nodeId);
      if (!node) fail('找不到该节点');

      const iPath = intentFile(id, nodeId);
      let intent = null;
      if (fs.existsSync(iPath)) {
        try {
          intent = JSON.parse(fs.readFileSync(iPath, 'utf8'));
        } catch {
          fail('Corrupted intent file detected for node', -32005);
        }
      }

      // Check existing intent
      if (intent) {
        if (intent.idempotencyKey === idempotencyKey) {
          // Actor check: reject if agentRequested differs
          if (Boolean(intent.agentRequested) !== agentRequested) {
            fail('Idempotency key conflict: agentRequested does not match previous intent', -32602);
          }
          // Revision check on retry: allow current doc.revision or original intent.revision
          if (revision !== undefined && revision !== null) {
            if (revision !== doc.revision && (intent.revision === undefined || revision !== intent.revision)) {
              fail('画布已被另一个窗口修改，请刷新后重试', -32005);
            }
          }

          // Same key retry
          if (intent.jobId) {
            const existingJob = await readJobDirect(intent.jobId).catch(() => null);
            if (!existingJob) {
              fail(`Intent references unknown job: ${intent.jobId}`, -32005);
            }
            if (node.jobId !== intent.jobId) {
              node.jobId = intent.jobId;
              delete node.job;
              const nextDoc = {
                ...doc,
                revision: doc.revision + 1,
                updatedAt: now(),
              };
              await library.handlers['library/write']({
                path: canvasPath(id),
                text: JSON.stringify(nextDoc, null, 2),
                expectedSha256: entry.sha256,
              });
              return { canvas: { ...nextDoc, nodes: await hydrateNodeJobs(nextDoc.nodes) }, job: existingJob };
            }
            return { canvas: { ...doc, nodes: await hydrateNodeJobs(doc.nodes) }, job: existingJob };
          } else {
            // Intent without jobId: reuse old intent.requestParams and studioIdempotencyKey!
            const studioKey = intent.studioIdempotencyKey || formatStudioIdempotencyKey(id, nodeId, idempotencyKey);
            let createdJob;
            try {
              createdJob = await studio.create({ ...intent.requestParams, idempotencyKey: studioKey }, intent.agentRequested);
            } catch (err) {
              fail(err.message || 'Generation failed', err.rpc?.code || -32602);
            }
            intent.jobId = createdJob.id;
            intent.status = 'submitted';
            intent.updatedAt = now();
            P.atomic(iPath, intent);

            node.jobId = createdJob.id;
            delete node.job;
            const nextDoc = {
              ...doc,
              revision: doc.revision + 1,
              updatedAt: now(),
            };
            await library.handlers['library/write']({
              path: canvasPath(id),
              text: JSON.stringify(nextDoc, null, 2),
              expectedSha256: entry.sha256,
            });
            return { canvas: { ...nextDoc, nodes: await hydrateNodeJobs(nextDoc.nodes) }, job: createdJob };
          }
        } else {
          // Different idempotencyKey!
          if (intent.status !== 'completed') {
            if (!intent.jobId) {
              fail('Previous generation intent is unresolved for this node; must retry with original idempotency key', -32005);
            }
            const existingJob = await readJobDirect(intent.jobId).catch(() => null);
            if (!existingJob || !['succeeded', 'failed', 'cancelled'].includes(existingJob.status)) {
              fail('Generation is already in progress for this node', -32005);
            }
          }
        }
      }

      // For new requests (not matching intent retry):
      // Revision is required and CAS enforced
      if (revision === undefined || revision === null || !Number.isInteger(revision) || revision < 1) {
        fail('revision is required for new generation request', -32602);
      }
      if (doc.revision !== revision) {
        fail('画布已被另一个窗口修改，请刷新后重试', -32005);
      }

      if (!['image', 'video'].includes(node.kind)) {
        fail('只有图片和视频节点支持生成');
      }
      if (!node.profileId) {
        fail('请为该节点选择模型');
      }

      const profile = studio.profiles.get(node.profileId);
      if (!profile) fail('所选模型连接不存在');
      if (profile.kind !== node.kind) {
        fail('选择的模型与节点类型不匹配');
      }
      if (agentRequested && !profile.agentEnabled) {
        fail('This model is not enabled for Agent use', -32602);
      }

      // Check running node status
      if (node.jobId) {
        const currentJob = await readJobDirect(node.jobId).catch(() => null);
        if (!currentJob || currentJob.phase === 'unknown' || currentJob.remoteMayContinue || !['succeeded', 'failed', 'cancelled'].includes(currentJob.status)) {
          fail('Generation is already in progress for this node', -32005);
        }
      }

      // Wire resolution:
      const nodeMap = new Map(doc.nodes.map(n => [n.id, n]));
      const incomingEdges = doc.edges.filter(e => e.to === nodeId);

      // Validate multiplicity limits on incoming edges
      const refEdges = incomingEdges.filter(e => e.role === 'reference');
      if (refEdges.length > 6) {
        fail(`图片节点参考图连线不能超过 6 条: ${nodeId}`);
      }
      const ffEdges = incomingEdges.filter(e => e.role === 'firstFrame');
      if (ffEdges.length > 1) {
        fail(`视频节点只能有一条 firstFrame 连线: ${nodeId}`);
      }
      const lfEdges = incomingEdges.filter(e => e.role === 'lastFrame');
      if (lfEdges.length > 1) {
        fail(`视频节点只能有一条 lastFrame 连线: ${nodeId}`);
      }

      // Validate all incoming edges
      for (const e of incomingEdges) {
        const fromNode = nodeMap.get(e.from);
        if (!fromNode) fail(`连线上游节点不存在: ${e.from}`);
        if (e.role === 'context') {
          if (fromNode.kind !== 'text') fail(`Context 连线上游节点必须为 text 类型: ${fromNode.id}`);
        } else if (e.role === 'reference') {
          if (!['asset', 'image'].includes(fromNode.kind)) fail(`Reference 连线上游节点必须为 asset 或 image 类型: ${fromNode.id}`);
          if (node.kind !== 'image') fail(`Reference 连线目标必须为 image 类型: ${node.id}`);
        } else if (e.role === 'firstFrame') {
          if (!['asset', 'image', 'video'].includes(fromNode.kind)) fail(`FirstFrame 连线上游节点必须为 asset, image 或 video: ${fromNode.id}`);
          if (node.kind !== 'video') fail(`FirstFrame 连线目标必须为 video 类型: ${node.id}`);
        } else if (e.role === 'lastFrame') {
          if (!['asset', 'image'].includes(fromNode.kind)) fail(`LastFrame 连线上游节点必须为 asset 或 image: ${fromNode.id}`);
          if (node.kind !== 'video') fail(`LastFrame 连线目标必须为 video 类型: ${node.id}`);
        } else {
          fail(`未知连线角色: ${e.role}`);
        }
      }

      // 1. Text context (topological transitive ancestry)
      const textAncestors = [];
      const visitedText = new Set();
      function collectTextAncestors(currId) {
        const parents = doc.edges.filter(e => e.to === currId && e.role === 'context').map(e => e.from);
        for (const pId of parents) {
          if (!visitedText.has(pId)) {
            visitedText.add(pId);
            collectTextAncestors(pId);
            const pNode = nodeMap.get(pId);
            if (pNode && pNode.prompt) textAncestors.push(pNode.prompt);
          }
        }
      }
      collectTextAncestors(nodeId);

      const promptParts = [];
      if (doc.globalPrompt) promptParts.push(doc.globalPrompt);
      for (const t of textAncestors) promptParts.push(t);
      if (node.prompt) promptParts.push(node.prompt);
      const finalPrompt = promptParts.filter(Boolean).join('\n\n');
      if (!finalPrompt.trim()) fail('生成需要提示词');

      // 2. Reference edges
      const resolvedReferences = [];
      for (const e of refEdges) {
        const fromNode = nodeMap.get(e.from);
        const ref = await resolveImageReference(fromNode);
        resolvedReferences.push(ref);
      }

      // 3. FirstFrame edge
      let resolvedFirstFrame = undefined;
      if (ffEdges.length === 1) {
        const fromNode = nodeMap.get(ffEdges[0].from);
        resolvedFirstFrame = await resolveVideoFrame(fromNode, 'firstFrame');
      }

      // 4. LastFrame edge
      let resolvedLastFrame = undefined;
      if (lfEdges.length === 1) {
        const fromNode = nodeMap.get(lfEdges[0].from);
        resolvedLastFrame = await resolveVideoFrame(fromNode, 'lastFrame');
      }

      const requestParams = {
        profileId: node.profileId,
        prompt: finalPrompt,
        ...(resolvedReferences.length > 0 ? { references: resolvedReferences } : {}),
        ...(resolvedFirstFrame ? { firstFrame: resolvedFirstFrame } : {}),
        ...(resolvedLastFrame ? { lastFrame: resolvedLastFrame } : {}),
        ...(node.settings || {}),
      };

      // Pure parameter pre-validation BEFORE writing pending intent
      let prepareInputFn = studio?.prepareInput;
      if (typeof prepareInputFn !== 'function') {
        try {
          const mediaStudio = require('./media-studio');
          prepareInputFn = mediaStudio.prepareCreateInput;
        } catch {}
      }
      if (typeof prepareInputFn === 'function') {
        const profileToValidate = {
          protocol: profile.protocol || (profile.kind === 'video' ? 'fal' : 'openai'),
          model: profile.model || (profile.kind === 'video' ? 'fal-ai/kling-video/v3/standard/image-to-video' : 'model'),
          custom: {
            ...(profile.kind === 'video' ? { firstFrameField: 'start_image_url', lastFrameField: 'end_image_url' } : {}),
            ...(profile.custom || {}),
          },
          ...profile,
        };
        prepareInputFn(profileToValidate, requestParams, agentRequested);
      }

      const studioIdempotencyKey = formatStudioIdempotencyKey(id, nodeId, idempotencyKey);
      const intentRecord = {
        canvasId: id,
        nodeId,
        idempotencyKey,
        studioIdempotencyKey,
        status: 'pending',
        jobId: null,
        revision: doc.revision,
        profileId: node.profileId,
        agentRequested,
        profileSnapshot: {
          id: profile.id,
          kind: profile.kind,
          agentEnabled: profile.agentEnabled,
        },
        requestParams,
        createdAt: now(),
        updatedAt: now(),
      };
      P.atomic(iPath, intentRecord);

      let createdJob;
      try {
        createdJob = await studio.create({
          ...requestParams,
          idempotencyKey: studioIdempotencyKey,
        }, agentRequested);
      } catch (createErr) {
        throw createErr;
      }

      intentRecord.jobId = createdJob.id;
      intentRecord.status = 'submitted';
      intentRecord.updatedAt = now();
      P.atomic(iPath, intentRecord);

      node.jobId = createdJob.id;
      delete node.job;
      const nextDoc = {
        ...doc,
        revision: doc.revision + 1,
        updatedAt: now(),
      };

      const docText = JSON.stringify(nextDoc, null, 2);
      await library.handlers['library/write']({
        path: canvasPath(id),
        text: docText,
        expectedSha256: entry.sha256,
      });

      const hydratedNodes = await hydrateNodeJobs(nextDoc.nodes);
      return { canvas: { ...nextDoc, nodes: hydratedNodes }, job: createdJob };
    });
  }

  async function recover() {
    if (!fs.existsSync(intentDir)) return;
    const files = await fsp.readdir(intentDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const iFile = path.join(intentDir, file);
        const record = JSON.parse(await fsp.readFile(iFile, 'utf8'));
        if (record && record.jobId && record.status === 'submitted') {
          const job = await readJobDirect(record.jobId).catch(() => null);
          if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
            record.status = 'completed';
            record.updatedAt = now();
            P.atomic(iFile, record);
          }
        }
      } catch {}
    }
  }

  const handlers = {
    'studio/canvas/list': list,
    'studio/canvas/create': create,
    'studio/canvas/read': read,
    'studio/canvas/save': save,
    'studio/canvas/generate': generate,
  };

  return {
    handlers,
    recover,
    async close() {},
    root,
  };
}

module.exports = {
  createCanvasEngine,
  METHODS,
  validateGraph,
  CANVAS_DIR,
  CANVAS_EXT,
};
