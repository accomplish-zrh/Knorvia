'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLearningPack } = require('../learning-pack');
const { createLearningPractice } = require('../learning-practice');
const { createDomainArtifacts } = require('../domain-artifacts');
const { createFakeLibrary } = require('./learning-practice-fake-library');

const SOURCE = '# 概念\n\n周期信号可分解为正弦波叠加。\n\n## 应用\n\nDCT 是其实数版本。\n';
const DAY_MS = 24 * 3600 * 1000;
const EXPLAIN_Q1 = 'EXPLAIN_Q1_ONLY';
const EXPLAIN_Q2 = 'EXPLAIN_Q2_FUTURE';
const QUOTE_Q1 = '周期信号可分解为正弦波叠加。';
const QUOTE_Q2 = 'DCT 是其实数版本。';

function leak(view) {
  const raw = JSON.stringify(view);
  return {
    raw,
    hasQ1Explain: raw.includes(EXPLAIN_Q1),
    hasQ2Explain: raw.includes(EXPLAIN_Q2),
    hasAnswerIndex: raw.includes('answerIndex'),
    hasQuote1: raw.includes(QUOTE_Q1),
    hasQuote2: raw.includes(QUOTE_Q2),
    hasQuestions: Object.hasOwn(view, 'questions') || Object.hasOwn(view.session || {}, 'questions'),
  };
}

async function seed() {
  const library = createFakeLibrary();
  const learning = createLearningPack({ library });
  const practice = createLearningPractice({ library, learning });
  const artifacts = createDomainArtifacts(library);
  const source = await library.handlers['library/write']({ path: '资料/课件.md', text: SOURCE });
  const refs = [{ id: source.id, version: source.sha256 }];
  const evidence = (line, quote) => ({ libraryId: source.id, version: source.sha256, line, quote });
  const quiz = await learning.commands['learning/quiz/create']({
    topic: '信号', authorship: 'agent', sourceRefs: refs,
    questions: [
      { id: 'q1', prompt: '周期信号可分解为什么？', options: ['正弦波', '方波'], answerIndex: 0, explanation: EXPLAIN_Q1, evidence: evidence(3, QUOTE_Q1) },
      { id: 'q2', prompt: 'DCT 是什么？', options: ['复版本', '实数版本'], answerIndex: 1, explanation: EXPLAIN_Q2, evidence: evidence(7, QUOTE_Q2) },
      { id: 'q3', prompt: '请用一句话说明傅里叶分解。', explanation: 'OPEN_EXPLAIN', evidence: evidence(3, QUOTE_Q1) },
    ],
  });
  const sid = () => crypto.randomUUID();
  return { library, learning, practice, artifacts, source, quiz, sid, refs };
}

test('fake library hashes actual bytes and enforces CAS', async () => {
  const library = createFakeLibrary();
  const first = await library.handlers['library/write']({ path: '资料/a.md', text: '原文' });
  assert.equal(first.sha256.length, 64);
  await assert.rejects(library.handlers['library/write']({ path: '资料/a.md', text: '覆盖' }), error => error.rpc.code === -32005);
  await assert.rejects(library.handlers['library/write']({ path: '资料/a.md', text: '覆盖', expectedSha256: '0'.repeat(64) }), error => error.rpc.code === -32005);
  const second = await library.handlers['library/write']({ path: '资料/a.md', text: '已编辑', expectedSha256: first.sha256 });
  assert.notEqual(second.sha256, first.sha256);
  const versions = await library.handlers['library/versions']({ id: first.id });
  assert.equal(versions.length, 2);
  const old = await library.handlers['library/read']({ id: first.id, version: first.sha256 });
  assert.equal(Buffer.from(old.base64, 'base64').toString('utf8'), '原文');
  library.corrupt('资料/a.md');
  const artifacts = createDomainArtifacts(library);
  await assert.rejects(artifacts.readVersion(first.id, second.sha256), /校验失败/);
});

test('open answers reveal evidence after submission, then explicit self-assessment is durable and idempotent', async () => {
  const { practice, quiz, sid } = await seed();
  const session = await practice.callTool('learning_practice', { action: 'start', quizPath: quiz.path, sessionId: sid() });
  const answer = params => practice.callTool('learning_practice', { action: 'answer', path: session.path, submissionId: sid(), ...params });
  await answer({ questionId: 'q1', answerIndex: 0 });
  await answer({ questionId: 'q2', answerIndex: 1 });
  const payload = { questionId: 'q3', answerText: '这是我的解释', submissionId: sid() };
  const submitted = await answer(payload);
  assert.equal(submitted.result.answerText, payload.answerText);
  assert.equal(submitted.result.evidence.quote, QUOTE_Q1);
  assert.equal(submitted.result.grading, 'unscored');
  const assessment = { action: 'assess', path: session.path, questionId: 'q3', assessmentId: sid(), selfRating: 'wrong' };
  const assessed = await practice.callTool('learning_practice', assessment);
  assert.equal(assessed.session.lastFeedback.grading, 'self-reported');
  assert.equal(assessed.session.lastFeedback.selfRating, 'wrong');
  assert.equal((await practice.callTool('learning_practice', assessment)).duplicate, true);
  await assert.rejects(practice.callTool('learning_practice', { ...assessment, selfRating: 'correct' }), /不同内容/);
  await assert.rejects(practice.callTool('learning_practice', { ...assessment, questionId: 'q1', assessmentId: sid() }), /开放题/);
  assert.equal((await answer(payload)).duplicate, true, 'a later assessment must not invalidate the original submission retry');
  const due = await practice.callTool('learning_practice', { action: 'due' });
  assert.equal(due.wrong.find(item => item.questionId === 'q3').grading, 'self-reported');
});

test('start/read hide future answers and quotes; same sessionId is idempotent', async () => {
  const { practice, quiz, sid, learning } = await seed();
  let recorded = 0;
  const original = learning.commands['learning/attempt/record'];
  learning.commands['learning/attempt/record'] = async params => { recorded += 1; return original(params); };
  const sessionId = sid();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId });
  assert.equal(started.status, 'in_progress');
  assert.equal(started.current.questionId, 'q1');
  assert.equal(started.progress.total, 3);
  assert.equal(started.scheduling, 'simple-interval-not-fsrs');
  const leaked = leak(started);
  assert.equal(leaked.hasQ1Explain, false);
  assert.equal(leaked.hasQ2Explain, false);
  assert.equal(leaked.hasAnswerIndex, false);
  assert.equal(leaked.hasQuote1, false);
  assert.equal(leaked.hasQuote2, false);
  assert.equal(leaked.hasQuestions, false);
  assert.equal(started.current.source.line, 3);
  assert.equal(started.current.source.quote, undefined);
  const again = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId });
  assert.equal(again.sha256, started.sha256);
  assert.equal(again.current.questionId, 'q1');
  await assert.rejects(practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId, mode: 'wrong' }), /不同参数/);
  const read = await practice.commands['learning/practice/read']({ path: started.path });
  assert.equal(read.current.questionId, 'q1');
  assert.equal(recorded, 0);
});

test('choice grading, illegal index, unknown question, forged outcome', async () => {
  const { practice, quiz, sid } = await seed();
  const started = await practice.callTool('learning_practice', { action: 'start', quizPath: quiz.path, sessionId: sid() });
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q1', submissionId: 'submit-00', answerIndex: 0, outcome: 'correct',
  }), /outcome/);
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q1', submissionId: 'submit-01', answerIndex: 9,
  }), /答案索引无效/);
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'ghost-question', submissionId: 'submit-02', answerIndex: 0,
  }), /没有这道题/);
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q2', submissionId: 'submit-03', answerIndex: 1,
  }), /未到的题目/);
  const wrong = await practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q1', submissionId: 'submit-04', answerIndex: 1,
  });
  assert.equal(wrong.duplicate, false);
  assert.equal(wrong.result.outcome, 'wrong');
  assert.equal(wrong.result.grading, 'server');
  assert.equal(wrong.result.explanation, EXPLAIN_Q1);
  assert.equal(wrong.session.current.questionId, 'q2');
  const leaked = leak(wrong.session);
  assert.equal(leaked.hasQ2Explain, false);
  assert.equal(leaked.hasAnswerIndex, false);
  const dup = await practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q1', submissionId: 'submit-04', answerIndex: 1,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.result.at, wrong.result.at);
  assert.equal(dup.session.progress.answered, 1);
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q1', submissionId: 'submit-04', answerIndex: 0,
  }), /不同作答/);
  const right = await practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q2', submissionId: 'submit-05', answerText: '实数版本',
  });
  assert.equal(right.result.outcome, 'correct');
  assert.equal(right.session.status, 'in_progress');
  assert.equal(right.session.current.questionId, 'q3');
});

test('open questions are not auto-graded and unscored answers stay out of due/wrong', async () => {
  const { practice, quiz, sid } = await seed();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-11', answerIndex: 0 });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q2', submissionId: 'submit-12', answerIndex: 1 });
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q3', submissionId: 'submit-13', answerIndex: 0,
  }), /开放题/);
  const unscored = await practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q3', submissionId: 'submit-14', answerText: '分解为正弦波',
  });
  assert.equal(unscored.result.outcome, 'awaiting_assessment');
  assert.equal(unscored.result.grading, 'unscored');
  const dueUnscored = await practice.commands['learning/practice/due']({});
  assert.equal(dueUnscored.wrong.some(item => item.questionId === 'q3'), false);
  assert.equal(dueUnscored.due.some(item => item.questionId === 'q3'), false);
});

test('open selfRating is self-reported and never treated as server grading', async () => {
  const { practice, quiz, sid } = await seed();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-11', answerIndex: 0 });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q2', submissionId: 'submit-12', answerIndex: 1 });
  const open = await practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q3', submissionId: 'submit-14', answerText: '分解为正弦波',
    selfRating: 'wrong', feedback: '我不确定',
  });
  assert.equal(open.result.outcome, 'awaiting_assessment');
  assert.equal(open.result.grading, 'self-reported');
  assert.equal(open.result.selfReported, true);
  assert.equal(open.result.selfRating, 'wrong');
  assert.equal(open.session.status, 'completed');
  assert.equal(open.session.current, null);
  await assert.rejects(practice.commands['learning/practice/answer']({
    path: started.path, questionId: 'q3', submissionId: 'submit-15', answerText: '再答一次',
  }), /本题已提交/);
});

test('rebuild restores the same session; errors do not drop a saved answer', async () => {
  const { library, learning, practice, quiz, sid } = await seed();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-21', answerIndex: 0 });
  const reopened = createLearningPractice({ library, learning });
  const read = await reopened.commands['learning/practice/read']({ sessionId: started.sessionId });
  assert.equal(read.progress.answered, 1);
  assert.equal(read.current.questionId, 'q2');
  assert.equal(read.lastFeedback.outcome, 'correct');
  assert.equal(read.sha256, (await practice.commands['learning/practice/read']({ path: started.path })).sha256);
  await assert.rejects(reopened.commands['learning/practice/answer']({
    path: started.path, questionId: 'q2', submissionId: 'submit-22', answerIndex: 9,
  }), /答案索引无效/);
  const afterError = await reopened.commands['learning/practice/read']({ path: started.path });
  assert.equal(afterError.progress.answered, 1);
  assert.equal(afterError.current.questionId, 'q2');
});

test('concurrent submissions CAS: same key is idempotent, different keys do not double-count', async () => {
  const { library, practice, quiz, sid } = await seed();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  const resume = library.blockWrites();
  const same = [
    practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-31', answerIndex: 0 }),
    practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-31', answerIndex: 0 }),
  ];
  await new Promise(resolve => setTimeout(resolve, 20));
  resume();
  const sameResults = await Promise.all(same);
  assert.equal(sameResults.filter(item => item.result.outcome === 'correct').length, 2);
  assert.equal(sameResults.filter(item => item.duplicate).length, 1);
  assert.equal(sameResults[0].session.progress.answered, 1);
  assert.equal(sameResults[1].session.progress.answered, 1);

  const started2 = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  const resume2 = library.blockWrites();
  const raced = [
    practice.commands['learning/practice/answer']({ path: started2.path, questionId: 'q1', submissionId: 'submit-32', answerIndex: 0 }),
    practice.commands['learning/practice/answer']({ path: started2.path, questionId: 'q1', submissionId: 'submit-33', answerIndex: 1 }),
  ];
  await new Promise(resolve => setTimeout(resolve, 20));
  resume2();
  const racedResults = await Promise.allSettled(raced);
  assert.equal(racedResults.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(racedResults.filter(item => item.status === 'rejected').length, 1);
  const winner = racedResults.find(item => item.status === 'fulfilled').value;
  assert.equal(winner.session.progress.answered, 1);
  const rejected = racedResults.find(item => item.status === 'rejected').reason;
  assert.match(rejected.message, /本题已提交|未到的题目|已有更新/);
});

test('wrong/due queues use saved answer times; empty queues write nothing and are not FSRS', async () => {
  const { library, practice, quiz, sid } = await seed();
  const emptyWrong = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'wrong' });
  assert.equal(emptyWrong.status, 'empty');
  assert.equal(emptyWrong.written, false);
  assert.match(emptyWrong.message, /没有错题/);
  const emptyDue = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'due' });
  assert.equal(emptyDue.status, 'empty');
  assert.equal(emptyDue.written, false);
  const listed = await library.handlers['library/list']({});
  assert.equal(listed.entries.filter(entry => entry.path.startsWith('learning/练习会话/')).length, 0);

  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  const first = await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-41', answerIndex: 1 });
  const at = Date.parse(first.result.at);
  const dueNow = await practice.commands['learning/practice/due']({ now: new Date(at).toISOString() });
  assert.equal(dueNow.notFsrs, true);
  assert.match(dueNow.algorithmNote, /不是 FSRS/);
  assert.equal(dueNow.statsSource.includes('练习会话'), true);
  assert.equal(dueNow.masteryAggregate, 'not-used');
  assert.equal(dueNow.wrong.length, 1);
  assert.equal(dueNow.wrong[0].questionId, 'q1');
  assert.equal(dueNow.wrong[0].quizStatus, 'current');
  assert.equal(dueNow.due.length, 0, '答错后次日才到期，不能用查询时刻捏造');
  const dueTomorrow = await practice.commands['learning/practice/due']({ now: new Date(at + DAY_MS).toISOString() });
  assert.equal(dueTomorrow.due.length, 1);
  assert.equal(dueTomorrow.due[0].dueAt, new Date(at + DAY_MS).toISOString());

  const wrongStart = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'wrong' });
  assert.equal(wrongStart.status, 'in_progress');
  assert.equal(wrongStart.current.questionId, 'q1');
  assert.equal(wrongStart.progress.total, 1);

  const dueStartNow = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'due', now: new Date(at).toISOString() });
  assert.equal(dueStartNow.status, 'empty');
  const dueStartLater = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'due', now: new Date(at + DAY_MS).toISOString() });
  assert.equal(dueStartLater.current.questionId, 'q1');
});

test('consecutive correct intervals are 1/2/4 days from saved answer times', async () => {
  const { practice, quiz, sid } = await seed();
  let lastAt;
  for (let i = 0; i < 3; i++) {
    const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
    const answered = await practice.commands['learning/practice/answer']({
      path: started.path, questionId: 'q1', submissionId: `submit-7${i}`, answerIndex: 0,
    });
    lastAt = Date.parse(answered.result.at);
  }
  const dueBefore = await practice.commands['learning/practice/due']({ now: new Date(lastAt + 4 * DAY_MS - 1).toISOString() });
  assert.equal(dueBefore.due.some(item => item.questionId === 'q1'), false);
  const dueAt = await practice.commands['learning/practice/due']({ now: new Date(lastAt + 4 * DAY_MS).toISOString() });
  const item = dueAt.due.find(row => row.questionId === 'q1');
  assert.ok(item);
  assert.equal(item.streak, 3);
  assert.equal(item.lastOutcome, 'correct');
  assert.equal(item.dueAt, new Date(lastAt + 4 * DAY_MS).toISOString());
  assert.equal(dueAt.wrong.some(row => row.questionId === 'q1'), false);
});

test('source updates mark currency; mismatched quotes are rejected; old quiz versions do not score the new one', async () => {
  const { library, practice, learning, quiz, source, sid, refs } = await seed();
  const started = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
  await practice.commands['learning/practice/answer']({ path: started.path, questionId: 'q1', submissionId: 'submit-51', answerIndex: 1 });
  await library.handlers['library/write']({ path: source.path, text: '# 已更新\n新资料版本。\n', expectedSha256: source.sha256 });
  const read = await practice.commands['learning/practice/read']({ path: started.path });
  assert.equal(read.sourceRefs[0].evidenceStatus, 'superseded');
  assert.equal(read.current.questionId, 'q2');

  const bad = await learning.commands['learning/quiz/create']({
    topic: '信号', authorship: 'agent', sourceRefs: refs,
    questions: [{ id: 'q1', prompt: '编造题', options: ['a', 'b'], answerIndex: 0, explanation: EXPLAIN_Q1, evidence: { libraryId: source.id, version: refs[0].version, line: 3, quote: '这段原文并不存在' } }],
  });
  await assert.rejects(practice.commands['learning/practice/start']({ quizPath: bad.path, sessionId: sid() }), /原文不符/);

  const entry = (await library.handlers['library/list']({})).entries.find(item => item.path === quiz.path);
  const part = await library.handlers['library/read']({ id: entry.id, version: entry.sha256 });
  const body = JSON.parse(Buffer.from(part.base64, 'base64').toString('utf8'));
  body.questions[0].prompt += '（修订）';
  await library.handlers['library/write']({ path: quiz.path, text: JSON.stringify(body, null, 2), expectedSha256: entry.sha256 });
  const newQuiz = await learning.commands['learning/quiz/read']({ path: quiz.path });
  assert.notEqual(newQuiz.sha256, quiz.sha256);
  const historicalQueue = await practice.commands['learning/practice/due']({});
  assert.equal(historicalQueue.wrong.find(item => item.quizPath === quiz.path).quizStatus, 'superseded');
  const wrongOnNew = await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid(), mode: 'wrong' });
  assert.equal(wrongOnNew.status, 'empty', '旧版本错题不能算进新版本');
});

test('due truncation is explicit; tool descriptors and slash commands stay aligned', async () => {
  const { library, practice, quiz, sid, artifacts } = await seed();
  for (let i = 0; i < 201; i++) {
    const id = `trunc${String(i).padStart(3, '0')}x`;
    await artifacts.write(`learning/练习会话/${id}.json`, {
      schemaVersion: 1, kind: 'practice-session', id, quizPath: quiz.path, quizId: quiz.id,
      quizSha256: quiz.sha256, mode: 'all', status: 'completed', sourceRefs: [],
      questions: [], queue: [], cursor: 0, answers: [], revision: 0,
    });
  }
  const due = await practice.commands['learning/practice/due']({});
  assert.equal(due.truncated, true);
  assert.equal(due.scannedSessions, 200);
  assert.ok(due.listedSessions > 200);
  const tools = practice.toolDescriptors();
  assert.equal(tools[0].name, 'learning_practice');
  assert.deepEqual(tools[0].inputSchema.properties.action.enum, ['start', 'read', 'answer', 'assess', 'due']);
  assert.ok(practice.commands['learning/practice/start']);
  const empty = await practice.callTool('learning_practice', { action: 'due' });
  assert.equal(empty.truncated, true);
  const unknown = await practice.callTool('learning_sources', {});
  assert.equal(unknown, undefined);
  await assert.rejects(practice.callTool('learning_practice', { action: 'grade' }), /action/);
  await practice.commands['learning/practice/start']({ quizPath: quiz.path, sessionId: sid() });
});
