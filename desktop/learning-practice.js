'use strict';

// Per-question practice: a thin deterministic library tool. No second agent
// loop, no mastery inference. Review dates are a simple interval (not FSRS).
const { createDomainArtifacts, fail, text, recordPath } = require('./domain-artifacts');

const SESSION_PREFIX = 'learning/练习会话/';
const QUIZ_PREFIX = 'learning/练习/';
const DAY_MS = 24 * 3600 * 1000;
const MAX_SCAN = 200;
const MAX_RETRY = 8;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function idValue(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${name}需要 8–64 位字母、数字、下划线或连字符`);
  return value;
}
function modeOf(value) {
  const mode = value == null || value === '' ? 'all' : value;
  if (!['all', 'wrong', 'due'].includes(mode)) fail('mode 只能是 all、wrong 或 due');
  return mode;
}
function parseNow(value) {
  if (value == null || value === '') return Date.now();
  const now = Date.parse(value);
  if (Number.isNaN(now)) fail('now 不是有效时间');
  return now;
}
const clone = value => JSON.parse(JSON.stringify(value));
const itemKey = (quizId, questionId, quizSha256) => `${quizId}\t${questionId}\t${quizSha256}`;
function intervalDays(outcome, streak) {
  if (outcome !== 'correct') return 1;
  return Math.min(2 ** (streak - 1), 30);
}
function effectiveOutcome(answer) {
  if (answer.grading === 'server' && (answer.outcome === 'correct' || answer.outcome === 'wrong')) return answer.outcome;
  if (answer.grading === 'self-reported' && (answer.selfRating === 'correct' || answer.selfRating === 'wrong')) return answer.selfRating;
  return null;
}

function createLearningPractice({ library, learning } = {}) {
  if (!library?.handlers) throw new Error('Learning practice requires the personal library');
  if (!learning?.commands?.['learning/quiz/read']) throw new Error('Learning practice requires read-only learning pack commands');
  const artifacts = createDomainArtifacts(library);
  const sessionPath = id => recordPath(`${SESSION_PREFIX}${id}.json`, SESSION_PREFIX);

  function publicQuestion(session, question) {
    if (!question) return null;
    const ref = (session.sourceRefs || []).find(item => item.libraryId === question.evidence?.libraryId);
    return {
      questionId: question.id,
      prompt: question.prompt,
      ...(question.options ? { options: question.options } : {}),
      source: question.evidence ? {
        libraryId: question.evidence.libraryId,
        version: question.evidence.version,
        line: question.evidence.line,
        path: ref?.path,
        name: ref?.name,
      } : null,
    };
  }

  function publicAnswer(session, answer) {
    if (!answer) return null;
    const question = (session.questions || []).find(item => item.id === answer.questionId);
    const view = {
      questionId: answer.questionId,
      submissionId: answer.submissionId,
      outcome: answer.outcome,
      grading: answer.grading,
      at: answer.at,
      answerText: answer.answerText ?? question?.options?.[answer.answerIndex],
      evidence: question?.evidence,
    };
    if (answer.grading === 'self-reported') {
      view.selfReported = true;
      view.selfRating = answer.selfRating;
      if (answer.feedback) view.feedback = answer.feedback;
    }
    if (question?.explanation) view.explanation = question.explanation;
    return view;
  }

  async function publicSession(session, extra = {}) {
    const answers = session.answers || [];
    const currentId = session.status === 'completed' ? null : session.queue[session.cursor];
    const current = currentId ? session.questions.find(item => item.id === currentId) : null;
    return {
      kind: 'practice-session',
      path: session.path,
      sessionId: session.id,
      quizPath: session.quizPath,
      title: session.title,
      quizId: session.quizId,
      quizSha256: session.quizSha256,
      mode: session.mode,
      status: session.status,
      revision: session.revision,
      sha256: session.sha256,
      progress: { answered: answers.length, total: session.queue.length, remaining: session.queue.length - answers.length },
      current: publicQuestion(session, current),
      submitted: answers.map(answer => publicAnswer(session, answer)),
      lastFeedback: publicAnswer(session, answers[answers.length - 1]),
      sourceRefs: await artifacts.currency(session.sourceRefs || []),
      statsSource: 'practice-session',
      scheduling: 'simple-interval-not-fsrs',
      ...extra,
    };
  }

  async function loadQuiz(quizPath) {
    const path = recordPath(quizPath, QUIZ_PREFIX);
    const quiz = await learning.commands['learning/quiz/read']({ path });
    if (!quiz || quiz.kind !== 'quiz') fail('这不是一份练习');
    if (!Array.isArray(quiz.questions) || !quiz.questions.length) fail('练习没有题目');
    const seen = new Set();
    for (const question of quiz.questions) {
      if (typeof question.id !== 'string' || !question.id.trim()) fail('题目缺少编号');
      if (seen.has(question.id)) fail('题目编号重复');
      seen.add(question.id);
      if (question.options !== undefined) {
        if (!Array.isArray(question.options) || question.options.length < 2) fail('选择题需要至少两个选项');
        if (!Number.isSafeInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= question.options.length) fail('选择题答案索引无效');
      }
    }
    const refs = await artifacts.pinSources((quiz.sourceRefs || []).map(ref => ({ id: ref.libraryId ?? ref.id, version: ref.version })));
    for (const question of quiz.questions) await artifacts.verifyEvidence(question.evidence, refs);
    return { quiz, refs };
  }

  async function collectState() {
    const entries = (await artifacts.list(SESSION_PREFIX)).slice().sort((a, b) => a.path.localeCompare(b.path));
    const truncated = entries.length > MAX_SCAN;
    const chosen = entries.slice(0, MAX_SCAN);
    const events = [];
    for (const entry of chosen) {
      const session = await artifacts.read(entry.path, 'practice-session');
      for (const answer of session.answers || []) {
        const outcome = effectiveOutcome(answer);
        if (!outcome) continue;
        events.push({
          quizId: session.quizId, quizPath: session.quizPath, quizSha256: session.quizSha256,
          questionId: answer.questionId, at: answer.at, outcome, grading: answer.grading,
        });
      }
    }
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.questionId.localeCompare(b.questionId));
    const items = new Map();
    for (const event of events) {
      const prev = items.get(itemKey(event.quizId, event.questionId, event.quizSha256));
      const streak = event.outcome === 'correct' ? (prev?.streak ?? 0) + 1 : 0;
      items.set(itemKey(event.quizId, event.questionId, event.quizSha256), {
        ...event, streak, lastOutcome: event.outcome,
        dueAt: new Date(Date.parse(event.at) + intervalDays(event.outcome, streak) * DAY_MS).toISOString(),
      });
    }
    return { items, truncated, scanned: chosen.length, listed: entries.length };
  }

  function publicItem(item) {
    return {
      quizId: item.quizId, quizPath: item.quizPath, quizSha256: item.quizSha256, questionId: item.questionId,
      lastOutcome: item.lastOutcome, lastAt: item.at, streak: item.streak, dueAt: item.dueAt, grading: item.grading,
    };
  }

  async function existingSession(path) {
    return (await artifacts.list(SESSION_PREFIX)).find(entry => entry.path === path) ?? null;
  }

  function grade(session, params) {
    if (Object.hasOwn(params, 'outcome') || Object.hasOwn(params, 'correct')) fail('判分由服务器完成，不能传入 outcome');
    const questionId = text(params.questionId, 'questionId', 120);
    const submissionId = idValue(params.submissionId, 'submissionId');
    let selfRating;
    if (params.selfRating != null && params.selfRating !== '') {
      if (!['correct', 'wrong'].includes(params.selfRating)) fail('selfRating 只能是 correct 或 wrong');
      selfRating = params.selfRating;
    }
    const feedback = params.feedback != null && params.feedback !== '' ? text(String(params.feedback), 'feedback', 2000) : undefined;
    let answerIndex = params.answerIndex;
    let answerText = params.answerText;
    if (answerIndex !== undefined && answerIndex !== null && !Number.isSafeInteger(answerIndex)) fail('answerIndex 必须是整数');
    if (answerIndex === undefined) answerIndex = null;
    if (answerText != null && String(answerText).trim()) answerText = text(String(answerText), '作答文本', 4000);
    else answerText = null;
    if (answerIndex == null && !answerText) fail('需要 answerIndex 或 answerText');

    const question = (session.questions || []).find(item => item.id === questionId);
    const choice = Array.isArray(question?.options) && question.options.length >= 2;
    if (question && !choice && answerIndex != null) fail('开放题请使用 answerText');
    let resolvedIndex = answerIndex;
    if (question && choice) {
      if (selfRating || feedback) fail('选择题由服务器判分，不能使用 selfRating');
      if (resolvedIndex == null) {
        resolvedIndex = question.options.findIndex(option => option === answerText);
        if (resolvedIndex < 0) fail('找不到匹配的选项');
      }
      if (resolvedIndex < 0 || resolvedIndex >= question.options.length) fail('选择题答案索引无效');
      if (answerText != null && question.options[resolvedIndex] !== answerText) fail('answerText 与 answerIndex 不一致');
    }

    const existing = (session.answers || []).find(item => item.submissionId === submissionId);
    if (existing) {
      const same = existing.questionId === questionId && (choice
        ? existing.answerIndex === resolvedIndex
        : existing.answerText === answerText
          && (Object.hasOwn(existing, 'submittedSelfRating') ? existing.submittedSelfRating : existing.selfRating ?? null) === (selfRating ?? null)
          && (Object.hasOwn(existing, 'submittedFeedback') ? existing.submittedFeedback : existing.feedback ?? null) === (feedback ?? null));
      if (!same) fail('同一提交编号不能使用不同作答');
      return { duplicate: true, answer: existing, next: session };
    }

    if (!question) fail('练习里没有这道题');
    if ((session.answers || []).some(item => item.questionId === questionId)) fail('本题已提交');
    if (session.status === 'completed' || session.queue[session.cursor] !== questionId) fail('不能回答未到的题目');

    let answer;
    if (choice) {
      answer = {
        questionId, submissionId, answerIndex: resolvedIndex, answerText,
        outcome: resolvedIndex === question.answerIndex ? 'correct' : 'wrong',
        grading: 'server', at: new Date().toISOString(),
      };
    } else {
      if (answerIndex != null) fail('开放题请使用 answerText');
      answer = {
        questionId, submissionId, answerIndex: null, answerText,
        outcome: 'awaiting_assessment',
        submittedSelfRating: selfRating ?? null, submittedFeedback: feedback ?? null,
        grading: selfRating ? 'self-reported' : 'unscored',
        at: new Date().toISOString(),
        ...(selfRating ? { selfRating } : {}),
        ...(feedback ? { feedback } : {}),
      };
    }
    const next = clone(session);
    next.answers = [...(next.answers || []), answer];
    next.cursor = next.cursor + 1;
    next.status = next.cursor >= next.queue.length ? 'completed' : 'in_progress';
    return { duplicate: false, answer, next };
  }

  const commands = {
    'learning/practice/start': async (params = {}) => {
      const id = idValue(params.sessionId, 'sessionId');
      const quizPath = recordPath(params.quizPath, QUIZ_PREFIX);
      const mode = modeOf(params.mode);
      const now = parseNow(params.now);
      const path = sessionPath(id);
      const listed = await existingSession(path);
      if (listed) {
        const existing = await artifacts.read(path, 'practice-session');
        if (existing.quizPath !== quizPath || existing.mode !== mode || (existing.startNow ?? null) !== (params.now ?? null)) fail('同一 sessionId 已用不同参数创建');
        return publicSession(existing);
      }
      const { quiz, refs } = await loadQuiz(quizPath);
      const { items, truncated } = await collectState();
      let queue = quiz.questions.map(question => question.id);
      if (mode !== 'all') {
        queue = quiz.questions.filter(question => {
          const state = items.get(itemKey(quiz.id, question.id, quiz.sha256));
          if (!state) return false;
          return mode === 'wrong' ? state.lastOutcome === 'wrong' : Date.parse(state.dueAt) <= now;
        }).map(question => question.id);
      }
      if (!queue.length) {
        return {
          status: 'empty', mode, quizPath, quizId: quiz.id, quizSha256: quiz.sha256,
          pending: 0, current: null, written: false, truncated,
          message: mode === 'wrong' ? '没有错题待练' : '没有到期题目待练',
          statsSource: 'practice-session', scheduling: 'simple-interval-not-fsrs',
        };
      }
      const selected = new Set(queue);
      const session = {
        schemaVersion: 1, kind: 'practice-session', id, path, quizPath, title: quiz.title, startNow: params.now ?? null,
        quizId: quiz.id, quizSha256: quiz.sha256, mode, status: 'in_progress',
        sourceRefs: refs, queue, cursor: 0, answers: [], revision: 0,
        questions: quiz.questions.filter(question => selected.has(question.id)).map(question => ({
          id: question.id, prompt: question.prompt, options: question.options,
          answerIndex: question.answerIndex, explanation: question.explanation, evidence: question.evidence,
        })),
      };
      let saved;
      try {
        saved = await artifacts.write(path, session);
      } catch (error) {
        if (error.rpc?.code !== -32005) throw error;
        const existing = await artifacts.read(path, 'practice-session');
        if (existing.quizPath !== quizPath || existing.mode !== mode || (existing.startNow ?? null) !== (params.now ?? null)) fail('同一 sessionId 已用不同参数创建');
        return publicSession(existing, truncated ? { truncated } : {});
      }
      return publicSession(saved, truncated ? { truncated } : {});
    },

    'learning/practice/read': async (params = {}) => {
      const path = params.path ? recordPath(params.path, SESSION_PREFIX) : sessionPath(idValue(params.sessionId, 'sessionId'));
      return publicSession(await artifacts.read(path, 'practice-session'));
    },

    'learning/practice/answer': async (params = {}) => {
      const path = recordPath(params.path, SESSION_PREFIX);
      let last;
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        const loaded = await artifacts.read(path, 'practice-session');
        const graded = grade(loaded, params);
        if (graded.duplicate) {
          return { duplicate: true, result: publicAnswer(loaded, graded.answer), session: await publicSession(loaded) };
        }
        try {
          const saved = await artifacts.write(path, graded.next, loaded.sha256);
          return { duplicate: false, result: publicAnswer(saved, graded.answer), session: await publicSession(saved) };
        } catch (error) {
          last = error;
          if (error.rpc?.code !== -32005) throw error;
        }
      }
      throw last;
    },

    'learning/practice/assess': async (params = {}) => {
      const path = recordPath(params.path, SESSION_PREFIX);
      const questionId = text(params.questionId, 'questionId', 120);
      const assessmentId = idValue(params.assessmentId, 'assessmentId');
      if (!['correct', 'wrong'].includes(params.selfRating)) fail('自评需要 selfRating: correct 或 wrong');
      const feedback = params.feedback ? text(params.feedback, '自评说明', 2000) : '';
      for (let retry = 0; retry < MAX_RETRY; retry++) {
        const session = await artifacts.read(path, 'practice-session');
        const question = session.questions.find(item => item.id === questionId);
        const answer = session.answers.find(item => item.questionId === questionId);
        if (!answer || !question || question.options) fail('只能对已作答的开放题做自评');
        const existing = session.answers.flatMap(item => (item.assessments ?? []).map(value => ({ ...value, questionId: item.questionId }))).find(item => item.assessmentId === assessmentId);
        if (existing) {
          if (existing.questionId !== questionId || existing.selfRating !== params.selfRating || existing.feedback !== feedback) fail('同一自评编号不能使用不同内容');
          return { duplicate: true, session: await publicSession(session) };
        }
        if ((answer.assessments ?? []).length >= 50) fail('本题自评记录已达上限，请开启新的练习');
        answer.assessments = [...(answer.assessments ?? []), { assessmentId, selfRating: params.selfRating, feedback, at: new Date().toISOString(), reviewer: 'user' }];
        answer.selfRating = params.selfRating; answer.grading = 'self-reported'; answer.feedback = feedback;
        try { return { duplicate: false, session: await publicSession(await artifacts.write(path, session, session.sha256)) }; }
        catch (error) { if (error.rpc?.code !== -32005) throw error; }
      }
      fail('保存自评时发生并发冲突，请重试', -32005);
    },

    'learning/practice/due': async (params = {}) => {
      const now = parseNow(params.now);
      const { items, truncated, scanned, listed } = await collectState();
      const due = [];
      const wrong = [];
      const quizzes = await artifacts.list(QUIZ_PREFIX);
      const withCurrency = item => {
        // quizId belongs to the quiz document; library entries have their own IDs.
        const current = quizzes.find(quiz => quiz.path === item.quizPath);
        return { ...publicItem(item), quizStatus: !current ? 'missing' : current.sha256 === item.quizSha256 ? 'current' : 'superseded' };
      };
      for (const item of items.values()) {
        if (item.lastOutcome === 'wrong') wrong.push(item);
        if (Date.parse(item.dueAt) <= now) due.push(item);
      }
      due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.questionId.localeCompare(b.questionId));
      wrong.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.questionId.localeCompare(b.questionId));
      return {
        algorithm: 'simple-interval',
        notFsrs: true,
        algorithmNote: '按已保存作答时间计算的可解释简单间隔：连续答对间隔 1/2/4/8… 天（上限 30 天），答错为次日。这不是 FSRS。',
        statsSource: 'learning/练习会话 作答记录',
        masteryAggregate: 'not-used',
        now: new Date(now).toISOString(),
        due: due.map(withCurrency),
        wrong: wrong.map(withCurrency),
        truncated,
        scannedSessions: scanned,
        listedSessions: listed,
      };
    },
  };

  const toolDescriptors = () => [{
    name: 'learning_practice',
    source: 'learning',
    description: 'Deterministic per-question practice over a pinned quiz snapshot. Actions: start, read, answer, assess, due. After an open answer is saved, assess records only the learner’s explicit self-assessment with its own stable assessmentId; do not invent a rating for the learner. Multiple-choice is server-graded (callers cannot pass outcome). Open questions are recorded as awaiting_assessment unless the learner supplies an explicit selfRating, which is labelled self-reported and is not server grading. start/read return only the current item (no future answers or explanations). due/wrong queues are derived from saved practice-session answer times with a simple 1/2/4/8… (max 30d) / next-day-on-wrong interval — not FSRS and not topic mastery. Empty wrong/due queues return empty and write nothing. Same sessionId+params is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'read', 'answer', 'assess', 'due'] },
        quizPath: { type: 'string' },
        sessionId: { type: 'string' },
        path: { type: 'string' },
        mode: { type: 'string', enum: ['all', 'wrong', 'due'] },
        questionId: { type: 'string' },
        submissionId: { type: 'string' },
        assessmentId: { type: 'string', description: 'For assess: stable retry key for the learner’s explicit self-assessment of an already submitted open answer.' },
        answerIndex: { type: 'integer' },
        answerText: { type: 'string' },
        selfRating: { type: 'string', enum: ['correct', 'wrong'] },
        feedback: { type: 'string' },
        now: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }];

  async function callTool(name, params = {}) {
    if (name !== 'learning_practice') return undefined;
    const map = { start: 'learning/practice/start', read: 'learning/practice/read', answer: 'learning/practice/answer', assess: 'learning/practice/assess', due: 'learning/practice/due' };
    if (!Object.hasOwn(map, params.action)) fail('learning_practice 需要 action: start/read/answer/assess/due');
    return commands[map[params.action]](params);
  }

  return { commands, toolDescriptors, callTool };
}

module.exports = { createLearningPractice };
