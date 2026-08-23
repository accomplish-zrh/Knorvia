"""Mental model, first power-on, and vocabulary."""

from __future__ import annotations

from .marks import cast_scene, comic_strip, five_roles


def body_model() -> str:
    return f"""
<figure class="scene">
  {cast_scene()}
  <figcaption>左边是你，中间是工作台，右边提着箱子的是请来的大脑。箱子不住在安装目录里。</figcaption>
</figure>

<section class="well" aria-labelledby="cast">
  <h2 id="cast">别认错人</h2>
  <div class="lane two">
    <article class="chip"><h3>Knorvia</h3><p>导演 + 舞台 + 道具箱。把你的话编成一轮工作。</p></article>
    <article class="chip"><h3>语言模型</h3><p>外请的大脑。你出题，它出字，服务商向你收费。</p></article>
  </div>
  <p>所以「Knorvia 连不上」常常不是软件坏了，而是<strong>大脑那一侧</strong>的门牌、工号或钥匙写错了。</p>
</section>

<section class="well" aria-labelledby="loop">
  <h2 id="loop">一句话说完，后台其实走了这几步</h2>
  <div class="timeline">
    <div class="t-item"><span class="dot" aria-hidden="true"></span><div><strong>你</strong>说出想做的事</div></div>
    <div class="t-item"><span class="dot" aria-hidden="true"></span><div><strong>编排器</strong>选一个能力（默认是 chat）</div></div>
    <div class="t-item"><span class="dot" aria-hidden="true"></span><div><strong>能力</strong>思考，必要时拿起工具</div></div>
    <div class="t-item"><span class="dot" aria-hidden="true"></span><div><strong>工具</strong>搜网页、读资料、写笔记、跑沙箱代码…</div></div>
    <div class="t-item"><span class="dot" aria-hidden="true"></span><div><strong>回复</strong>流式出现在对话里，费用记一笔</div></div>
  </div>
  <p>默认能力 <code>chat</code> 先探索再回答。<code>deep_solve</code> 会换整份剧本：规划→推理→书写。</p>
</section>

<section class="well" aria-labelledby="rooms">
  <h2 id="rooms">房子里还有哪些房间</h2>
  <div class="lane two">
    <article class="chip"><h3>对话</h3><p>主舞台。大多数事从这里开始。</p></article>
    <article class="chip"><h3>资料库</h3><p>个人抽屉：Markdown、HTML、CSV、画布、Word、Excel。</p></article>
    <article class="chip"><h3>知识库</h3><p>把 PDF / 教材做成可检索的书架。</p></article>
    <article class="chip"><h3>设置</h3><p>LLM、嵌入、搜索、图像、视频。合同签在这里。</p></article>
    <article class="chip"><h3>工作室</h3><p>图像 / 视频有自己的模型目录，和聊天分开授权。</p></article>
    <article class="chip"><h3>学习与写作</h3><p>引导学习、书、问题本、Co-Writer、记忆与伙伴。</p></article>
  </div>
  <details class="fold">
    <summary>CLI 和桌面版是另一套产品吗？</summary>
    <p>不是。命令行、浏览器、桌面壳走同一套 Python 运行时。差别主要在入口，不在「大脑怎么接」。</p>
  </details>
</section>
"""


def body_first_run() -> str:
    return f"""
<figure class="scene">
  {comic_strip()}
  <figcaption>三格漫画：先请来大脑，再说一句废话确认线路，然后才开始干活。</figcaption>
</figure>

<section class="well" aria-labelledby="board">
  <h2 id="board">跟着格子走</h2>
  <div class="wizard" data-wizard>
    <p data-wizard-live class="status" role="status" aria-live="polite"></p>
    <div class="pane is-on" data-pane>
      <h3>第 1 格 · 请来大脑</h3>
      <p>打开 <strong>设置 → LLM</strong>。新建或选中一个配置：</p>
      <ol>
        <li>服务商 / 绑定（不会填就选 OpenAI 兼容）</li>
        <li>Base URL</li>
        <li>模型名</li>
        <li>API Key（本地 Ollama 等以对方文档为准，有时不需要云端那种长钥匙）</li>
      </ol>
      <p>保存后展开「诊断」，点 <strong>运行测试</strong>。这一步才会真正联网。</p>
    </div>
    <div class="pane" data-pane hidden>
      <h3>第 2 格 · 说一句废话</h3>
      <p>回到对话，发送：</p>
      <pre>请只回复一个字：好</pre>
      <p>若它回了「好」，线路是通的。若报错，打码钥匙后带到 <em>06 检测</em>。</p>
    </div>
    <div class="pane" data-pane hidden>
      <h3>第 3 格 · 别急着开十个开关</h3>
      <p>先做一件具体的事。工具和能力会按场景自动出现，不必先背完整张菜单。</p>
    </div>
    <div class="row">
      <button type="button" class="ghost" data-wizard-prev>上一步</button>
      <button type="button" data-wizard-next>下一步</button>
    </div>
  </div>
</section>

<section class="well" aria-labelledby="not">
  <h2 id="not">新人不需要先做</h2>
  <div class="timeline">
    <div class="t-item"><span class="dot"></span><div>不必先配嵌入模型才能聊天（知识库检索才需要）。</div></div>
    <div class="t-item"><span class="dot"></span><div>不必先理解 MCP、伙伴、技能市场。</div></div>
    <div class="t-item"><span class="dot"></span><div>不必把所有工具打开。聊天会按现场自动挂上该挂的。</div></div>
    <div class="t-item"><span class="dot"></span><div>不必把密钥写进项目根目录的 <code>.env</code>。Knorvia 故意忽略它。</div></div>
  </div>
</section>

<section class="well" aria-labelledby="hour2">
  <h2 id="hour2">通电顺序</h2>
  <p id="check-live" class="status" role="status" aria-live="polite"></p>
  <div class="checklist">
    <label><input type="checkbox"> 设置 → LLM 里有一个配置，不再是空的。</label>
    <label><input type="checkbox"> 诊断跑通过，或对话里已经成功回了一句。</label>
    <label><input type="checkbox"> 打开过资料库，知道这篇导览可以收藏、也可以删。</label>
    <label><input type="checkbox"> 能用自己的话区分抽屉和书架。</label>
  </div>
</section>
"""


def body_map() -> str:
    return f"""
<figure class="scene">
  {five_roles()}
  <figcaption>五个亲戚站成一排。看起来都像「会帮忙的东西」，活完全不同。</figcaption>
</figure>

<section class="well" aria-labelledby="five">
  <h2 id="five">谁干什么</h2>
  <div class="lane two">
    <article class="chip"><h3>工具</h3><p>一次一件。模型决定要不要拿。设置 → 工具里可关：<code>brainstorm</code>、<code>web_search</code>、<code>paper_search</code>、<code>reason</code>。</p></article>
    <article class="chip"><h3>能力</h3><p>整轮剧本。默认 <code>chat</code>。深度求解、研究、可视化会分阶段接管。</p></article>
    <article class="chip"><h3>对话</h3><p>舞台本身。能力在幕后换剧本，你仍看着同一扇窗。</p></article>
    <article class="chip"><h3>资料库</h3><p>个人抽屉。手稿、HTML、表格、画布。不会自动当教材检索。</p></article>
    <article class="chip"><h3>知识库</h3><p>书架。导入后切块索引。对话用 <code>rag</code> 去问这本书。</p></article>
  </div>
</section>

<section class="well" aria-labelledby="quiz">
  <h2 id="quiz">认人小测</h2>
  <div id="welcome-quiz" class="quiz">
    <div class="q" data-answer="library">
      <fieldset>
        <legend>1. 你写了一页给自己看的 HTML 说明书，放哪？</legend>
        <label><input type="radio" name="q1" value="kb"> 知识库，因为它是「知识」</label><br>
        <label><input type="radio" name="q1" value="library"> 资料库，因为它是你的文件</label><br>
        <label><input type="radio" name="q1" value="tool"> 当成一个工具安装</label>
      </fieldset>
    </div>
    <div class="q" data-answer="capability">
      <fieldset>
        <legend>2. 「深度研究」会分阶段改写问题、拆任务、写报告。它是？</legend>
        <label><input type="radio" name="q2" value="tool"> 一个工具</label><br>
        <label><input type="radio" name="q2" value="capability"> 一个能力</label><br>
        <label><input type="radio" name="q2" value="kb"> 一个知识库</label>
      </fieldset>
    </div>
    <div class="q" data-answer="rag">
      <fieldset>
        <legend>3. 想问自己导入的教材，对话里主要靠什么？</legend>
        <label><input type="radio" name="q3" value="rag"> 知识库 + 检索（rag）</label><br>
        <label><input type="radio" name="q3" value="html"> 把教材改成 HTML 放进资料库就自动会了</label><br>
        <label><input type="radio" name="q3" value="reason"> 只开 reason 工具</label>
      </fieldset>
    </div>
  </div>
  <p class="row"><button type="button" id="quiz-grade">揭晓</button></p>
  <p id="quiz-result" class="status" role="status" aria-live="polite"></p>
  <noscript><p>没有脚本时请对照：1 资料库；2 能力；3 知识库检索。</p></noscript>
</section>
"""
