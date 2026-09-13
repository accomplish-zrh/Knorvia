/**
 * Built-in learning and creation work plans.
 *
 * These presets are produced per language at render time, never persisted, and
 * never counted against the custom recipe limit. Their text only asks the
 * current Kernel task to schedule already-discovered capabilities
 * (`learning_practice`, `creative_brief`) and to report honestly when a
 * capability or a source is missing. Applying one still goes through the
 * ordinary recipe draft flow, so nothing here can execute a task or change
 * project, model, or permission state.
 */

import type { TaskRecipe } from "./native-task-recipes";

export type DomainT = (zh: string, en: string) => string;
export type DomainRecipeGroup = "learning" | "creation";

export type RecipeSections = { learning: TaskRecipe[]; creation: TaskRecipe[]; mine: TaskRecipe[] };

const ZH_ONLY: DomainT = zh => zh;
const EN_ONLY: DomainT = (_, en) => en;

type Definition = {
  id: string;
  group: DomainRecipeGroup;
  build: (t: DomainT) => TaskRecipe;
};

const define = (
  id: string,
  group: DomainRecipeGroup,
  build: (t: DomainT) => Omit<TaskRecipe, "id" | "createdAt" | "updatedAt">,
): Definition => ({
  id,
  group,
  build: t => ({ id, createdAt: 0, updatedAt: 0, ...build(t) }),
});

const DEFINITIONS: Definition[] = [
  define("builtin-material-study-guide", "learning", t => ({
    name: t("资料导学", "Guided study of material"),
    description: t("把资料变成导学提纲和一份可作答的自测题", "Turn material into a study outline plus a self-test"),
    textTemplate: t(
      `带我学完这批资料：{{material}}。本次重点：{{focus}}。

1. 先通读资料，列出它的结构和这次需要先掌握的概念。
2. 出 {{questions}} 道自测题，只出题、先不给答案，让我自己作答。
3. 把提纲和题库分别保存到资料库，每条知识点和题目都引用固定版本的原文。题库包含判分依据，但练习时先只展示题目。

练习记录请用 learning_practice 保存。如果当前任务里找不到这个能力，或资料读不到，请直接说明缺什么，不要假装已经记录或已经保存。`,
      `Walk me through this material: {{material}}. Focus for this session: {{focus}}.

1. Read it first and list its structure plus the concepts I need up front.
2. Write {{questions}} self-test questions - questions only, no answers yet, so I attempt them myself.
3. Save the outline and quiz separately in the library, with each concept and question linked to the pinned source. Store grading evidence in the quiz but show only questions before an attempt.

Store the practice record with learning_practice. If that capability is not available in this task, or the material cannot be read, say exactly what is missing instead of claiming it was recorded or saved.`,
    ),
    goal: {
      criteria: t(
        `当前资料库里存在一个导学文件，包含 {{focus}} 的结构化提纲、{{questions}} 道自测题，以及每条知识点对应的资料位置；资料里没有依据的内容被列为缺口。`,
        `A study file exists in the library with a structured outline for {{focus}}, {{questions}} self-test questions, and the source location for every point; anything the material does not support is listed as a gap.`,
      ),
      constraints: t(
        `只使用我指定的 {{material}}，不改动原始资料；不要替我作答，也不要因为我没做完就反复等待或挂起任务——本任务只交付可用的学习材料，掌握程度以后再看。`,
        `Use only the {{material}} I named and leave the originals untouched. Do not answer for me, and do not wait or stall because I have not finished - deliver this session's study material; mastery is judged later.`,
      ),
    },
  })),

  define("builtin-mistake-review", "learning", t => ({
    name: t("错题与到期复习", "Mistakes and due review"),
    description: t("挑出做错过和到期的题，排成一次复习", "Pull wrong and due items into one review sitting"),
    textTemplate: t(
      `请用 learning_practice 读取我的练习记录，把 {{due_window}} 内到期的题目和最近的错题排成一份本次复习卷，共 {{count}} 题左右。

1. 每题写清入选原因（答错、跳答还是到期）以及当时的出处。
2. 只出题目和思路提示，我作答之前不要给答案或反馈。
3. 复习卷保存为当前资料库里的一个文件。

读不到记录或没有 learning_practice 时，直接说明缺失，不要编造我的错题。`,
      `Read my practice record with learning_practice and build a review sheet of about {{count}} items: those due within {{due_window}} plus my recent mistakes.

1. For each item state why it is here (answered wrong, skipped, or due) and where it came from.
2. Questions and hints only - no answers or feedback until I have attempted them.
3. Save the review sheet as a file in the library.

If the record cannot be read or learning_practice is unavailable, say so plainly; never invent mistakes.`,
    ),
    goal: {
      criteria: t(
        `当前资料库里存在一份复习文件，约 {{count}} 题，每题有入选原因和出处；我尚未作答的题目没有被写入"反馈"；读不到的记录被明确标为未知。`,
        `A review file exists in the library with about {{count}} items, each with its reason and source; no feedback is written for items I have not attempted yet, and unreadable history is marked as unknown.`,
      ),
      constraints: t(
        `不要替我作答，也不要把任务挂在"等我全部做完并掌握"上；本轮只交付复习材料，并按现有能力保存我的作答，学习进度之后凭记录判断。`,
        `Do not answer for me and do not hold the task open until I master everything; this round only delivers the review material and saves my attempts with the available capability - progress is judged later from the record.`,
      ),
    },
  })),

  define("builtin-teach-back", "learning", t => ({
    name: t("教回练习", "Teach-back practice"),
    description: t("我先讲一遍，再对照资料找漏洞", "I explain it first, then gaps are checked against the material"),
    textTemplate: t(
      `我要用教回法复习 {{topic}}，依据资料：{{material}}。

1. 先只给我 {{questions}} 个检查性问题，让我自己讲；我作答之前不要给答案、评分或纠正。
2. 我作答之后，逐条对照 {{material}} 说明我说对了什么、漏了什么、哪里说错，并给出位置。
3. 把我的原话和你的反馈分开写进一个文件，保存到当前项目。

请用 learning_practice 保存我的作答与反馈；能力不可用就直接说明，不要声称已保存，也不要替我填答案。`,
      `I am doing a teach-back on {{topic}} using this material: {{material}}.

1. Start with only {{questions}} checking questions and let me explain; give no answers, scores, or corrections before I respond.
2. After I answer, compare my words with {{material}} point by point: what was right, what was missing, what was wrong, with locations.
3. Save my original wording and your feedback as separate sections in a file in the library.

Store my attempt and the feedback with learning_practice. If that capability is unavailable, say so - do not claim it was saved and do not write answers for me.`,
    ),
    goal: {
      criteria: t(
        `当前资料库里存在一份教回记录文件：{{questions}} 个检查问题、我的原话（我没作答的部分保持空白）、以及逐条对照 {{material}} 的反馈与出处。`,
        `A teach-back file exists in the library: {{questions}} checking questions, my own words (blank where I have not answered), and feedback checked against {{material}} with sources.`,
      ),
      constraints: t(
        `先让我尝试，再给反馈；不要改动原始资料；不要下"已掌握"的结论，本任务只交付本次记录。`,
        `Let me attempt it before any feedback; do not modify the source material; do not declare the topic mastered - this task delivers this session's record only.`,
      ),
    },
  })),

  define("builtin-creative-brief", "creation", t => ({
    name: t("创作简报", "Creative brief"),
    description: t("先定受众、依据与验收标准，再产出作品", "Fix audience, evidence and acceptance first, then produce the piece"),
    textTemplate: t(
      `请用 creative_brief 建立一份版本化创作简报：主题 {{topic}}，受众 {{audience}}，本次要达到 {{outcome}}，成果形式是 {{deliverable}}。

1. 简报写清资料来源清单（具体文件与位置）、核心信息、语气、篇幅或时长、必须包含与禁止的内容。
2. 按简报在当前项目中产出真实的作品文件（{{deliverable}}），关键判断标出依据。
3. 完成后走 creative_brief 的评审步骤，对照简报逐条记录通过、不通过和证据不足的地方。

只有文件确实存在才可称为已保存。creative_brief 不可用时说明缺失，只交计划，不要伪造简报或评审结论。`,
      `Use creative_brief to create a versioned brief: topic {{topic}}, audience {{audience}}, this round must achieve {{outcome}}, deliverable is {{deliverable}}.

1. The brief lists its sources (concrete files and locations), the core message, tone, length or duration, and what must and must not appear.
2. Produce the real deliverable file ({{deliverable}}) in the library from that brief, marking the evidence behind key choices.
3. Then run the creative_brief review and record, criterion by criterion: passed, failed, or not enough evidence.

Call something saved only if the file actually exists. If creative_brief is unavailable, report the gap and deliver the plan alone - never fake a brief or a review.`,
    ),
    goal: {
      criteria: t(
        `工作区中同时存在简报文件和 {{deliverable}} 作品文件；简报记录版本与来源清单；评审结论逐条指向作品里的实际位置；没有保存成功的产物没有被说成已完成。`,
        `Both the brief file and the {{deliverable}} deliverable exist in the workspace; the brief records its version and source list; every review verdict points at a real location in the deliverable; nothing that failed to save is described as finished.`,
      ),
      constraints: t(
        `只使用来源可以确认的资料；不要改动我未提及的文件；达不到标准时保留现状并说明差距，不要用空话凑篇幅。`,
        `Use only sources that can be verified; do not touch files I did not mention; when the bar is not met, keep what exists and state the gap instead of padding it.`,
      ),
    },
  })),

  define("builtin-material-to-article", "creation", t => ({
    name: t("资料转文章", "Material into article"),
    description: t("把原始资料重写成读者能看懂的文章", "Rewrite raw material into an article readers can follow"),
    textTemplate: t(
      `把 {{material}} 改写成一篇给 {{audience}} 看的文章，约 {{length}}。

1. 先列可复用的要点清单，每条注明在原资料里的位置；没有出处的判断不要写成事实。
2. 成稿包含标题、开头、小标题和结尾，面向 {{audience}} 表达，减少资料内部术语。
3. 文章保存为当前资料库里的文件，文末附"要点 - 原资料位置"对照表。

需要评审时走 creative_brief；该能力不可用就直接说明，不要声称已保存或已评审。`,
      `Rewrite {{material}} into an article of about {{length}} for {{audience}}.

1. First list the reusable points, each with its location in the source; a claim without a source must not be written as fact.
2. Draft a title, opening, subheadings and a closing, in language for {{audience}} with less internal jargon.
3. Save the article as a file in the library, ending with a point-to-source table.

Use creative_brief for the review pass; if it is unavailable, say so rather than claiming the article was saved or reviewed.`,
    ),
    goal: {
      criteria: t(
        `资料库里存在文章文件与要点-来源对照表；篇幅在 {{length}} 的上下两成以内；每个事实性论断都能在 {{material}} 中指出位置，对不上的内容已删除或标明为推测。`,
        `The article file and its point-to-source table exist in the library; the length is within twenty percent of {{length}}; every factual claim can be located in {{material}}, and anything that cannot be matched was cut or labelled as speculation.`,
      ),
      constraints: t(
        `不虚构数据、引用或亲身经历；不大段复制原文；不修改 {{material}} 本体。`,
        `No invented data, quotations or personal anecdotes; no long verbatim copying; leave {{material}} itself unchanged.`,
      ),
    },
  })),

  define("builtin-video-storyboard", "creation", t => ({
    name: t("视频分镜", "Video storyboard"),
    description: t("按素材排出逐镜头脚本，标明时长与依据", "Lay out a shot-by-shot script with timing and evidence"),
    textTemplate: t(
      `根据 {{material}} 做一段 {{duration}} 的视频分镜，画面风格：{{style}}。

1. 逐镜头表格：镜号、时间码、画面、口播或字幕、所需素材、这一句依据的资料位置。
2. 素材缺失或需要我确认的地方标成"待补"，不要虚构素材或引用。
3. 分镜表保存为当前资料库里的文件，开头写明总时长与镜头数。

需要版本化评审时走 creative_brief；能力不可用就直接说明。本任务只做分镜脚本，不做渲染。`,
      `Build a {{duration}} video storyboard from {{material}} in a {{style}} visual style.

1. A shot table: shot number, timecode, picture, voiceover or caption, required assets, and the source location behind each line.
2. Mark missing assets or decisions I must confirm as "to be supplied" - never invent footage or quotations.
3. Save the storyboard as a file in the library, stating total duration and shot count at the top.

Use creative_brief for a versioned review, and report plainly if it is unavailable. This task is the script only, not a render.`,
    ),
    goal: {
      criteria: t(
        `分镜文件存在于当前资料库里，时间码连续且总时长接近 {{duration}}；每个镜头都有画面、口播和资料依据；"待补"项被单独列出。`,
        `The storyboard file exists in the library with continuous timecodes totalling about {{duration}}; every shot has picture, voiceover and a source; every "to be supplied" item is listed on its own.`,
      ),
      constraints: t(
        `事实只取自 {{material}}；不要虚构镜头素材或引用；除非我在任务里另外要求，不要生成或渲染视频文件。`,
        `Take facts from {{material}} only; do not invent shots or citations; do not generate or render video unless I ask for it in this task.`,
      ),
    },
  })),
];

/** The six presets, localised through the workbench translator. */
export function builtinTaskRecipes(t: DomainT): TaskRecipe[] {
  return DEFINITIONS.map(entry => entry.build(t));
}

export function builtinRecipeGroup(recipe: Pick<TaskRecipe, "id">): DomainRecipeGroup | null {
  return DEFINITIONS.find(entry => entry.id === recipe.id)?.group ?? null;
}

/** Menu list: built-in learning, built-in creation, then the user's own plans. */
export function recipeSections(t: DomainT, customRecipes: TaskRecipe[], search: string): RecipeSections {
  const needle = search.trim().toLowerCase();
  const haystack = (recipe: TaskRecipe) => `${recipe.name} ${recipe.description} ${recipe.textTemplate}`.toLowerCase();
  const matches = (recipe: TaskRecipe, aliases: TaskRecipe[]) =>
    !needle || [recipe, ...aliases].some(item => haystack(item).includes(needle));
  const built = DEFINITIONS.map(entry => ({ entry, recipe: entry.build(t) }));
  // A preset is findable in the other language too, so a Chinese UI still
  // answers an English keyword the user remembers.
  const inGroup = (group: DomainRecipeGroup) => built.filter(item => item.entry.group === group && matches(item.recipe, needle ? [item.entry.build(ZH_ONLY), item.entry.build(EN_ONLY)] : [])).map(item => item.recipe);
  return {
    learning: inGroup("learning"),
    creation: inGroup("creation"),
    mine: customRecipes.filter(recipe => !needle || haystack(recipe).includes(needle)),
  };
}

const VARIABLE_LABELS: Record<string, [string, string]> = {
  material: ["学习资料（文件或目录路径）", "Study material (file or folder path)"],
  focus: ["本次学习重点", "Focus for this session"],
  questions: ["题目数量", "Number of questions"],
  due_window: ["复习范围（多久之内到期）", "Review window (what is due)"],
  count: ["本次题量", "Items in this sitting"],
  topic: ["主题", "Topic"],
  audience: ["受众（给谁看）", "Audience (who it is for)"],
  outcome: ["本次要达到的效果", "Outcome this round must achieve"],
  deliverable: ["成果形式（例如三分钟短片脚本）", "Deliverable (for example a 3-minute script)"],
  length: ["篇幅（例如 800 字）", "Length (for example 800 words)"],
  duration: ["时长（例如 60 秒）", "Duration (for example 60 seconds)"],
  style: ["画面风格", "Visual style"],
};

/** Plain-language label for a variable, falling back to the author's own name. */
export function recipeVariableLabel(t: DomainT, name: string): string {
  const entry = Object.hasOwn(VARIABLE_LABELS, name) ? VARIABLE_LABELS[name] : undefined;
  return entry ? t(entry[0], entry[1]) : name;
}

/** Save-as-copy for any recipe: fresh id, localised "copy" suffix, never the source id. */
export function recipeCopyDraft(source: TaskRecipe, t: DomainT, newId: () => string): TaskRecipe {
  return {
    ...source,
    id: newId(),
    name: `${source.name.slice(0, 110)}${t(" 副本", " Copy")}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
