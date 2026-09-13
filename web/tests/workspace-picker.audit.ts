import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const fixtureWorkspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!fixtureWorkspace, "Requires an explicitly isolated native gateway fixture");
test.describe.configure({ timeout: 120_000 });
test.use({ locale: "zh-CN", contextOptions: { reducedMotion: "reduce" }, viewport: { width: 1440, height: 960 }, screenshot: "only-on-failure", trace: "retain-on-failure" });

type Workspace = { id: string; title: string; cwd: string };
type Style = "minimal" | "luminous";

test.beforeEach(async ({ page, baseURL }) => {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(fixtureWorkspace!.replaceAll("\\", "/")).toMatch(/\/(?:preview-home|isolated-home)\/workspace\/?$/);
  page.setDefaultTimeout(15_000);
});

async function ready(page: Page, style: Style) {
  await expect(page.locator(".nw-connection.is-connected")).toBeVisible();
  await expect(page.getByRole("button", { name: `当前界面：${style === "minimal" ? "简约，切换为澄光" : "澄光，切换为简约"}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择工作区", exact: true })).toBeVisible();
}

async function prepareWorkspaces(page: Page, style: Style = "minimal", theme = "snow") {
  const directory = path.join(fixtureWorkspace!, "workspace-picker-audit");
  const seeds = [
    { title: "选择器验收 Alpha", cwd: path.join(directory, "alpha-notes") },
    { title: "选择器验收 Beta", cwd: path.join(directory, "beta-design") },
    { title: "选择器验收 长名称：产品研究、资料整理与持续迭代的完整工作空间", cwd: path.join(directory, "long-path", "client-research-and-product-design", "reference-materials-and-approved-deliverables", "workspace-with-a-deliberately-long-directory-name") },
  ];
  for (const seed of seeds) await mkdir(seed.cwd, { recursive: true });
  await page.addInitScript(preference => {
    if (window !== window.top) return;
    localStorage.setItem("knorvia-language", "zh");
    if (!localStorage.getItem("knorvia-theme")) localStorage.setItem("knorvia-theme", preference.theme);
    if (!localStorage.getItem("knorvia-workbench-style-v1")) localStorage.setItem("knorvia-workbench-style-v1", JSON.stringify(preference.style));
  }, { style, theme });
  await page.goto("/workbench");
  await expect(page.locator(".nw-connection.is-connected")).toBeVisible();

  // Seed through the same real gateway as the app; no provider or bridge mocks.
  // Reuse fixed records and directories so repeated runs do not accumulate data.
  const workspaces = await page.evaluate(async entries => {
    const response = await fetch("/api/knorvia/native/session", { headers: { "x-knorvia-native-origin": location.origin }, cache: "no-store" });
    if (!response.ok) throw new Error(`Fixture session failed: ${response.status}`);
    const session = await response.json();
    const target = new URL(session.url || "/api/knorvia/native", location.href);
    target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
    const socket = new WebSocket(target.href, ["knorvia.native.v1", `knorvia.native.token.${session.token}`]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture socket timed out")), 15_000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Fixture socket failed")); }, { once: true });
      });
      let sequence = 0;
      const rpc = <T,>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
        const id = `workspace-picker-audit-${++sequence}`;
        const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", receive); socket.removeEventListener("close", closed); };
        const closed = () => { cleanup(); reject(new Error(`Fixture disconnected during ${method}`)); };
        const receive = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Fixture ${method} timed out`)); }, 15_000);
        socket.addEventListener("message", receive);
        socket.addEventListener("close", closed, { once: true });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
      const existing = await rpc<Workspace[]>("workspace/list");
      const normalize = (value: string) => value.replace(/^\\\\\?\\/, "").replaceAll("\\", "/").toLowerCase();
      const result: Workspace[] = [];
      for (const entry of entries) {
        const saved = existing.find(workspace => workspace.title === entry.title && normalize(workspace.cwd || "") === normalize(entry.cwd));
        result.push(saved ?? await rpc<Workspace>("workspace/create", { ...entry, idempotencyKey: `workspace-picker-audit-v1:${entry.cwd}` }));
      }
      return result;
    } finally { socket.close(); }
  }, seeds);
  // Reload authoritative workspace/list into the actual provider after seeding.
  await page.reload();
  await ready(page, style);
  return workspaces;
}

function picker(page: Page) {
  const trigger = page.getByRole("button", { name: "选择工作区", exact: true });
  const dialog = page.getByRole("dialog", { name: "选择工作区", exact: true });
  return { trigger, dialog, search: dialog.getByRole("combobox", { name: "搜索工作区", exact: true }) };
}

test("name and path search, arrow selection and reload preserve the draft", async ({ page }) => {
  const [alpha, beta] = await prepareWorkspaces(page);
  const draft = "工作区切换验收草稿；保持这段内容，尚不发送任务。";
  const composer = page.getByRole("textbox", { name: "任务描述", exact: true });
  await composer.fill(draft);
  const mountedComposer = (await composer.elementHandle())!;
  const { trigger, dialog, search } = picker(page);
  await trigger.click();
  await expect(search).toBeFocused();
  await search.fill(alpha.title);
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText(alpha.title);
  await search.fill("选择器验收");
  await expect(dialog.getByRole("option")).toHaveCount(3);
  await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
  const initial = await search.getAttribute("aria-activedescendant");
  await search.press("ArrowDown");
  await expect(search).not.toHaveAttribute("aria-activedescendant", initial!);
  await search.press("ArrowUp");
  await expect(search).toHaveAttribute("aria-activedescendant", initial!);
  await search.fill("beta-design");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText(beta.title);
  await search.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(trigger).toContainText(beta.title);
  await expect(trigger).toBeFocused();
  expect(await mountedComposer.evaluate(element => element.isConnected)).toBe(true);
  await mountedComposer.dispose();
  await expect(composer).toHaveValue(draft);
  await expect(page).toHaveURL(/\/workbench$/);
  await trigger.click();
  await expect(dialog.getByRole("option").filter({ hasText: beta.title })).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await page.reload();
  await ready(page, "minimal");
  await expect(trigger).toContainText(beta.title);
  await expect(composer).toHaveValue(draft);
});

test("Luminous dark supports pointer choice, Escape, outside click and the existing creation dialog", async ({ page }, info) => {
  const [alpha] = await prepareWorkspaces(page, "luminous", "dark");
  const composer = page.getByRole("textbox", { name: "任务描述", exact: true });
  const draft = "关闭工作区浮层和新建窗口后保留草稿。";
  await composer.fill(draft);
  const { trigger, dialog, search } = picker(page);
  await trigger.click();
  await search.fill(alpha.title);
  await dialog.getByRole("option").click();
  await expect(trigger).toContainText(alpha.title);
  await trigger.click();
  await expect(dialog.getByRole("option").filter({ hasText: alpha.title })).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator(".nw-breadcrumb").click();
  await expect(dialog).toBeHidden();
  await composer.click();
  await expect(composer).toBeFocused();
  await trigger.click();
  await search.fill("没有匹配的工作区-验收");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("luminous-dark-empty-search.png") });
  await dialog.getByRole("button", { name: "新建工作区", exact: true }).click();
  await expect(dialog).toBeHidden();
  const create = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(create).toBeVisible();
  await expect(create.getByRole("textbox", { name: "项目名称", exact: true })).toBeEditable();
  await create.getByRole("button", { name: "取消", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(composer).toHaveValue(draft);
  await expect(trigger).toContainText(alpha.title);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

for (const [style, theme] of [["minimal", "dark"], ["luminous", "snow"]] as const) {
  test(`${style} ${theme}: long workspace names and paths remain selectable at 360px`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const [, , longWorkspace] = await prepareWorkspaces(page, style, theme);
    const { trigger, dialog, search } = picker(page);
    await trigger.click();
    await search.fill("long-path");
    const option = dialog.getByRole("option");
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(longWorkspace.title);
    const pathText = option.getByText(longWorkspace.cwd, { exact: true });
    await expect(pathText).toBeVisible();
    const truncation = await pathText.evaluate(element => ({ overflow: element.scrollWidth > element.clientWidth, textOverflow: getComputedStyle(element).textOverflow }));
    expect(truncation).toEqual({ overflow: true, textOverflow: "ellipsis" });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(7);
    expect(bounds.y).toBeGreaterThanOrEqual(7);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(353);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(793);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${style}-${theme}-360-workspaces.png`) });
    await option.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toContainText(longWorkspace.title);
    expect(await trigger.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await trigger.click();
    await expect(dialog.getByRole("option").filter({ hasText: longWorkspace.title })).toHaveAttribute("aria-selected", "true");
    await search.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(/\/workbench$/);
  });
}
