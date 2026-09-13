import { test, expect, type Page } from '@playwright/test';

const fixtureWorkspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!fixtureWorkspace, 'Requires an isolated native gateway fixture');
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' });
test.describe.configure({ timeout: 120_000 });

async function rpc<T>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ method, params }) => {
    const response = await fetch('/api/knorvia/native/session', { headers: { 'x-knorvia-native-origin': location.origin }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Gateway session: ${response.status}`);
    const session = await response.json();
    const target = new URL(session.url || '/api/knorvia/native', location.href);
    target.protocol = target.protocol.startsWith('https') || target.protocol.startsWith('wss') ? 'wss:' : 'ws:';
    const socket = new WebSocket(target.href, ['knorvia.native.v1', `knorvia.native.token.${session.token}`]);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 20_000);
        socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'domain-audit', method, params }));
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Gateway socket error')); };
        socket.onmessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== 'domain-audit') return;
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        };
      });
    } finally { socket.close(); }
  }, { method, params }) as Promise<T>;
}

test.beforeEach(async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname);
  expect(fixtureWorkspace!.replaceAll('\\', '/')).toMatch(/\/isolated-home\/workspace\/?$/);
  await page.addInitScript(() => {
    localStorage.setItem('knorvia-language', 'zh'); localStorage.setItem('knorvia-theme', 'snow');
  });
  await page.goto('/workbench');
  await expect(page.locator('.nw-connection.is-connected')).toBeVisible({ timeout: 60_000 });
});

test('library source opens learning; choice and written answers survive reload and feed review', async ({ page }) => {
  const suffix = Date.now();
  const source = await rpc<{ id: string; sha256: string; path: string }>(page, 'library/write', { path: `资料/学习验收-${suffix}.md`, text: '# 光合作用\n植物利用光能制造有机物。\n氧气是产物之一。\n' });
  const quiz = await rpc<{ path: string; title: string }>(page, 'learning/quiz/create', { topic: '光合作用验收', title: `逐题验收-${suffix}`, authorship: 'agent', sourceRefs: [{ id: source.id, version: source.sha256 }], questions: [
    { id: 'choice', prompt: '植物利用什么能量？', options: ['光能', '声能'], answerIndex: 0, explanation: '从第一条原文可以定位到光能。', evidence: { libraryId: source.id, line: 2, quote: '植物利用光能制造有机物。' } },
    { id: 'recall', prompt: '用自己的话解释光合作用。', explanation: '比较你的解释是否包含能量与产物。', evidence: { libraryId: source.id, line: 3, quote: '氧气是产物之一。' } },
  ] });
  await page.goto('/workbench/library');
  const menu = page.getByRole('button', { name: `资料操作: ${source.path}`, exact: true });
  await menu.last().click();
  await page.getByRole('menuitem', { name: '用这份资料学习', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/learning\\?source=${source.id}`));
  await expect(page.getByRole('combobox', { name: '选择资料' })).toHaveValue(source.id);
  await page.getByRole('button', { name: quiz.title, exact: true }).click();
  await page.getByRole('button', { name: '开始逐题练习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '植物利用什么能量？', exact: true })).toBeVisible();
  await expect(page.getByText('从第一条原文可以定位到光能。', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: '声能', exact: true }).check();
  await page.getByRole('button', { name: '提交作答', exact: true }).click();
  await expect(page.getByText('1. 需要复习', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '用自己的话解释光合作用。', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '用自己的话回答' }).fill('植物利用光能制造有机物，也会产生氧气。');
  await page.getByRole('button', { name: '提交作答', exact: true }).click();
  await expect(page.getByText('2. 回答已保存，待评估', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '自评：还需练习', exact: true }).click();
  await expect(page.getByText('你的自评：还需练习', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^继续练习 ·/ }).last().click();
  await expect(page.getByText('植物利用光能制造有机物，也会产生氧气。', { exact: true })).toBeVisible();
  await expect(page.getByText('你的自评：还需练习', { exact: true })).toBeVisible();
  const queue = await rpc<{ wrong: { quizPath: string; questionId: string; quizStatus: string }[] }>(page, 'learning/practice/due');
  expect(queue.wrong.filter(item => item.quizPath === quiz.path).map(item => item.questionId).sort()).toEqual(['choice', 'recall']);
  expect(queue.wrong.filter(item => item.quizPath === quiz.path).every(item => item.quizStatus === 'current')).toBe(true);
  const review = page.getByRole('button', { name: `继续复习 · ${quiz.title}`, exact: true });
  await expect(review).toBeVisible();
  await page.screenshot({ path: '../.task/learning-practice.png', fullPage: true });
  await review.click();
  await page.getByRole('button', { name: '只练错题', exact: true }).click();
  await expect(page.getByText('0 / 2 题已作答', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '植物利用什么能量？', exact: true })).toBeVisible();
});

test('built-in plans search, copy and fill a draft without starting a task', async ({ page }) => {
  const workspaces = await rpc<{ id: string }[]>(page, 'workspace/list');
  const workspace = workspaces[0] ?? await rpc<{ id: string }>(page, 'workspace/create', { title: 'Domain audit', cwd: fixtureWorkspace });
  const before = await rpc<unknown[]>(page, 'thread/list', { workspaceId: workspace.id });
  await page.getByRole('button', { name: '添加内容或模式', exact: true }).click();
  await page.getByRole('button', { name: /^工作方案/ }).click();
  const dialog = page.getByRole('dialog', { name: '工作方案', exact: true });
  await expect(dialog.locator('.nw-domain-recipe-group .nw-recipe-row')).toHaveCount(6);
  await dialog.getByRole('textbox', { name: '搜索方案', exact: true }).fill('Video storyboard');
  await expect(dialog.locator('.nw-recipe-row')).toHaveCount(1);
  await dialog.getByRole('button', { name: '保存副本: 视频分镜', exact: true }).click();
  await dialog.getByRole('textbox', { name: '搜索方案', exact: true }).fill('视频分镜');
  await expect(dialog.locator('.nw-recipe-row')).toHaveCount(2);
  await dialog.getByRole('button', { name: '应用', exact: true }).first().click();
  for (const input of await dialog.locator('fieldset input').all()) await input.fill('验收资料与要求');
  await expect(dialog.getByRole('button', { name: /替换/ })).toBeEnabled();
  const bounds = await dialog.getByRole('button', { name: /替换/ }).boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(dialogBounds!.y + dialogBounds!.height);
  await page.screenshot({ path: '../.task/learning-creation-plans.png', fullPage: true });
  await dialog.getByRole('button', { name: /替换/ }).click();
  await expect(page.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue(/视频分镜/);
  const after = await rpc<unknown[]>(page, 'thread/list', { workspaceId: workspace.id });
  expect(after).toEqual(before);
});

test('an existing task can use a built-in plan without adding a goal or starting a turn', async ({ page }) => {
  const workspace = await rpc<{ id: string }>(page, 'workspace/create', { title: 'Existing task audit', cwd: fixtureWorkspace });
  const thread = await rpc<{ id: string }>(page, 'thread/start', { workspaceId: workspace.id, title: 'Draft only', cwd: fixtureWorkspace });
  const before = await rpc<Record<string, unknown>>(page, 'thread/read', { id: thread.id });
  await page.goto(`/workbench/task/${thread.id}`);
  await page.getByRole('button', { name: '添加内容或模式', exact: true }).click();
  await page.getByRole('button', { name: /^工作方案/ }).click();
  const dialog = page.getByRole('dialog', { name: '工作方案', exact: true });
  await dialog.getByRole('textbox', { name: '搜索方案', exact: true }).fill('创作简报');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  for (const input of await dialog.locator('fieldset input').all()) await input.fill('现有任务材料');
  await expect(dialog.getByText('本次只应用任务正文，当前任务的目标保持原样。', { exact: true })).toBeVisible();
  await expect(dialog.getByText('完成条件', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '替换草稿', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue(/创作简报/);
  expect(await rpc(page, 'thread/read', { id: thread.id })).toEqual(before);
});
