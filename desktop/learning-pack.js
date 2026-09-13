'use strict';

// Learning Pack (KNORVIA-NIGHT B05/B09/B10/B11). Deterministic, versioned
// learning artifacts on top of the personal library — no model calls and no
// second agent loop live here. Model-authored explanation prose arrives
// through the Kernel skills (desktop/builtin-skills/learning-*), which use
// these tools; without a configured model those skills must stop, and this
// service only ever stores honestly-labelled deterministic derivations.
//
// Evidence contract (B09): every section/question carries a pinned library
// version (sha256). Reads re-check the pin against the library so outdated
// evidence is visible after the source updates.

const crypto = require('node:crypto');
const { createLearningPractice } = require('./learning-practice');
const { createCreativeBrief } = require('./creative-brief');
const { setTimeout: delay } = require('node:timers/promises');

const TEXT_SUFFIX = /\.(md|txt|json|csv|tsv|log|ya?ml|toml|ini|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|sh|ps1|bat|sql|xml)$/i;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_QUESTIONS = 200;
const MAX_SECTIONS = 200;
const DAY_MS = 24 * 3600 * 1000;

function fail(message, code = -32602) { const error = new Error(message); error.rpc = { code, message }; throw error; }
const nowIso = () => new Date().toISOString();
const id8 = () => crypto.randomBytes(4).toString('hex');

function titleToFileName(title, kind, suffix) {
  const clean = String(title || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').slice(0, 60).trim();
  if (!clean) fail(`${kind}标题不能为空`);
  return `${clean}-${suffix}.json`;
}

async function readSourceText(library, ref) {
  const chunks = [];
  let offset = 0; let size = 0; let entry; let sha256;
  for (;;) {
    const part = await library.handlers['library/read']({ id: ref.id, version: ref.version, offset });
    if (entry === undefined) { entry = part.entry; size = part.size; sha256 = part.sha256; }
    if (size > MAX_SOURCE_BYTES) fail('学习解读目前支持 1 MB 以内的文本资料');
    chunks.push(Buffer.from(part.base64, 'base64'));
    if (part.nextOffset === null) break;
    if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset) fail('资料读取不完整');
    offset = part.nextOffset;
  }
  return { entry, sha256, text: Buffer.concat(chunks).toString('utf8') };
}

// Deterministic outline derivation from markdown-ish text. This is a
// transparent structural transform of the cited source, never generated prose.
function deriveOutline(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      current = { heading: heading[2].trim().slice(0, 120) || `第 ${index + 1} 行`, evidence: { line: index + 1, quote: line.trim().slice(0, 160) }, points: [] };
      sections.push(current);
      continue;
    }
    if (!line.trim()) continue;
    if (!current) {
      current = { heading: '开头', evidence: { line: 1, quote: lines[0].trim().slice(0, 160) || line.trim().slice(0, 160) }, points: [] };
      sections.push(current);
    }
    if (current.points.length < 8) current.points.push({ quote: line.trim().slice(0, 200), evidence: { line: index + 1 } });
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

function checkEvidenceRef(evidence, sourceRefs) {
  if (!evidence || typeof evidence !== 'object') fail('每条内容都需要资料证据');
  if (typeof evidence.quote !== 'string' || evidence.quote.length > 400) fail('证据需要 400 字以内的原文引用');
  if (!Number.isSafeInteger(evidence.line) || evidence.line < 1) fail('证据需要行号');
  const source = sourceRefs.find(ref => ref.libraryId === evidence.libraryId);
  if (!source) fail('证据必须引用已声明的资料库来源');
  if (evidence.version && evidence.version !== source.version) fail('证据版本必须与声明的资料版本一致');
  return source.version;
}

// Re-validate pinned versions against the live library; stale pins stay
// readable but are flagged so outdated evidence is never presented as current.
async function evidenceCurrency(library, sourceRefs) {
  if (!sourceRefs?.length) return {};
  const index = await library.handlers['library/list']();
  const current = new Map(index.entries.filter(entry => !entry.trashedAt).map(entry => [entry.id, entry.sha256]));
  const statuses = {};
  for (const ref of sourceRefs) {
    if (!current.has(ref.libraryId)) statuses[`${ref.libraryId}@${ref.version}`] = 'missing';
    else statuses[`${ref.libraryId}@${ref.version}`] = current.get(ref.libraryId) === ref.version ? 'current' : 'superseded';
  }
  return statuses;
}

function publicArtifact(artifact, currency) {
  return {
    kind: artifact.kind,
    id: artifact.id,
    title: artifact.title,
    topic: artifact.topic,
    path: artifact.path,
    revision: artifact.revision,
    sha256: artifact.sha256,
    authorship: artifact.authorship,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    sourceRefs: artifact.sourceRefs.map(ref => ({ ...ref, evidenceStatus: currency[`${ref.libraryId}@${ref.version}`] ?? 'unknown' })),
    sections: artifact.sections?.map(section => ({
      heading: section.heading,
      evidence: section.evidence,
      points: section.points?.map(point => ({ quote: point.quote, evidence: point.evidence })),
    })),
    questions: artifact.questions?.map(question => ({
      id: question.id, prompt: question.prompt,
      options: question.options, answerIndex: question.answerIndex,
      explanation: question.explanation, evidence: question.evidence,
    })),
    attempts: artifact.attempts?.map(attempt => ({
      attemptId: attempt.attemptId, at: attempt.at, topic: attempt.topic,
      results: attempt.results, corrected: attempt.corrected ?? [], userNote: attempt.userNote,
    })),
  };
}

async function writeArtifact(library, artifact, expectedSha256) {
  const next = { ...artifact, revision: artifact.revision + 1, sha256: '', updatedAt: nowIso() };
  const written = await library.handlers['library/write']({
    path: artifact.path,
    text: JSON.stringify(next, null, 2),
    expectedSha256,
  });
  Object.assign(artifact, next, { sha256: written.sha256 });
  return written;
}

async function readArtifactJson(library, entry) {
  const chunks = []; let offset = 0; let sha256 = entry.sha256;
  for (;;) {
    const part = await library.handlers['library/read']({ id: entry.id, version: entry.sha256, offset });
    if (offset === 0) sha256 = part.sha256;
    chunks.push(Buffer.from(part.base64, 'base64'));
    if (part.nextOffset === null) break;
    if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset) fail('成果读取不完整');
    offset = part.nextOffset;
  }
  return { json: { ...JSON.parse(Buffer.concat(chunks).toString('utf8')), sha256 }, sha256 };
}

async function findArtifactEntry(library, path) {
  const index = await library.handlers['library/list']();
  return index.entries.find(entry => !entry.trashedAt && entry.path === path) ?? null;
}

// Deterministic review schedule: correct streak lengthens the interval,
// a wrong answer resets it to the next day. No model judgement involved.
function nextReviewAt(streak) { return Date.now() + Math.min(DAY_MS * 2 ** Math.max(0, streak - 1), 30 * DAY_MS); }

function createLearningPack({ home, library, studio, rpc } = {}) {
  if (!library?.handlers) throw new Error('Learning pack requires the personal library');

  async function resolveSourceRefs(refs) {
    if (!Array.isArray(refs) || !refs.length) fail('请至少引用一份资料库来源');
    const resolved = [];
    for (const ref of refs.slice(0, 10)) {
      const versions = await library.handlers['library/versions']({ id: ref?.id }).catch(() => fail('找不到引用的资料', -32004));
      const version = ref.version ?? versions[0]?.sha256;
      if (!version || !versions.some(item => item.sha256 === version)) fail('引用的资料版本不存在');
      const index = await library.handlers['library/list']();
      const entry = index.entries.find(item => item.id === ref.id);
      if (!entry) fail('找不到引用的资料', -32004);
      resolved.push({ libraryId: entry.id, version, currentVersion: entry.sha256, path: entry.path, name: entry.name });
    }
    return resolved;
  }

  const commands = {
    'learning/sources': async () => {
      const index = await library.handlers['library/list']();
      return {
        sources: index.entries
          .filter(entry => !entry.trashedAt && !entry.folder && TEXT_SUFFIX.test(entry.name) && entry.size <= MAX_SOURCE_BYTES)
          .slice(0, 200)
          .map(entry => ({ id: entry.id, name: entry.name, path: entry.path, version: entry.sha256, bytes: entry.size, modifiedAt: entry.modifiedAt })),
      };
    },

    'learning/lecture/create': async params => {
      const topic = String(params.topic ?? '').trim().slice(0, 120);
      if (!topic) fail('讲座需要课题');
      const authorship = params.authorship ?? 'deterministic';
      if (!['deterministic', 'agent'].includes(authorship)) fail('authorship 必须是 deterministic 或 agent');
      const sourceRefs = await resolveSourceRefs(params.sourceRefs);
      const suffix = id8();
      let sections;
      if (authorship === 'deterministic') {
        if (params.outline) fail('deterministic 模式由服务从来源推导大纲，不接受外部大纲');
        const primary = sourceRefs[0];
        const { text } = await readSourceText(library, { id: primary.libraryId, version: primary.version });
        sections = deriveOutline(text).map(section => ({
          heading: section.heading,
          evidence: { libraryId: primary.libraryId, version: primary.version, line: section.evidence.line, quote: section.evidence.quote },
          points: (section.points ?? []).map(point => ({ quote: point.quote, evidence: { line: point.evidence.line } })),
        }));
        if (!sections.length) fail('这份资料没有可推导的结构；请改用配置了模型的辅导技能');
      } else {
        if (!Array.isArray(params.outline) || !params.outline.length) fail('agent 模式需要 outline 大纲');
        sections = params.outline.slice(0, MAX_SECTIONS).map(section => {
          if (typeof section.heading !== 'string' || !section.heading.trim()) fail('大纲段落需要标题');
          // Section evidence pins the exact source; points inherit it and only
          // carry their own line + quote so every claim stays locatable.
          const evidenceVersion = checkEvidenceRef(section.evidence, sourceRefs);
          return {
            heading: section.heading.trim().slice(0, 200),
            evidence: { libraryId: section.evidence.libraryId, version: evidenceVersion, line: section.evidence.line, quote: section.evidence.quote },
            points: (section.points ?? []).slice(0, 20).map(point => {
              if (typeof point.quote !== 'string' || !point.quote.trim()) fail('大纲要点需要原文引用');
              if (!Number.isSafeInteger(point.evidence?.line) || point.evidence.line < 1) fail('大纲要点需要行号');
              return { quote: point.quote.trim().slice(0, 400), evidence: { line: point.evidence.line } };
            }),
          };
        });
      }
      const artifact = {
        schemaVersion: 1, kind: 'lecture', id: `lec-${suffix}`, title: String(params.title ?? topic).slice(0, 100),
        topic, authorship, revision: 0, sha256: '', createdAt: nowIso(), updatedAt: nowIso(),
        sourceRefs, sections,
      };
      artifact.path = `learning/讲座/${titleToFileName(artifact.title, '讲座', suffix)}`;
      await writeArtifact(library, artifact);
      return publicArtifact(artifact, await evidenceCurrency(library, sourceRefs));
    },

    'learning/lecture/read': async params => {
      if (typeof params.path !== 'string' || !params.path.startsWith('learning/')) fail('lecture/read 需要 learning/ 讲义路径');
      const entry = await findArtifactEntry(library, params.path);
      if (!entry) fail('找不到这份讲义', -32004);
      const { json } = await readArtifactJson(library, entry);
      if (json.kind !== 'lecture') fail('这不是一份讲义');
      return publicArtifact(json, await evidenceCurrency(library, json.sourceRefs ?? []));
    },

    'learning/quiz/create': async params => {
      const topic = String(params.topic ?? '').trim().slice(0, 120);
      if (!topic) fail('练习需要课题');
      const authorship = params.authorship ?? 'deterministic';
      if (!['deterministic', 'agent'].includes(authorship)) fail('authorship 必须是 deterministic 或 agent');
      if (authorship === 'deterministic') fail('练习题目需要教学判断；请使用配置了模型的辅导技能生成，再由本工具保存');
      const sourceRefs = await resolveSourceRefs(params.sourceRefs);
      if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > MAX_QUESTIONS) fail(`练习需要 1–${MAX_QUESTIONS} 道题`);
      const questions = params.questions.map((question, index) => {
        if (typeof question.prompt !== 'string' || !question.prompt.trim()) fail(`第 ${index + 1} 题缺少题干`);
        const evidenceVersion = checkEvidenceRef(question.evidence, sourceRefs);
        if (question.evidence.libraryId && !sourceRefs.some(ref => ref.libraryId === question.evidence.libraryId)) fail(`第 ${index + 1} 题证据引用了未声明的来源`);
        if (question.options !== undefined) {
          if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8) fail('选择题需要 2–8 个选项');
          if (!Number.isSafeInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= question.options.length) fail('选择题答案索引无效');
        }
        return {
          id: question.id ?? `q${index + 1}`,
          prompt: question.prompt.trim().slice(0, 2000),
          options: question.options?.map(option => String(option).slice(0, 300)),
          answerIndex: question.answerIndex,
          explanation: question.explanation ? String(question.explanation).slice(0, 2000) : undefined,
          evidence: { libraryId: question.evidence.libraryId, version: evidenceVersion, line: question.evidence.line, quote: question.evidence.quote },
        };
      });
      const suffix = id8();
      const artifact = {
        schemaVersion: 1, kind: 'quiz', id: `quiz-${suffix}`, title: String(params.title ?? topic).slice(0, 100),
        topic, authorship, revision: 0, sha256: '', createdAt: nowIso(), updatedAt: nowIso(),
        sourceRefs, questions, attempts: [],
      };
      artifact.path = `learning/练习/${titleToFileName(artifact.title, '练习', suffix)}`;
      await writeArtifact(library, artifact);
      return publicArtifact(artifact, await evidenceCurrency(library, sourceRefs));
    },

    'learning/quiz/read': async params => {
      const entry = await findArtifactEntry(library, params.path);
      if (!entry) fail('找不到这份练习', -32004);
      const { json } = await readArtifactJson(library, entry);
      if (json.kind !== 'quiz') fail('这不是一份练习');
      return publicArtifact(json, await evidenceCurrency(library, json.sourceRefs ?? []));
    },

    'learning/attempt/record': async params => {
      if (typeof params.attemptId !== 'string' || !params.attemptId.trim()) fail('attempt/record 需要 attemptId');
      const entry = await findArtifactEntry(library, params.path);
      if (!entry) fail('找不到这份练习', -32004);
      const { json: quiz, sha256 } = await readArtifactJson(library, entry);
      if (quiz.kind !== 'quiz') fail('这不是一份练习');
      const attemptId = params.attemptId.trim().slice(0, 120);
      const existing = quiz.attempts?.find(attempt => attempt.attemptId === attemptId);
      if (existing) {
        // Deduplicated: the same attemptId never counts twice; report the
        // unchanged mastery state so callers see the stable aggregate.
        const topics = await readMastery(library);
        return { duplicate: true, attempt: existing, topic: quiz.topic, mastery: topics[quiz.topic] ?? null };
      }
      if (!Array.isArray(params.results) || !params.results.length) fail('尝试需要逐题结果');
      const knownIds = new Set(quiz.questions.map(question => question.id));
      const seenIds = new Set();
      const results = params.results.slice(0, MAX_QUESTIONS).map(result => {
        if (!knownIds.has(result.questionId)) fail(`练习里没有题目 ${result.questionId}`);
        if (seenIds.has(result.questionId)) fail('同一次练习不能重复提交同一道题');
        seenIds.add(result.questionId);
        if (!['correct', 'wrong'].includes(result.outcome)) fail('结果只能是 correct 或 wrong');
        return { questionId: result.questionId, outcome: result.outcome };
      });
      const attempt = { attemptId: params.attemptId.trim().slice(0, 120), at: nowIso(), topic: quiz.topic, results, corrected: [], userNote: params.userNote ? String(params.userNote).slice(0, 500) : undefined };
      quiz.attempts = [...(quiz.attempts ?? []), attempt].slice(-500);
      await writeArtifact(library, quiz, sha256);
      const mastery = await updateMastery(library, quiz.topic, {
        attemptId: attempt.attemptId, correct: results.every(result => result.outcome === 'correct'),
        correctCount: results.filter(result => result.outcome === 'correct').length, total: results.length,
      });
      return { duplicate: false, attempt, topic: quiz.topic, mastery };
    },

    'learning/attempt/correct': async params => {
      const entry = await findArtifactEntry(library, params.path);
      if (!entry) fail('找不到这份练习', -32004);
      const { json: quiz, sha256 } = await readArtifactJson(library, entry);
      const attempt = quiz.attempts?.find(item => item.attemptId === params.attemptId);
      if (!attempt) fail('找不到这次尝试', -32004);
      const result = attempt.results.find(item => item.questionId === params.questionId);
      if (!result) fail('这次尝试里没有这道题', -32004);
      if (!['correct', 'wrong'].includes(params.outcome)) fail('修正结果只能是 correct 或 wrong');
      result.outcome = params.outcome;
      attempt.corrected = [...(attempt.corrected ?? []), { questionId: params.questionId, outcome: params.outcome, at: nowIso() }];
      await writeArtifact(library, quiz, sha256);
      const rebuilt = await commands['learning/mastery/rebuild']();
      const mastery = rebuilt.topics[quiz.topic];
      return { attempt, mastery };
    },

    'learning/mastery/read': async () => ({ topics: await readMastery(library) }),
    'learning/review/due': async params => {
      const topics = await readMastery(library);
      const now = params.now ? Date.parse(params.now) : Date.now();
      if (Number.isNaN(now)) fail('now 不是有效时间');
      return {
        due: Object.entries(topics)
          .filter(([, state]) => Date.parse(state.reviewAt) <= now)
          .sort((a, b) => Date.parse(a[1].reviewAt) - Date.parse(b[1].reviewAt))
          .map(([topic, state]) => ({ topic, reviewAt: state.reviewAt, attempts: state.attemptCount, accuracy: state.correctAttempts / Math.max(1, state.attemptCount) })),
      };
    },
    'learning/mastery/rebuild': async () => {
      // Deterministic recovery: recompute the aggregate from every quiz
      // artifact, so a lost mastery ledger is rebuilt, never guessed.
      const index = await library.handlers['library/list']();
      const quizzes = index.entries.filter(entry => !entry.trashedAt && entry.path.startsWith('learning/练习/') && entry.name.endsWith('.json'));
      const mastery = {};
      for (const entry of quizzes.slice(0, 200)) {
        const { json } = await readArtifactJson(library, entry).catch(() => ({ json: null }));
        if (json?.kind !== 'quiz') continue;
        for (const attempt of json.attempts ?? []) {
          applyAttempt(mastery, {
            attemptId: attempt.attemptId, topic: attempt.topic ?? json.topic,
            correct: attempt.results.every(result => result.outcome === 'correct'),
            correctCount: attempt.results.filter(result => result.outcome === 'correct').length,
            total: attempt.results.length,
          }, attempt.at);
        }
      }
      await saveMastery(library, mastery);
      return { topics: mastery, rebuiltFrom: quizzes.length };
    },
  };

  async function readMastery(libraryRef) {
    const entry = await findArtifactEntry(libraryRef, 'learning/掌握度.json');
    if (!entry) return {};
    const { json } = await readArtifactJson(libraryRef, entry).catch(() => ({ json: {} }));
    return json.topics ?? {};
  }

  async function saveMastery(libraryRef, topics) {
    const entry = await findArtifactEntry(libraryRef, 'learning/掌握度.json');
    const body = JSON.stringify({ schemaVersion: 1, kind: 'mastery', topics }, null, 2);
    return libraryRef.handlers['library/write']({ path: 'learning/掌握度.json', text: body, expectedSha256: entry?.sha256 });
  }

  function applyAttempt(topics, attempt, at) {
    const state = topics[attempt.topic] ?? { attemptCount: 0, correctCount: 0, correctAttempts: 0, streak: 0, reviewAt: nowIso(), updatedAt: at ?? nowIso(), attemptIds: {} };
    if (!state.attemptIds[attempt.attemptId]) {
      state.attemptCount += 1;
      state.correctCount += attempt.correctCount;
      if (attempt.correct) state.correctAttempts += 1;
      state.streak = attempt.correct ? state.streak + 1 : 0;
      state.attemptIds[attempt.attemptId] = { at: at ?? nowIso(), correct: attempt.correct };
      state.reviewAt = new Date(nextReviewAt(state.streak)).toISOString();
      state.updatedAt = at ?? nowIso();
      if (Object.keys(state.attemptIds).length > 2000) {
        for (const key of Object.keys(state.attemptIds).slice(0, 500)) delete state.attemptIds[key];
      }
    }
    topics[attempt.topic] = state;
    return state;
  }

  async function updateMastery(libraryRef, topic, attempt) {
    const topics = await readMastery(libraryRef);
    applyAttempt(topics, { ...attempt, topic });
    let current = topics;
    await saveMastery(libraryRef, topics).catch(async error => {
      // A lost update race rebuilds from durable quiz artifacts instead of
      // overwriting blind (the library already refuses stale hashes).
      if (error.rpc?.code !== -32005) throw error;
      const rebuilt = await commands['learning/mastery/rebuild']();
      current = rebuilt.topics;
      return rebuilt;
    });
    return current[topic];
  }

  const toolDescriptors = () => [
    { name: 'learning_sources', source: 'learning', description: 'List text materials in the personal library with pinned versions for study packs. Use the version when citing evidence.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    {
      name: 'learning_lecture', source: 'learning', description: 'Create or read a versioned lecture artifact. deterministic authorship derives an outline strictly from source structure with line-level evidence; agent authorship stores YOUR composed outline but every section still needs a source quote+line evidence. Never fabricate content without a cited source; if no model is configured, only deterministic mode is available.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'read'] }, topic: { type: 'string' }, title: { type: 'string' },
          authorship: { type: 'string', enum: ['deterministic', 'agent'] }, path: { type: 'string' },
          sourceRefs: { type: 'array', maxItems: 10, items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false } },
          outline: { type: 'array', maxItems: 200, items: { type: 'object', properties: { heading: { type: 'string' }, evidence: { type: 'object', properties: { libraryId: { type: 'string' }, version: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } }, required: ['libraryId', 'line', 'quote'], additionalProperties: false }, points: { type: 'array', maxItems: 20, items: { type: 'object', properties: { quote: { type: 'string' }, evidence: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'], additionalProperties: false } }, required: ['quote', 'evidence'], additionalProperties: false } } }, required: ['heading', 'evidence'], additionalProperties: false } },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'learning_quiz', source: 'learning', description: 'Create or read a versioned practice quiz. Every question requires evidence (source id, pinned version, line, quote). Creating questions requires authorship "agent" — a configured model must author them; without one, stop instead of inventing questions. Attempts are recorded separately with deduplicated attemptIds.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'read'] }, topic: { type: 'string' }, title: { type: 'string' },
          authorship: { type: 'string', enum: ['agent'] }, path: { type: 'string' },
          sourceRefs: { type: 'array', maxItems: 10, items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false } },
          questions: { type: 'array', maxItems: 200, items: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, options: { type: 'array', maxItems: 8, items: { type: 'string' } }, answerIndex: { type: 'integer' }, explanation: { type: 'string' }, evidence: { type: 'object', properties: { libraryId: { type: 'string' }, version: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } }, required: ['libraryId', 'line', 'quote'], additionalProperties: false } }, required: ['prompt', 'evidence'], additionalProperties: false } },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'learning_review', source: 'learning', description: 'Record a graded attempt (attemptId is deduplicated; the same id never double-counts), correct a recorded outcome after user feedback, read mastery per topic (derived ONLY from recorded attempts), and list due reviews. Mastery is never inferred from chat text.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['record', 'correct', 'mastery', 'due', 'rebuild'] },
          path: { type: 'string' }, attemptId: { type: 'string' }, questionId: { type: 'string' },
          outcome: { type: 'string', enum: ['correct', 'wrong'] }, userNote: { type: 'string' }, now: { type: 'string' },
          results: { type: 'array', maxItems: 200, items: { type: 'object', properties: { questionId: { type: 'string' }, outcome: { type: 'string', enum: ['correct', 'wrong'] } }, required: ['questionId', 'outcome'], additionalProperties: false } },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];

  async function callTool(name, params = {}) {
    if (name === 'learning_sources') return commands['learning/sources'](params);
    if (name === 'learning_lecture') return commands[params.action === 'read' ? 'learning/lecture/read' : 'learning/lecture/create'](params);
    if (name === 'learning_quiz') return commands[params.action === 'read' ? 'learning/quiz/read' : 'learning/quiz/create'](params);
    if (name === 'learning_review') {
      const map = { record: 'learning/attempt/record', correct: 'learning/attempt/correct', mastery: 'learning/mastery/read', due: 'learning/review/due', rebuild: 'learning/mastery/rebuild' };
      return commands[map[params.action]](params);
    }
    return undefined;
  }

  const practice = createLearningPractice({ library, learning: { commands } });
  const brief = createCreativeBrief({ library });
  return {
    commands: { ...commands, ...practice.commands, ...brief.commands },
    toolDescriptors: () => [...toolDescriptors(), ...practice.toolDescriptors(), ...brief.toolDescriptors()],
    async callTool(name, params = {}) {
      for (const domain of [practice, brief]) {
        const result = await domain.callTool(name, params);
        if (result !== undefined) return result;
      }
      return callTool(name, params);
    },
    root: 'learning',
  };
}

module.exports = { createLearningPack };
