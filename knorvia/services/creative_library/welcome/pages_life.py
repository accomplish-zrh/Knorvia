"""Workflow, safety, next rooms."""

from __future__ import annotations

from .marks import house_map, jars, terrarium


def body_workflow() -> str:
    return """
<section class="well trail" aria-labelledby="pick">
  <h2 id="pick">今天要走哪一条小路</h2>
  <p>手机上这是一条从上到下的小径：先点站点，下面会展开那一站的风景。不是把桌面卡片硬叠起来。</p>
  <div class="switcher">
    <div class="tabs" role="radiogroup" aria-label="工作流">
      <label for="tab-a"><input type="radio" name="wf" id="tab-a" checked><span class="emoji" aria-hidden="true">💡</span>把一个概念搞懂</label>
      <label for="tab-b"><input type="radio" name="wf" id="tab-b"><span class="emoji" aria-hidden="true">📚</span>啃一本教材</label>
      <label for="tab-c"><input type="radio" name="wf" id="tab-c"><span class="emoji" aria-hidden="true">✍️</span>写长文或表格</label>
      <label for="tab-d"><input type="radio" name="wf" id="tab-d"><span class="emoji" aria-hidden="true">🎬</span>做图或做视频</label>
    </div>
    <div class="panel panel-a">
      <p>待在默认对话。问「用中学生能听懂的话说」。需要画示意图时，换成 <strong>可视化</strong> 能力（SVG / Chart / Mermaid / HTML；Manim 需要额外组件）。</p>
      <p>引导学习适合「按主题带着走」，不是每一个问题都要开。</p>
    </div>
    <div class="panel panel-b">
      <p>先建<strong>知识库</strong>，把 PDF 或笔记导入并等待索引。资料库里的 HTML 说明不会自动变成教材检索。</p>
      <p>深度研究适合「我要一份带引用的报告」，不要用它来改一句措辞。</p>
    </div>
    <div class="panel panel-c">
      <p>短稿用对话。长稿去 Co-Writer。表格、说明书、互动页保存进资料库。精确计算时，沙箱可用会挂上代码执行。</p>
    </div>
    <div class="panel panel-d">
      <p>图像工作室和视频工作室有自己的模型目录。聊天那边的 LLM 不会自动变成画师。资料库里的图可以「用在图像 / 视频工作室」。</p>
    </div>
  </div>
</section>

<section class="well" aria-labelledby="caps">
  <h2 id="caps">能力像调色盘，不必一次全挤上去</h2>
  <div class="lane two">
    <article class="chip"><h3>chat</h3><p>日常默认。</p></article>
    <article class="chip"><h3>deep_solve</h3><p>把题目做完并写出过程。</p></article>
    <article class="chip"><h3>deep_question</h3><p>先发想再出题。</p></article>
    <article class="chip"><h3>deep_research</h3><p>改写 → 拆解 → 检索 → 报告。</p></article>
    <article class="chip"><h3>visualize</h3><p>分析后生成图或小网页。</p></article>
    <article class="chip"><h3>math_animator</h3><p>数学动画（需要 math-animator 额外组件）。</p></article>
    <article class="chip"><h3>mastery_path</h3><p>引导学习，按主题类型开门。</p></article>
  </div>
  <p>没有列出来的能力，就当它现在不存在。</p>
  <details class="fold">
    <summary>可视化会不会自动变成视频？</summary>
    <p>不会。默认可视化产出 SVG / 图表 / Mermaid / HTML。Manim 是另一条路。</p>
  </details>
</section>
"""


def body_safety() -> str:
    return f"""
<figure class="scene">
  {jars()}
  <figcaption>三只罐子：钥匙（少放）、账单（会涨）、嘴（想清楚再贴）。</figcaption>
</figure>

<section class="warn" aria-labelledby="key2">
  <h2 id="key2">钥匙、钱、嘴</h2>
  <p><strong>不要把真实 API Key 发给任何人。</strong> 泄露之后唯一的补救是去服务商那里作废并轮换。</p>
  <p>费用在服务商账单上跳动：按 token、按张数、按秒。诊断和随便闲聊也会产生费用。本地模型耗的是你的电脑。</p>
</section>

<section class="well" aria-labelledby="where2">
  <h2 id="where2">你的数据大概在哪</h2>
  <div class="timeline">
    <div class="t-item"><span class="dot"></span><div>工作区、资料库、知识库、设置，默认落在本机（或你指定的 <code>KNORVIA_HOME</code>）。</div></div>
    <div class="t-item"><span class="dot"></span><div>一旦调用云端模型，<strong>这一轮寄出的内容</strong>会到达那家服务商。</div></div>
    <div class="t-item"><span class="dot"></span><div>网页搜索、论文搜索、抓取网页，会把查询发到对应通道。</div></div>
    <div class="t-item"><span class="dot"></span><div>代码执行走沙箱。不要把密钥写进要运行的代码。</div></div>
  </div>
</section>

<section class="well" aria-labelledby="paste">
  <h2 id="paste">能不能贴？</h2>
  <div id="welcome-quiz" class="quiz">
    <div class="q" data-answer="no">
      <fieldset>
        <legend>1. 刚复制的 API Key，能发给「帮我看看连不上」的聊天吗？</legend>
        <label><input type="radio" name="s1" value="yes"> 能，反正是自己的软件</label><br>
        <label><input type="radio" name="s1" value="no"> 不能。打码或根本别贴</label>
      </fieldset>
    </div>
    <div class="q" data-answer="maybe">
      <fieldset>
        <legend>2. 一份不涉密的讲义 PDF，能丢进知识库吗？</legend>
        <label><input type="radio" name="s2" value="maybe"> 能，这正是知识库的活</label><br>
        <label><input type="radio" name="s2" value="no"> 绝对不能，任何 PDF 都危险</label>
      </fieldset>
    </div>
    <div class="q" data-answer="no">
      <fieldset>
        <legend>3. 含身份证号的表格，该不该直接丢给云端模型整理？</legend>
        <label><input type="radio" name="s3" value="yes"> 能，反正有沙箱</label><br>
        <label><input type="radio" name="s3" value="no"> 不该。先脱敏，或只用本地模型</label>
      </fieldset>
    </div>
  </div>
  <p class="row"><button type="button" id="quiz-grade">揭晓</button></p>
  <p id="quiz-result" class="status" role="status" aria-live="polite"></p>
</section>

<section class="well" aria-labelledby="html-risk">
  <h2 id="html-risk">资料库 HTML 也不是自己人</h2>
  <figure class="scene">{terrarium()}</figure>
  <p>包括这份导览在内，资料库里的网页都在隔离预览中打开。不要把来路不明的 HTML 当成官方插件。</p>
  <p>你删除这个文件夹后，软件不会在下次启动时悄悄种回来。</p>
</section>
"""


def body_next() -> str:
    return f"""
<figure class="scene">
  {house_map()}
  <figcaption>导览结束。房子还在：对话厅最大，资料库就是你现在站的这个房间。</figcaption>
</figure>

<section class="well" aria-labelledby="after">
  <h2 id="after">接下来推开哪扇门</h2>
  <div class="lane two">
    <article class="chip"><h3>对话</h3><p>从一句「把傅里叶变换讲成人话」开始。</p></article>
    <article class="chip"><h3>设置 → LLM</h3><p>还没接线就先来这里。诊断比反复刷新对话有用。</p></article>
    <article class="chip"><h3>知识库</h3><p>有一本要反复问的书时再建立。嵌入模型要另配。</p></article>
    <article class="chip"><h3>资料库</h3><p>你已经在这里了。可以改这些 HTML，也可以新建自己的页。</p></article>
    <article class="chip"><h3>图像 / 视频</h3><p>创作项目。模型与聊天分开授权。</p></article>
    <article class="chip"><h3>Co-Writer 与书</h3><p>长文和结构化读本。别用闲聊窗口硬写一本书。</p></article>
    <article class="chip"><h3>技能与伙伴</h3><p>等桌子转起来再加。</p></article>
    <article class="chip"><h3>命令行</h3><p><code>knorvia chat</code>、<code>knorvia run chat "…"</code>、<code>knorvia start</code>。</p></article>
  </div>
</section>

<section class="well" aria-labelledby="keep">
  <h2 id="keep">带走三句话</h2>
  <div class="timeline">
    <div class="t-item"><span class="dot"></span><div>Knorvia 是桌子，语言模型是外请的大脑，钥匙是你的钱。</div></div>
    <div class="t-item"><span class="dot"></span><div>资料库是抽屉，知识库是书架，工具是一次性器具，能力是整出戏。</div></div>
    <div class="t-item"><span class="dot"></span><div>真钥匙不进聊天、不进截图、不进 Git。</div></div>
  </div>
  <details class="fold">
    <summary>这些房间在界面的哪里？</summary>
    <p>侧栏或工作区：对话、资料库、知识库、设置、图像工作室、视频工作室、Co-Writer、伙伴。命令行则是 <code>knorvia --help</code>。</p>
  </details>
  <p id="check-live" class="status" role="status" aria-live="polite"></p>
  <div class="checklist">
    <label><input type="checkbox"> 我知道下一步该去设置还是该去对话。</label>
    <label><input type="checkbox"> 我不会把这份导览当成可以联网的控制台。</label>
    <label><input type="checkbox"> 我愿意删掉它——如果它挡路的话——并且明白它不会自行复活。</label>
  </div>
</section>
"""
