'use strict';

// Knorvia course artifact slice (KNORVIA-NIGHT B08), inspired by the OpenMAIC
// classroom format (THU-MAIC/OpenMAIC v1.0.1, MIT) but a deliberately small,
// deterministic schema owned by Knorvia. Courses are versioned library JSON
// artifacts; reading validates the schema and the pinned source evidence.
// No OpenMAIC code is imported; unsupported inputs fail with clear errors.

const crypto = require('node:crypto');

const fail = (message, code = -32602) => { const error = new Error(message); error.rpc = { code, message }; throw error; };
const nowIso = () => new Date().toISOString();
const id8 = () => crypto.randomBytes(4).toString('hex');

const BLOCK_TYPES = ['text', 'quote', 'quiz-ref', 'video-ref', 'lecture-ref'];
const COURSE_PREFIX = 'learning/课程/';

// Strict reader: anything outside the slice is reported as unsupported, never
// silently coerced.
function validateCourse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('课程必须是 JSON 对象');
  if (input.schemaVersion !== 1) fail(`不支持的课程 schema 版本：${JSON.stringify(input.schemaVersion)}；本切片只支持 1`);
  if (typeof input.title !== 'string' || !input.title.trim()) fail('课程缺少标题');
  if (typeof input.topic !== 'string' || !input.topic.trim()) fail('课程缺少课题');
  if (!Array.isArray(input.modules) || !input.modules.length || input.modules.length > 40) fail('课程需要 1–40 个模块');
  const seenLessons = new Set();
  for (const [moduleIndex, module] of input.modules.entries()) {
    if (typeof module?.title !== 'string' || !module.title.trim()) fail(`模块 ${moduleIndex + 1} 缺少标题`);
    if (!Array.isArray(module.lessons) || !module.lessons.length || module.lessons.length > 50) fail(`模块 ${moduleIndex + 1} 需要 1–50 个课时`);
    for (const [lessonIndex, lesson] of module.lessons.entries()) {
      const lessonKey = `${moduleIndex}:${lessonIndex}`;
      if (seenLessons.has(lessonKey)) fail('课时重复');
      seenLessons.add(lessonKey);
      if (!Array.isArray(lesson.blocks) || !lesson.blocks.length || lesson.blocks.length > 100) fail(`课时 “${lesson.title ?? moduleIndex + 1}.${lessonIndex + 1}” 需要 1–100 个内容块`);
      for (const block of lesson.blocks) {
        if (!BLOCK_TYPES.includes(block?.type)) fail(`不支持的内容块类型：${JSON.stringify(block?.type)}；支持 ${BLOCK_TYPES.join('/')}`);
        if (block.type === 'text' && (typeof block.text !== 'string' || !block.text.trim())) fail('text 块需要正文');
        if (block.type === 'quote') {
          if (typeof block.quote !== 'string' || !block.quote.trim()) fail('quote 块需要原文');
          if (typeof block.evidence?.libraryId !== 'string' || typeof block.evidence?.version !== 'string') fail('quote 块需要 libraryId+version 证据');
        }
        if (block.type === 'quiz-ref' && (typeof block.path !== 'string' || !block.path.startsWith('learning/练习/'))) fail('quiz-ref 块需要 learning/练习/ 内的练习路径');
        if (block.type === 'lecture-ref' && (typeof block.path !== 'string' || !block.path.startsWith('learning/讲座/'))) fail('lecture-ref 块需要 learning/讲座/ 内的讲义路径');
        if (block.type === 'video-ref' && (typeof block.libraryId !== 'string' || typeof block.version !== 'string')) fail('video-ref 块需要 libraryId+version');
      }
    }
  }
  return true;
}

// Evidence currency: pinned versions compared against the current library.
async function courseEvidenceStatus(library, course) {
  const index = await library.handlers['library/list']();
  const current = new Map(index.entries.filter(entry => !entry.trashedAt).map(entry => [entry.id, entry.sha256]));
  const paths = new Set(index.entries.filter(entry => !entry.trashedAt).map(entry => entry.path));
  const statuses = {}; let unsupported = [];
  const check = (libraryId, version, key) => {
    if (!current.has(libraryId)) statuses[key] = 'missing';
    else statuses[key] = current.get(libraryId) === version ? 'current' : 'superseded';
  };
  const checkPath = lessonPath => { if (!paths.has(lessonPath)) unsupported.push(lessonPath); };
  for (const module of course.modules ?? []) {
    for (const lesson of module.lessons ?? []) {
      for (const block of lesson.blocks ?? []) {
        if (block.type === 'quote') check(block.evidence.libraryId, block.evidence.version, `${block.evidence.libraryId}@${block.evidence.version}`);
        if (block.type === 'video-ref') check(block.libraryId, block.version, `${block.libraryId}@${block.version}`);
        if (block.type === 'quiz-ref') checkPath(block.path);
        if (block.type === 'lecture-ref') checkPath(block.path);
      }
    }
  }
  return { statuses: Object.values(statuses), missingRefs: unsupported };
}

function flattenCourse(course) {
  const sections = [];
  for (const module of course.modules ?? []) {
    for (const [index, lesson] of (module.lessons ?? []).entries()) {
      sections.push({
        module: module.title,
        lesson: lesson.title ?? `${module.title} ${index + 1}`,
        blocks: (lesson.blocks ?? []).map(block => {
          if (block.type === 'text') return { kind: 'text', text: block.text };
          if (block.type === 'quote') return { kind: 'quote', quote: block.quote, evidence: block.evidence };
          if (block.type === 'quiz-ref') return { kind: 'quiz', path: block.path };
          if (block.type === 'lecture-ref') return { kind: 'lecture', path: block.path };
          return { kind: 'video', libraryId: block.libraryId, version: block.version };
        }),
      });
    }
  }
  return sections;
}

function createOpenmaicCourse({ library } = {}) {
  if (!library?.handlers) throw new Error('Course slice requires the personal library');

  const commands = {
    'course/save': async params => {
      const course = params.course;
      validateCourse(course);
      const suffix = id8();
      const path = `${COURSE_PREFIX}${course.title.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').slice(0, 60)}-${suffix}.json`;
      const artifact = { kind: 'course', schemaVersion: 1, id: `course-${suffix}`, createdAt: nowIso(), updatedAt: nowIso(), ...course };
      const written = await library.handlers['library/write']({ path, text: JSON.stringify(artifact, null, 2) });
      return { path: written.path, id: artifact.id, sha256: written.sha256, modules: artifact.modules.length };
    },
    'course/read': async params => {
      const index = await library.handlers['library/list']();
      const entry = index.entries.find(item => !item.trashedAt && item.path === params.path);
      if (!entry) fail('找不到这份课程', -32004);
      if (!entry.path.startsWith(COURSE_PREFIX)) fail('不是课程 Artifact（需要在 learning/课程/ 下）');
      const chunks = []; let offset = 0;
      for (;;) {
        const part = await library.handlers['library/read']({ id: entry.id, offset });
        chunks.push(Buffer.from(part.base64, 'base64'));
        if (part.nextOffset === null) break;
        offset = part.nextOffset;
      }
      const course = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (course.kind !== 'course') fail('这不是课程 Artifact');
      try { validateCourse(course); } catch (error) { fail(`课程文件不支持或已损坏：${error.rpc?.message || error.message}`); }
      const evidence = await courseEvidenceStatus(library, course);
      return {
        path: entry.path, id: course.id, title: course.title, topic: course.topic,
        sha256: entry.sha256, modules: course.modules,
        view: flattenCourse(course),
        evidenceStatuses: [...new Set(evidence.statuses)],
        missingRefs: evidence.missingRefs,
      };
    },
    // Deterministic sample used by tests, previews and docs.
    'course/sample': async () => ({ course: sampleCourse() }),
  };

  const toolDescriptors = () => [
    {
      name: 'openmaic_course', source: 'catalog',
      description: 'Save, read or sample a Knorvia course artifact (OpenMAIC-inspired schema slice: modules → lessons → blocks of text/quote/quiz-ref/lecture-ref/video-ref with pinned evidence). Unsupported formats fail explicitly instead of guessing.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'read', 'sample'] },
          path: { type: 'string' },
          course: { type: 'object' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];

  async function callTool(name, params = {}) {
    if (name !== 'openmaic_course') return undefined;
    if (params.action === 'save') return commands['course/save'](params);
    if (params.action === 'read') return commands['course/read'](params);
    return commands['course/sample'](params);
  }

  return { commands, toolDescriptors, callTool, validateCourse, sampleCourse };
}

function sampleCourse() {
  return {
    schemaVersion: 1,
    title: '傅里叶变换入门',
    topic: '信号与系统',
    modules: [
      {
        title: '从时域到频域',
        lessons: [
          {
            title: '为什么需要傅里叶变换',
            blocks: [
              { type: 'text', text: '本课时建立频域直觉，并把结论锚定到讲义原文。' },
              { type: 'lecture-ref', path: 'learning/讲座/傅里叶入门-00000000.json' },
              { type: 'quote', quote: '任何周期信号都可以分解为正弦波的叠加。', evidence: { libraryId: 'source-entry', version: 'a'.repeat(64), line: 3 } },
            ],
          },
          {
            title: '练习',
            blocks: [
              { type: 'quiz-ref', path: 'learning/练习/基础测验-00000000.json' },
            ],
          },
        ],
      },
    ],
  };
}

module.exports = { createOpenmaicCourse, validateCourse, sampleCourse, BLOCK_TYPES, COURSE_PREFIX };
