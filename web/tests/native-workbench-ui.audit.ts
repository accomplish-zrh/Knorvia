import { toggleWorkbenchTheme } from './helpers/native-appearance';
import { expect, test } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";

// Run against start-native-gateway-fixture.js with an explicit isolated workspace.
// The normal UI audit suite never creates tasks in a user's configured Home.
const fixtureWorkspace = process.env.KNORVIA_UI_FIXTURE_WORKSPACE;
test.skip(!fixtureWorkspace, "Requires the isolated native gateway fixture");
test.use({ locale: "zh-CN", screenshot: "only-on-failure", trace: "retain-on-failure" });

test("native workbench: drafts, keyboard search, real task controls and goal lifecycle", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(10_000);
  const runId = Date.now();
  const projectName = `UI 回归 ${runId}`;
  const taskTitle = `界面验收：整理项目资料 ${runId}`;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL!).hostname);
  expect(fixtureWorkspace!.replaceAll("\\", "/")).toContain("/isolated-home/workspace");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("knorvia-language", "zh"));
  const home = async () => {
    await page.goto("/workbench");
    await expect(page.locator(".nw-home h1")).toBeVisible();
    await expect(page.locator(".nw-connection")).toHaveClass(/is-connected/);
  };
  const completed = () => expect(page.locator('.nw-task-heading .nw-status-label[data-status="completed"]')).toBeVisible({ timeout: 30_000 });
  const send = async (input: string) => {
    await home();
    await page.getByRole("textbox", { name: "任务描述", exact: true }).fill(input);
    await page.getByRole("button", { name: "发送任务", exact: true }).click();
    await expect(page.locator(".nw-task-heading h1")).toHaveText(input);
  };
  const screenshot = async (name: string) => {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  };
  const noOverflow = async () => {
    expect(await page.evaluate(() => {
      const main = document.querySelector(".nw-main")!;
      const view = document.querySelector(".nw-view")!;
      return document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1 && main.scrollWidth <= main.clientWidth + 1 && view.scrollWidth <= view.clientWidth + 1;
    })).toBe(true);
  };

  await test.step("suggestions and Chinese composition preserve the draft", async () => {
    await home();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill(projectName);
    await page.getByLabel("本地文件夹（可选）").first().fill(fixtureWorkspace!);
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /整理资料/ }).click();
    const draft = await page.getByRole("textbox", { name: "任务描述", exact: true }).inputValue();
    await page.reload();
    const field = page.getByRole("textbox", { name: "任务描述", exact: true });
    await expect(field).toHaveValue(draft);
    await field.fill("中文输入验收");
    await field.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(field).toHaveValue("中文输入验收");
    await field.press("Shift+Enter");
    await expect(field).toHaveValue("中文输入验收\n");
    await field.fill(Array(12).fill("多行资料草稿").join("\n"));
    expect(await field.evaluate(element => element.clientHeight)).toBeGreaterThan(150);
    await field.fill("");
    expect(await field.evaluate(element => element.clientHeight)).toBeLessThan(150);
    await noOverflow();
    await screenshot("home-light");
  });

  await test.step("real completion, archive recovery and keyboard search", async () => {
    await send(taskTitle);
    await completed();
    const taskURL = page.url();
    await page.getByRole("button", { name: "任务操作", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#nw-task-actions")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "任务操作", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "任务操作", exact: true }).click();
    await page.getByRole("button", { name: "归档任务", exact: true }).click();
    await expect(page.locator(".nw-archived-notice")).toBeVisible();
    await expect(page.locator(".nw-task-composer textarea")).toHaveCount(0);
    await page.getByRole("button", { name: "恢复任务", exact: true }).click();
    await expect(page.locator(".nw-task-composer textarea")).toBeVisible();
    await screenshot("task-completed");
    await expect(page.locator(".nw-topbar .nw-task-heading h1")).toHaveText(taskTitle);
    await expect(page.locator(".nw-task-view .nw-task-toolbar")).toHaveCount(0);
    await page.getByRole("button", { name: "保存为成果", exact: true }).click();
    await expect(page.locator(".nw-toast")).toContainText("成果");
    await page.getByRole("button", { name: "资料与成果", exact: true }).click();
    const resources = page.getByRole("complementary", { name: "资料与成果", exact: true });
    await expect(resources.getByRole("button", { name: taskTitle, exact: true })).toBeVisible();
    await noOverflow();
    await screenshot("conversation-resources");
    await resources.getByRole("button", { name: taskTitle, exact: true }).click();
    await expect(page.locator(".nw-panel-artifact .nw-markdown")).toContainText("scripted native fixture response");
    await page.getByRole("button", { name: "关闭工作面板", exact: true }).click();
    await page.getByRole("button", { name: "资料与成果", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("resources-narrow");
    await resources.getByRole("button", { name: "关闭资料与成果", exact: true }).click();
    await expect(resources).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await home();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "按任务或项目名称搜索" });
    await search.fill(`  ${taskTitle}  `);
    await expect(page.getByRole("listbox", { name: "搜索结果" }).getByRole("option")).toHaveCount(1);
    await search.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "搜索结果" }).getByRole("option")).toHaveAttribute("aria-selected", "true");
    await screenshot("search-keyboard");
    await search.press("Enter");
    await expect(page).toHaveURL(taskURL);
    await expect(page.locator("dialog")).toHaveCount(0);
  });

  await test.step("approval and input cards submit to the real Kernel", async () => {
    await send("[approval] 界面验收：仅写入隔离测试文件");
    await expect(page.locator(".nw-approval")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.nw-task-heading .nw-status-label[data-status="approval"]')).toBeVisible();
    await expect(page.locator(".nw-decision-prompt")).toBeVisible();
    await expect(page.locator(".nw-task-composer textarea")).toHaveCount(0);
    await page.getByRole("button", { name: "补充任务要求", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "补充任务要求", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "收起输入，查看待处理事项", exact: true }).click();
    await screenshot("task-approval");
    await page.getByRole("button", { name: "允许这次操作", exact: true }).click();
    await completed();
    expect(await fs.readFile(path.join(fixtureWorkspace!, "knorvia-fixture-approved.txt"), "utf8")).toContain("approved by Knorvia fixture");
    await page.getByRole("button", { name: "资料与成果", exact: true }).click();
    await page.locator(".nw-resources-pane").getByRole("button", { name: "knorvia-fixture-approved.txt", exact: true }).click();
    await expect(page.getByLabel("文件内容", { exact: true })).toContainText("approved by Knorvia fixture");
    await page.getByRole("button", { name: "关闭工作面板", exact: true }).click();
    await send("[user-input] 界面验收：等待选择模式");
    await expect(page.locator(".nw-question-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".nw-decision-prompt")).toBeVisible();
    await expect(page.getByRole("button", { name: "提交回答", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: /Safe \(Recommended\)/ }).check();
    await screenshot("task-input");
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await completed();
  });

  await test.step("goal mode starts from the composer and continues in the same conversation", async () => {
    await home();
    await expect(page.locator(".nw-nav").getByRole("link", { name: "长期目标", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "添加内容或模式", exact: true }).click();
    await page.getByRole("button", { name: "目标", exact: true }).click();
    await expect(page.locator(".nw-goal-mode-label")).toContainText("目标模式");
    await page.getByRole("textbox", { name: "任务描述", exact: true }).fill("在对话中推进验收目标");
    await expect(page.getByRole("button", { name: "发送任务", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "完成条件", exact: true }).fill("收到本地脚本回复，且对话可以继续。");
    await screenshot("goal-mode-composer");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "完成条件", exact: true })).toHaveValue("收到本地脚本回复，且对话可以继续。");
    await page.getByRole("button", { name: "发送任务", exact: true }).click();
    await completed();
    await expect(page.getByRole("region", { name: "对话目标", exact: true })).toContainText("在对话中推进验收目标");
    const goalURL = page.url();
    await page.getByRole("button", { name: "暂停目标", exact: true }).click();
    await expect(page.locator(".nw-goal-composer-state")).toContainText("目标已暂停");
    await expect(page.locator(".nw-task-composer textarea")).toHaveCount(0);
    await page.getByRole("button", { name: "继续目标", exact: true }).click();
    await page.getByRole("textbox", { name: "任务描述", exact: true }).fill("继续当前目标，再给出一次简短回应。");
    await page.getByRole("button", { name: "发送任务", exact: true }).click();
    await expect(page.locator(".nw-user-message")).toHaveCount(2);
    await expect(page.locator(".nw-agent-message")).toHaveCount(2);
    await completed();
    await expect(page).toHaveURL(goalURL);
    await noOverflow();
    await expect(page.locator(".nw-user-message > p").last()).toHaveText("继续当前目标，再给出一次简短回应。");
    await page.locator(".nw-message-goal-context summary").last().click();
    await expect(page.locator(".nw-message-goal-context pre").last()).toContainText("Acceptance criteria:");
    await page.locator(".nw-message-goal-context summary").last().click();
    await screenshot("goal-in-conversation");
    await page.getByRole("button", { name: "保存为成果", exact: true }).last().click();
    await expect(page.locator(".nw-toast")).toContainText("成果");
    await page.getByRole("button", { name: "资料与成果", exact: true }).click();
    await expect(page.locator(".nw-resources-pane .nw-resource-row").first()).toBeVisible();
    await screenshot("goal-conversation-resources");
    await page.getByRole("button", { name: "关闭资料与成果", exact: true }).click();
    await toggleWorkbenchTheme(page);
    await screenshot("goal-conversation-dark");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow();
      await expect(page.getByRole("textbox", { name: "任务描述", exact: true })).toBeVisible();
      await screenshot(`goal-conversation-narrow-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await toggleWorkbenchTheme(page);
  });

  await test.step("goal actions, acceptance and terminal history", async () => {
    await page.goto("/workbench/goals");
    await page.getByRole("button", { name: "新建目标", exact: true }).click();
    await page.getByRole("textbox", { name: "目标", exact: true }).fill("UI 回归目标");
    await page.getByRole("textbox", { name: "怎样算完成", exact: true }).fill("本地脚本响应出现在已完成任务中。");
    await page.getByRole("textbox", { name: "下一动作（可选）", exact: true }).fill("返回本地脚本响应，供界面回归验收。");
    await page.getByRole("button", { name: "创建目标", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    const card = page.getByRole("article", { name: "UI 回归目标", exact: true });
    await card.getByRole("button", { name: "相关任务", exact: true }).click();
    await expect(card.locator(".nw-goal-task-links")).toContainText("还没有相关任务");
    await card.getByRole("button", { name: "暂停: UI 回归目标", exact: true }).click();
    await expect(card).toHaveAttribute("data-status", "paused");
    await expect(card.getByRole("button", { name: "执行下一步", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "继续推进", exact: true }).click();
    await expect(card).toHaveAttribute("data-status", "active");
    await card.getByRole("button", { name: "记录检查点: UI 回归目标", exact: true }).click();
    await expect(card.locator(".nw-goal-checkpoint")).toContainText("检查点 ·");
    await card.getByRole("button", { name: "执行下一步", exact: true }).click();
    await completed();
    await page.goto("/workbench/goals");
    await card.getByRole("button", { name: "核对结果", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "输出预览" })).toHaveValue("scripted native fixture response");
    await expect(page.getByRole("button", { name: "记录验收", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "验收说明", exact: true }).fill("已核对：本地脚本响应存在，任务已完成。仅用于隔离界面回归。");
    await page.getByRole("button", { name: "记录验收", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await screenshot("goal-acceptance");
    await card.getByRole("button", { name: "标记完成", exact: true }).click();
    await page.getByRole("button", { name: /^已结束/ }).click();
    await expect(card).toHaveAttribute("data-status", "completed");
    await expect(card.getByRole("button", { name: "执行下一步", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "编辑: UI 回归目标", exact: true })).toHaveCount(0);
  });

  await test.step("dark, narrow, search empty state and task categories", async () => {
    await toggleWorkbenchTheme(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await screenshot("goals-dark");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow();
      await screenshot(`goals-narrow-${width}`);
    }
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.getByRole("button", { name: "搜索任务", exact: true }).click();
    const search = page.getByRole("combobox", { name: "按任务或项目名称搜索" });
    await search.fill("没有这个回归任务-000xyz");
    await expect(page.locator(".nw-search-empty")).toContainText("没有找到相关任务");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.goto("/workbench/history");
    await page.getByRole("textbox", { name: "查找任务或项目", exact: true }).fill(projectName);
    await page.getByRole("button", { name: /^需要处理/ }).click();
    await expect(page.locator(".nw-empty-panel")).toContainText("没有匹配的任务");
    await noOverflow();
    await screenshot("history-empty-narrow");
    await page.getByRole("button", { name: "查看全部任务", exact: true }).click();
    await expect(page.locator(".nw-task-row").first()).toBeVisible();
    await screenshot("history-narrow");
  });
  expect(errors).toEqual([]);
});
