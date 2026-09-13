import { expect, test, type Locator, type Page } from "@playwright/test";

const fixtureWorkspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!fixtureWorkspace, "Requires an explicitly isolated native gateway fixture");
test.describe.configure({ timeout: 120_000 });
test.use({ locale: "zh-CN", contextOptions: { reducedMotion: "reduce" }, viewport: { width: 1440, height: 960 }, screenshot: "only-on-failure", trace: "retain-on-failure" });

type Style = "minimal" | "luminous";
const styleName = { minimal: "简约", luminous: "澄光" };

test.beforeEach(async ({ page, baseURL }) => {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    if (!localStorage.getItem("knorvia-language")) localStorage.setItem("knorvia-language", "zh");
    if (!localStorage.getItem("knorvia-theme")) localStorage.setItem("knorvia-theme", "snow");
  });
});

async function ready(page: Page, style: Style) {
  await expect(page.locator(".nw-connection.is-connected")).toBeVisible();
  // The provider starts in English; waiting for this name also waits for hydration.
  await expect(page.getByRole("button", { name: new RegExp(`^当前界面：${styleName[style]}，切换为`) })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-workbench-style", style);
}

async function openWorkbench(page: Page, style: Style = "minimal") {
  await page.addInitScript(initialStyle => {
    if (!localStorage.getItem("knorvia-workbench-style-v1")) localStorage.setItem("knorvia-workbench-style-v1", JSON.stringify(initialStyle));
  }, style);
  await page.goto("/workbench");
  await ready(page, style);
}

async function assertUnderline(active: Locator, inactive: Locator) {
  await expect(active).toHaveAttribute("aria-current", "page");
  await expect(inactive).not.toHaveAttribute("aria-current", "page");
  const line = await active.evaluate(element => {
    const style = getComputedStyle(element, "::after");
    return { content: style.content, height: parseFloat(style.height), width: parseFloat(style.width), bottom: parseFloat(style.bottom), linkWidth: element.getBoundingClientRect().width };
  });
  expect(line.content).not.toBe("none");
  expect(line.height).toBeGreaterThan(0);
  expect(line.height).toBeLessThanOrEqual(4);
  expect(line.width).toBeGreaterThanOrEqual(line.linkWidth * .8);
  expect(Math.abs(line.bottom)).toBeLessThanOrEqual(2);
  expect(await inactive.evaluate(element => getComputedStyle(element, "::after").content)).toBe("none");
}

async function assertSidebarOrder(page: Page, sessions = true) {
  const sidebar = page.locator("aside.nw-sidebar");
  const tabs = sidebar.getByRole("navigation", { name: "侧栏模式", exact: true });
  const brand = sidebar.locator(".nw-brand");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveAttribute("aria-hidden", "false");
  const firstVisibleIsTabs = await sidebar.evaluate(element => {
    const first = [...element.children].find(child => {
      const rect = child.getBoundingClientRect(), style = getComputedStyle(child);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return first?.classList.contains("nw-sidebar-tabs");
  });
  expect(firstVisibleIsTabs, "The mode switch is the first visible sidebar content").toBe(true);
  const [sideBox, tabsBox, brandBox] = await Promise.all([sidebar.boundingBox(), tabs.boundingBox(), brand.boundingBox()]);
  expect(tabsBox!.y - sideBox!.y, "Tabs sit at the top of the sidebar").toBeLessThanOrEqual(24);
  expect(tabsBox!.y + tabsBox!.height, "The complete tab row is above the brand").toBeLessThanOrEqual(brandBox!.y + 1);

  if (sessions) {
    const newConversation = sidebar.getByRole("link", { name: "新对话", exact: true });
    await expect(newConversation).toBeVisible();
    const newBox = (await newConversation.boundingBox())!;
    expect(brandBox!.y + brandBox!.height).toBeLessThanOrEqual(newBox.y + 1);
    await expect(sidebar.getByRole("link", { name: "资料库", exact: true })).toHaveCount(1);
    await expect(sidebar.getByRole("link", { name: /^(成果|Outputs)$/ })).toHaveCount(0);
    await expect(sidebar.locator('a[href="/workbench/artifacts"]')).toHaveCount(0);
  }

  const footer = sidebar.locator(".nw-settings-footer");
  await expect(footer.getByRole("link")).toHaveText(["记忆", "设置"]);
  const memory = (await footer.getByRole("link", { name: "记忆", exact: true }).boundingBox())!;
  const settings = (await footer.getByRole("link", { name: "设置", exact: true }).boundingBox())!;
  expect(settings.y - memory.y - memory.height, "Memory sits directly above Settings").toBeGreaterThanOrEqual(-1);
  expect(settings.y - memory.y - memory.height).toBeLessThanOrEqual(4);
  expect(Math.abs(memory.x - settings.x)).toBeLessThanOrEqual(1);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const failures: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) failures.push(`document: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    if (document.body.scrollWidth > innerWidth + 1) failures.push(`body: ${document.body.scrollWidth} > ${innerWidth}`);
    for (const element of document.querySelectorAll<HTMLElement>(".nw-root, .nw-main, .nw-view, .nw-topbar, .nw-settings-main, .nw-settings-content")) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && element.scrollWidth > element.clientWidth + 1) failures.push(`${element.className}: ${element.scrollWidth} > ${element.clientWidth}`);
    }
    return failures;
  });
  expect(overflow, "The viewport and visible content containers fit without horizontal overflow").toEqual([]);
}

for (const style of ["minimal", "luminous"] as const) {
  test(`${style}: top mode tabs, adjacent footer links and one unified library`, async ({ page }, info) => {
    await openWorkbench(page, style);
    await assertSidebarOrder(page);
    const tabs = page.getByRole("navigation", { name: "侧栏模式", exact: true });
    const sessions = tabs.getByRole("link", { name: "会话", exact: true });
    const bots = tabs.getByRole("link", { name: "BOTS", exact: true });
    await assertUnderline(sessions, bots);
    await page.screenshot({ path: info.outputPath(`${style}-sidebar.png`) });

    await bots.click();
    await expect(page).toHaveURL(/\/workbench\/bots$/);
    await expect(page.getByRole("textbox", { name: "搜索 Bots", exact: true })).toBeVisible();
    await assertSidebarOrder(page, false);
    await assertUnderline(bots, sessions);
    await sessions.click();
    await expect(page).toHaveURL(/\/workbench$/);
    await assertUnderline(sessions, bots);
    await assertSidebarOrder(page);

    await page.locator(".nw-sidebar").getByRole("link", { name: "资料库", exact: true }).click();
    await expect(page.locator(".nw-breadcrumb")).toHaveText("资料库");
    const collections = page.getByRole("navigation", { name: "资料库内容", exact: true });
    const files = collections.getByRole("link", { name: "我的资料", exact: true });
    const outputs = collections.getByRole("link", { name: "任务生成", exact: true });
    await expect(files).toHaveAttribute("aria-current", "page");
    await outputs.click();
    await expect(page).toHaveURL(/\/workbench\/library\?view=outputs$/);
    await expect(outputs).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".nw-breadcrumb")).toHaveText("资料库");
    await files.click();
    await expect(files).toHaveAttribute("aria-current", "page");
    await assertSidebarOrder(page);
    await noHorizontalOverflow(page);
  });
}

test("style switches retain the composer, saved draft, route and independent palette", async ({ page }) => {
  await openWorkbench(page);
  const draft = "保留这份界面草稿：切换风格、刷新和往返外观设置后继续。";
  const composer = page.getByRole("textbox", { name: "任务描述", exact: true });
  await composer.fill(draft);
  const mountedComposer = (await composer.elementHandle())!;
  await page.getByRole("button", { name: "当前界面：简约，切换为澄光", exact: true }).click();
  await ready(page, "luminous");
  await expect(page).toHaveURL(/\/workbench$/);
  expect(await mountedComposer.evaluate(element => element.isConnected), "Style changes preserve the mounted composer").toBe(true);
  await mountedComposer.dispose();
  await expect(composer).toHaveValue(draft);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "snow");
  await page.reload();
  await ready(page, "luminous");
  await expect(composer).toHaveValue(draft);

  await page.locator(".nw-settings-footer").getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分类", exact: true }).getByRole("link", { name: "外观", exact: true }).click();
  await expect(page.locator(".nw-settings-content h1")).toHaveText("外观");
  const luminous = page.locator(".nw-workbench-style-choice").filter({ has: page.getByText("澄光", { exact: true }) });
  const minimal = page.locator(".nw-workbench-style-choice").filter({ has: page.getByText("简约", { exact: true }) });
  await expect(luminous).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(luminous).toHaveAttribute("aria-pressed", "true");
  await minimal.click();
  await expect(minimal).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-workbench-style", "minimal");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "返回应用", exact: true }).filter({ visible: true }).click();
  await ready(page, "minimal");
  await expect(page).toHaveURL(/\/workbench$/);
  await expect(composer).toHaveValue(draft);
  await page.getByRole("button", { name: "当前界面：简约，切换为澄光", exact: true }).click();
  await ready(page, "luminous");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await ready(page, "luminous");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(composer).toHaveValue(draft);
});

for (const style of ["minimal", "luminous"] as const) {
  test(`${style}: 360px home, sidebar, unified library and appearance stay within the viewport`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openWorkbench(page, style);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`${style}-360-home.png`) });
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await assertSidebarOrder(page);
    await noHorizontalOverflow(page);
    await page.locator(".nw-sidebar").getByRole("link", { name: "资料库", exact: true }).click();
    await expect(page.locator(".nw-breadcrumb")).toHaveText("资料库");
    await expect(page.locator(".nw-sidebar")).toHaveAttribute("aria-hidden", "true");
    await noHorizontalOverflow(page);
    await page.getByRole("navigation", { name: "资料库内容", exact: true }).getByRole("link", { name: "任务生成", exact: true }).click();
    await expect(page).toHaveURL(/\?view=outputs$/);
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator(".nw-settings-footer").getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "展开设置导航", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类", exact: true }).getByRole("link", { name: "外观", exact: true }).click();
    await expect(page.locator(".nw-settings-content h1")).toHaveText("外观");
    await expect(page.locator('.nw-workbench-style-choice[aria-pressed="true"]')).toContainText(styleName[style]);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`${style}-360-appearance.png`) });
  });
}
