'use strict';

// Portable, offline conversion of an Agent-authored story to existing media tools.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const GROUPS = [['characters', '角色'], ['scenes', '场景'], ['props', '道具']];
const MAX_BYTES = 512 * 1024;
const fail = message => { throw new Error(message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function object(value, fields, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${where}必须是 JSON 对象`);
  if (Object.keys(value).some(key => !fields.includes(key))) fail(`${where}含未知字段，请对照 Plan v1`);
  return value;
}
function text(value, max, where, required = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) fail(`${where}必须是${required ? '非空' : ''}文本，最多 ${max} 字符`);
  return value.trim();
}
function id(value, where, max = 64) {
  if (typeof value !== 'string' || value.length > max || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) fail(`${where}需为 ASCII 标识，最多 ${max} 字符`);
  return value;
}
function reference(value, where) {
  object(value, ['id', 'version'], where);
  id(value.id, `${where}.id`, 90);
  if (typeof value.version !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.version)) fail(`${where}.version 需为资料库图片的 64 位 SHA-256，不能使用 URL 或未固定版本的素材`);
  return { id: value.id, version: value.version.toLowerCase() };
}
function array(value, where, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${where}必须是数组，最多 ${max} 项`);
  return value;
}
function normalizePlan(input) {
  const raw = object(input, ['schemaVersion', 'id', 'title', 'globalPrompt', 'aspect', 'characters', 'scenes', 'props', 'shots'], '计划');
  if (raw.schemaVersion !== 1) fail('schemaVersion 必须为 1');
  const plan = {
    schemaVersion: 1, id: id(raw.id, '计划 id'), title: text(raw.title, 100, '标题', true),
    globalPrompt: raw.globalPrompt === undefined ? '' : text(raw.globalPrompt, 6000, '全局提示词'),
    aspect: raw.aspect === undefined ? '16:9' : raw.aspect,
  };
  if (!['16:9', '9:16', '1:1'].includes(plan.aspect)) fail('aspect 仅支持 16:9、9:16、1:1');
  const entities = new Map();
  for (const [group, label] of GROUPS) {
    plan[group] = array(raw[group] === undefined ? [] : raw[group], label, 30).map(item => {
      object(item, ['id', 'name', 'description', 'reference'], label);
      const entity = { id: id(item.id, `${label} id`), name: text(item.name, 100, `${label}名称`, true), description: text(item.description, 1800, `${label}描述`, true) };
      if (entities.has(entity.id)) fail('角色、场景、道具 id 不能重复');
      if (item.reference !== undefined) entity.reference = reference(item.reference, `${label}参考图`);
      entities.set(entity.id, { ...entity, group, label });
      return entity;
    });
  }
  if (entities.size > 30) fail('角色、场景、道具总数最多 30，请分批策划');
  const association = (value, group, where) => {
    const key = id(value, where);
    if (entities.get(key)?.group !== group) fail(`${where}引用了未声明或错误类型的实体`);
    return key;
  };
  const associations = (value, group, where) => {
    const list = array(value === undefined ? [] : value, where, 30).map(item => association(item, group, where));
    if (new Set(list).size !== list.length) fail(`${where}不能重复关联同一实体`);
    return list;
  };
  const shots = array(raw.shots, 'shots', 40);
  if (!shots.length) fail('至少需要 1 个镜头');
  plan.shots = [];
  const shotIds = new Set();
  for (const item of shots) {
    object(item, ['id', 'title', 'prompt', 'imagePrompt', 'camera', 'dialogue', 'sound', 'seconds', 'sceneId', 'characterIds', 'propIds', 'continuity', 'firstFrame', 'lastFrame'], '镜头');
    const shot = { id: id(item.id, '镜头 id'), title: text(item.title, 100, '镜头标题', true), prompt: text(item.prompt, 4000, '镜头提示词', true) };
    if (shotIds.has(shot.id)) fail('镜头 id 不能重复');
    shotIds.add(shot.id);
    for (const [key, max] of [['imagePrompt', 4000], ['camera', 400], ['dialogue', 1600], ['sound', 1600]]) if (item[key] !== undefined) shot[key] = text(item[key], max, key);
    if (!Number.isInteger(item.seconds) || item.seconds < 1 || item.seconds > 60) fail('seconds 必须是 1–60 之间的整数');
    shot.seconds = item.seconds;
    if (item.sceneId !== undefined) shot.sceneId = association(item.sceneId, 'scenes', 'sceneId');
    shot.characterIds = associations(item.characterIds, 'characters', 'characterIds');
    shot.propIds = associations(item.propIds, 'props', 'propIds');
    shot.continuity = item.continuity === undefined ? 'none' : item.continuity;
    if (!['none', 'previous-tail'].includes(shot.continuity)) fail('continuity 只能是 none 或 previous-tail');
    for (const key of ['firstFrame', 'lastFrame']) if (item[key] !== undefined) shot[key] = reference(item[key], key);
    if (shot.continuity === 'previous-tail') {
      if (!plan.shots.length) fail('首镜不能 previous-tail，请选择 none');
      if (shot.firstFrame) fail('firstFrame 与 previous-tail 冲突，请明确选择一种首帧来源');
      if (plan.shots.at(-1).sceneId !== shot.sceneId) fail('跨场景不能 previous-tail，请选择 none 或拆分场景');
    }
    plan.shots.push(shot);
  }
  return plan;
}

function options(raw, sequence = false) {
  object(raw, ['imageProfileId', 'videoProfileId', 'threadId'], '编译选项');
  const out = {};
  for (const key of ['imageProfileId', 'videoProfileId', 'threadId']) if (raw[key] !== undefined) out[key] = id(raw[key], key, 90);
  if (sequence && (out.imageProfileId || out.threadId)) fail('队列不接受 imageProfileId/threadId；请去掉该选项或使用画布');
  if (sequence && !out.videoProfileId) fail('队列需要 videoProfileId，请先通过 media_models 选择视频连接');
  return out;
}
function entityIndex(plan) {
  return new Map(GROUPS.flatMap(([group, label]) => plan[group].map(entity => [entity.id, { ...entity, label }])));
}
const forShot = (shot, index) => [shot.sceneId, ...shot.characterIds, ...shot.propIds].filter(Boolean).map(key => index.get(key));
const describe = entity => `【${entity.label}】${entity.name}\n${entity.description}`;
const motionPrompt = (shot, entities) => [shot.prompt, ...entities.map(describe), ...[['camera', '运镜'], ['dialogue', '对白'], ['sound', '声音']].filter(([key]) => shot[key]).map(([key, label]) => `【${label}】${shot[key]}`)].join('\n\n');
const keyFor = (target, plan, opts) => `sd1-${target}-${hash(JSON.stringify({ plan, options: opts }))}`;

function compileCanvas(input, rawOptions = {}) {
  const plan = normalizePlan(input), opts = options(rawOptions), index = entityIndex(plan);
  const nodes = [], edges = [], assets = new Map();
  const connect = (from, to, role) => edges.push({ id: `edge-${hash(`${from}|${to}|${role}`).slice(0, 24)}`, from, to, role });
  const asset = (ref, title) => {
    const key = `${ref.id}:${ref.version}`;
    if (!assets.has(key)) {
      const node = { id: `asset-${hash(key).slice(0, 24)}`, kind: 'asset', title, x: 440, y: 60 + assets.size * 280, reference: { ...ref } };
      assets.set(key, node); nodes.push(node);
    }
    return assets.get(key).id;
  };
  let row = 0;
  for (const entity of index.values()) {
    nodes.push({ id: `entity-${entity.id}`, kind: 'text', title: `${entity.label} · ${entity.name}`, prompt: describe(entity), x: 40, y: 60 + row++ * 280 });
    if (entity.reference) asset(entity.reference, entity.name);
  }
  for (const [position, shot] of plan.shots.entries()) {
    const entities = forShot(shot, index), stillId = `still-${shot.id}`, videoId = `video-${shot.id}`;
    const stillPrompt = [shot.imagePrompt || shot.prompt, shot.camera ? `【机位】${shot.camera}` : ''].filter(Boolean).join('\n\n');
    const videoPrompt = motionPrompt(shot, entities);
    const imageAccepted = [plan.globalPrompt, ...entities.map(describe), stillPrompt].filter(Boolean).join('\n\n');
    const videoAccepted = [plan.globalPrompt, videoPrompt].filter(Boolean).join('\n\n');
    if (stillPrompt.length > 8000 || videoPrompt.length > 8000 || imageAccepted.length > 12000 || videoAccepted.length > 12000) fail(`镜头「${shot.title}」合并设定后的提示词过长，请精简或分批，不会截断内容`);
    nodes.push({ id: stillId, kind: 'image', title: `${shot.title} · 分镜图`, prompt: stillPrompt, x: 900, y: 60 + position * 280, settings: { aspect: plan.aspect }, ...(opts.imageProfileId ? { profileId: opts.imageProfileId } : {}) });
    nodes.push({ id: videoId, kind: 'video', title: `${shot.title} · 视频`, prompt: videoPrompt, x: 1420, y: 60 + position * 280, settings: { aspect: plan.aspect, seconds: shot.seconds }, ...(opts.videoProfileId ? { profileId: opts.videoProfileId } : {}) });
    const referenced = new Set();
    for (const entity of entities) {
      connect(`entity-${entity.id}`, stillId, 'context');
      if (entity.reference) referenced.add(asset(entity.reference, entity.name));
    }
    if (referenced.size > 6) fail(`镜头「${shot.title}」超过 6 张参考图，请减少引用或分批制作`);
    for (const source of referenced) connect(source, stillId, 'reference');
    const first = shot.continuity === 'previous-tail' ? `video-${plan.shots[position - 1].id}` : shot.firstFrame ? asset(shot.firstFrame, `${shot.title} · 首帧`) : stillId;
    connect(first, videoId, 'firstFrame');
    if (shot.lastFrame) connect(asset(shot.lastFrame, `${shot.title} · 尾帧`), videoId, 'lastFrame');
  }
  if (nodes.length > 80 || edges.length > 200) fail(`画布需要 ${nodes.length} 节点/${edges.length} 连线，超过 80/200 上限，请分批编译，不会截断`);
  return { action: 'create', title: plan.title, globalPrompt: plan.globalPrompt, nodes, edges, idempotencyKey: keyFor('c', plan, opts), ...(opts.threadId ? { threadId: opts.threadId } : {}) };
}

function compileSequence(input, rawOptions = {}) {
  const plan = normalizePlan(input), opts = options(rawOptions, true), index = entityIndex(plan);
  const shots = plan.shots.map(shot => {
    if (shot.lastFrame) fail(`镜头「${shot.title}」需要 lastFrame，当前队列不能表达尾帧约束，请使用画布 --mode canvas`);
    const entities = forShot(shot, index);
    if (shot.continuity === 'none' && !shot.firstFrame && entities.some(entity => entity.reference)) fail(`镜头「${shot.title}」有设定参考图，请先生成或选择分镜图并固定 firstFrame，再加入队列；也可使用画布`);
    const prompt = motionPrompt(shot, entities);
    if ([plan.globalPrompt, prompt].filter(Boolean).join('\n\n').length > 12000) fail(`镜头「${shot.title}」合并全局设定后的提示词超过 12000 字符，请精简或分批`);
    return { id: shot.id, prompt, seconds: shot.seconds, continuity: shot.continuity, ...(shot.firstFrame ? { firstFrame: { ...shot.firstFrame } } : {}) };
  });
  return { title: plan.title, globalPrompt: plan.globalPrompt, defaults: { profileId: opts.videoProfileId, seconds: 4 }, shots, start: false, idempotencyKey: keyFor('s', plan, opts) };
}

function readPlan(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) fail('计划路径必须是文件');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0, read;
    while (count < bytes.length && (read = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += read;
    if (count > MAX_BYTES) fail('计划文件超过 512 KiB，请分批');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)).replace(/^\uFEFF/, ''));
  } finally { fs.closeSync(fd); }
}
function main(argv) {
  const flags = { '--mode': 'mode', '--image-profile': 'imageProfileId', '--video-profile': 'videoProfileId', '--thread': 'threadId', '--output': 'output' };
  const args = { mode: 'validate' }, seen = new Set();
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith('-')) {
        if (!Object.hasOwn(flags, arg)) fail(`未知参数 ${arg}`);
        if (seen.has(arg)) fail(`重复参数 ${arg}`);
        seen.add(arg);
        const value = argv[++i];
        if (!value || value.startsWith('--')) fail(`${arg} 缺少取值`);
        args[flags[arg]] = value;
      } else {
        if (args.input) fail('只能指定一个计划文件');
        args.input = arg;
      }
    }
    if (!args.input || !['validate', 'canvas', 'sequence'].includes(args.mode)) fail('用法：node compile-story.cjs PLAN.json --mode validate|canvas|sequence [--output FILE.json]');
    const opts = {};
    for (const key of ['imageProfileId', 'videoProfileId', 'threadId']) if (args[key] !== undefined) opts[key] = args[key];
    if (args.mode === 'validate' && Object.keys(opts).length) fail('validate 只校验计划，请在 canvas/sequence 模式设置模型或对话参数');
    const plan = readPlan(args.input);
    const result = args.mode === 'canvas' ? compileCanvas(plan, opts) : args.mode === 'sequence' ? compileSequence(plan, opts) : normalizePlan(plan);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, output, { flag: 'wx', encoding: 'utf8' });
    else process.stdout.write(output);
    if (args.mode === 'sequence' && result && plan.aspect && plan.aspect !== '16:9') process.stderr.write(`提示：队列接口没有 aspect 字段，计划中的 ${plan.aspect} 未约束原始素材；请核对提供商默认值或在本地剪辑中设置画幅。\n`);
    return 0;
  } catch (error) {
    const message = error.code === 'EEXIST' ? '输出文件已存在，拒绝覆盖；请使用新文件名' : error instanceof SyntaxError ? '计划不是有效 JSON' : error.message;
    process.stderr.write(`${message}\n`); return 1;
  }
}

module.exports = { normalizePlan, compileCanvas, compileSequence };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
