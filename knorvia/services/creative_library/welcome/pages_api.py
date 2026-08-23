"""API literacy, provider recipes, diagnostics."""

from __future__ import annotations

from .marks import journey_scene


def body_api() -> str:
    return f"""
<section class="warn" aria-labelledby="never">
  <h2 id="never">先把钥匙藏好</h2>
  <p><strong>不要把真实 API Key 发给任何人。</strong> 不要发给 Knorvia 对话、不要发给「客服」、不要截图、不要提交到 Git。下面所有例子都是一眼假的 <code>sk-xxxx…xxxx</code>。</p>
</section>

<section class="well journey" aria-labelledby="trip">
  <h2 id="trip">一句话怎么出门、又怎么回来</h2>
  <p>别把 API 想成「一串神秘代码」。把它想成寄信：你在工作台写好内容，Knorvia 帮你送到服务商的邮局，邮局里有一位叫「模型名」的员工拆信；你的 API Key 是信箱钥匙，证明邮资算在你头上。回信再回到对话里。</p>
  <figure class="scene">
    {journey_scene()}
    <figcaption>点下面的站点，路上对应的人会亮起来。手机上站点会折成两列，故事仍然按顺序读。</figcaption>
  </figure>
  <div class="switcher">
    <div class="tabs" role="radiogroup" aria-label="请求怎么走一遭">
      <label for="j-you"><input type="radio" name="trip" id="j-you" checked>你说话</label>
      <label for="j-desk"><input type="radio" name="trip" id="j-desk">Knorvia 代寄</label>
      <label for="j-post"><input type="radio" name="trip" id="j-post">Base URL 邮局</label>
      <label for="j-clerk"><input type="radio" name="trip" id="j-clerk">模型名 员工</label>
      <label for="j-key"><input type="radio" name="trip" id="j-key">API Key 钥匙</label>
      <label for="j-back"><input type="radio" name="trip" id="j-back">回信</label>
    </div>
    <div class="panel panel-you">
      <p>你在对话里打字。这还只是工作台里的一张纸条，还没离开你的电脑。</p>
    </div>
    <div class="panel panel-desk">
      <p>Knorvia 把纸条打包。它是代寄点，不是大脑本身。没有请来的员工，它也写不出字。</p>
    </div>
    <div class="panel panel-post">
      <p><strong>Base URL</strong> 是邮局大楼的门牌。例如 <code>https://api.openai.com/v1</code>。通常写到 <code>/v1</code> 为止，不要把 <code>/chat/completions</code> 也贴上去。</p>
    </div>
    <div class="panel panel-clerk">
      <p><strong>模型名</strong> 是这栋楼里的哪一位员工。必须和控制台标签一字不差。你记忆中的简称，柜台可能根本不认。</p>
    </div>
    <div class="panel panel-key">
      <p><strong>API Key</strong> 是你的信箱钥匙：证明这封信用你的账户付邮资。它不是 Knorvia 的登录密码，也不是可以拿去展示的风景。</p>
    </div>
    <div class="panel panel-back">
      <p>员工写好回信，Knorvia 拆开显示在对话里。账单记在服务商那边。这一页的模拟检查<strong>不会真的寄出</strong>。</p>
    </div>
  </div>
</section>

<section class="well" aria-labelledby="where">
  <h2 id="where">三格在界面的哪</h2>
  <div class="timeline">
    <div class="t-item"><span class="dot"></span><div>打开 <strong>设置 → LLM</strong>（聊天和大多数推理用这个。图像 / 视频是另外的目录）。</div></div>
    <div class="t-item"><span class="dot"></span><div>新建或选中一个配置。不确定绑定就选 OpenAI 兼容。</div></div>
    <div class="t-item"><span class="dot"></span><div>粘贴 Base URL、模型名、API Key。展开「诊断」，点 <strong>运行测试</strong>。这一步才会真正联网。</div></div>
  </div>
  <details class="fold">
    <summary>项目根目录的 .env 能用吗？</summary>
    <p>不能指望它。Knorvia 故意忽略项目根 <code>.env</code>。把钥匙只放在设置界面。</p>
  </details>
</section>

<section class="well" aria-labelledby="sim">
  <h2 id="sim">离线演习：看看这封信写得像不像</h2>
  <p>按钮只会在这一页的沙箱里看格式。占位符不能当真钥匙。</p>
  <div role="form" aria-labelledby="sim">
    <label class="field"><span>服务商</span>
      <select id="sim-provider">
        <option value="OpenAI 兼容">OpenAI 兼容</option>
        <option value="DeepSeek">DeepSeek</option>
        <option value="通义 DashScope">通义 DashScope</option>
        <option value="Moonshot / Kimi">Moonshot / Kimi</option>
        <option value="OpenRouter">OpenRouter</option>
        <option value="Ollama 本地">Ollama 本地</option>
      </select>
    </label>
    <label class="field"><span>Base URL（邮局门牌）</span>
      <input id="sim-base" type="text" spellcheck="false" autocomplete="off" placeholder="https://api.example.com/v1" value="https://api.deepseek.com">
    </label>
    <label class="field"><span>模型名（哪位员工）</span>
      <input id="sim-model" type="text" spellcheck="false" autocomplete="off" placeholder="控制台里的全名" value="deepseek-chat">
    </label>
    <label class="field"><span>API Key（请用假的练习）</span>
      <input id="sim-key" type="password" spellcheck="false" autocomplete="off" placeholder="sk-xxxx…xxxx" value="sk-xxxx…xxxx">
    </label>
    <div class="row">
      <button type="button" id="sim-check">检查这封信</button>
      <button type="button" class="ghost" id="toggle-key">显示</button>
    </div>
    <p id="sim-result" class="status" role="status" aria-live="polite">还没检查。</p>
  </div>
  <details class="fold">
    <summary>为什么按了检查，它不真的去寄？</summary>
    <p>因为这是资料库里的一页 HTML，运行在<strong>不联网、看不见你设置</strong>的沙箱里。真连接只发生在「设置 → LLM → 运行测试」或真实对话。</p>
  </details>
</section>
"""


def body_providers() -> str:
    return """
<section class="well" aria-labelledby="how">
  <h2 id="how">把各家邮局当成集邮册</h2>
  <p>下面的 Base URL 来自 Knorvia 内置的服务商登记表，不是广告。模型名请到<strong>你自己的控制台</strong>复制。</p>
  <p>密钥形状只是「长得像」：<code>sk-xxxx…xxxx</code>。看到真钥匙请立刻移开眼睛，去控制台轮换。</p>
</section>

<section class="well" aria-labelledby="pv">
  <h2 id="pv">点一张邮票，看怎么填</h2>
  <div class="switcher">
    <div class="tabs stamps" role="radiogroup" aria-label="服务商">
      <label for="pv-openai"><input type="radio" name="pv" id="pv-openai" checked>OpenAI</label>
      <label for="pv-deepseek"><input type="radio" name="pv" id="pv-deepseek">DeepSeek</label>
      <label for="pv-qwen"><input type="radio" name="pv" id="pv-qwen">通义</label>
      <label for="pv-kimi"><input type="radio" name="pv" id="pv-kimi">Kimi</label>
      <label for="pv-silicon"><input type="radio" name="pv" id="pv-silicon">硅基流动</label>
      <label for="pv-openrouter"><input type="radio" name="pv" id="pv-openrouter">OpenRouter</label>
      <label for="pv-ollama"><input type="radio" name="pv" id="pv-ollama">Ollama</label>
      <label for="pv-custom"><input type="radio" name="pv" id="pv-custom">自定义</label>
    </div>
    <div class="panel panel-openai">
      <p>Base URL：<code>https://api.openai.com/v1</code></p>
      <p>绑定：OpenAI。模型名从平台复制，选对话模型而不是 TTS。另有 Codex 登录通道（OAuth），和「粘贴 sk-」不是同一条路。</p>
    </div>
    <div class="panel panel-deepseek">
      <p>Base URL：<code>https://api.deepseek.com</code></p>
      <p>对话名在控制台里复制。推理型号有时看起来像「没说话」，见检测篇。</p>
    </div>
    <div class="panel panel-qwen">
      <p>Base URL：<code>https://dashscope.aliyuncs.com/compatible-mode/v1</code></p>
      <p>阿里云 DashScope 的 OpenAI 兼容入口。模型名用控制台里的通义千问系列。</p>
    </div>
    <div class="panel panel-kimi">
      <p>Base URL：<code>https://api.moonshot.cn/v1</code></p>
      <p>Moonshot / Kimi。部分 Kimi 型号会锁定温度，Knorvia 已按模型名做了兼容；仍要贴完整模型名。</p>
    </div>
    <div class="panel panel-silicon">
      <p>Base URL：<code>https://api.siliconflow.cn/v1</code></p>
      <p>网关：一串 Key 后面有很多别人的模型。全名常常带组织前缀。</p>
    </div>
    <div class="panel panel-openrouter">
      <p>Base URL：<code>https://openrouter.ai/api/v1</code></p>
      <p>模型名经常是 <code>供应商/型号</code>。Key 常见以 <code>sk-or-</code> 开头——仍然不要把真的贴进聊天。</p>
    </div>
    <div class="panel panel-ollama">
      <p>Base URL：<code>http://localhost:11434/v1</code></p>
      <p>先在本机把 Ollama 打开并 pull 好模型。LM Studio 常见 <code>http://localhost:1234/v1</code>；llama.cpp 常见 <code>http://localhost:8080/v1</code>。</p>
    </div>
    <div class="panel panel-custom">
      <p>自称 OpenAI 兼容的中转：绑定选 Custom，Base URL 填对方文档里的 API Base。</p>
      <p>Anthropic 原生接口是另一条绑定（<code>https://api.anthropic.com/v1</code>）。MiniMax 全球默认 <code>https://api.minimax.io/v1</code>；国内平台是另一套域名和钥匙，不能混用。</p>
    </div>
  </div>
</section>

<section class="well" aria-labelledby="other">
  <h2 id="other">其它内置过的入口</h2>
  <ul>
    <li>智谱：<code>https://open.bigmodel.cn/api/paas/v4</code></li>
    <li>Groq：<code>https://api.groq.com/openai/v1</code></li>
    <li>Gemini 的 OpenAI 兼容：<code>https://generativelanguage.googleapis.com/v1beta/openai/</code></li>
    <li>火山方舟：<code>https://ark.cn-beijing.volces.com/api/v3</code></li>
  </ul>
  <p>嵌入、搜索、语音、图像、视频在设置里各有一页。聊天通了，不代表图像工作室也能画。</p>
</section>
"""


def body_verify() -> str:
    return """
<section class="well" aria-labelledby="real">
  <h2 id="real">真正寄出信件，发生在设置里</h2>
  <div class="lights" aria-label="三种灯">
    <span class="light wait"><i></i> 还没测</span>
    <span class="light go"><i></i> 诊断通过</span>
    <span class="light stop"><i></i> 报错先打码</span>
  </div>
  <div class="timeline">
    <div class="t-item"><span class="dot"></span><div>打开 <strong>设置 → LLM</strong>，确认当前配置就是你刚填的那份。</div></div>
    <div class="t-item"><span class="dot"></span><div>展开 <strong>诊断</strong>，点 <strong>运行测试</strong>。日志会写请求目标和一小段回复。</div></div>
    <div class="t-item"><span class="dot"></span><div>图像或视频不行时，去对应的图像 / 视频页，而不是反复改聊天模型。</div></div>
  </div>
</section>

<section class="well" aria-labelledby="decode">
  <h2 id="decode">把报错翻译成人话</h2>
  <p>把报错原文贴进来（请先删掉钥匙）。这一页仍然不联网。</p>
  <label class="field"><span>报错原文</span>
    <textarea id="decode-input" rows="5" spellcheck="false" placeholder="例如：401 Incorrect API key provided"></textarea>
  </label>
  <button type="button" id="decode-run">对照常见原因</button>
  <p id="decode-result" class="status" role="status" aria-live="polite">等待输入。</p>
</section>

<section class="well" aria-labelledby="faq">
  <h2 id="faq">常见卡壳</h2>
  <details class="fold">
    <summary>401 / invalid api key</summary>
    <p>钥匙错、过期、复制少字符，或 Key 属于另一家。立刻去控制台轮换。</p>
  </details>
  <details class="fold">
    <summary>模型不存在 / 404</summary>
    <p>网关类服务商往往要求 <code>组织/型号</code>。到控制台点「复制模型 ID」。</p>
  </details>
  <details class="fold">
    <summary>连不上 / 超时 / DNS</summary>
    <p>检查有没有多写 <code>/chat/completions</code>。Ollama 先在终端能列出模型再回来。</p>
  </details>
  <details class="fold">
    <summary>空回复</summary>
    <p>部分推理模型把额度花在内部思考上。换一个明确的对话模型。</p>
  </details>
  <details class="fold">
    <summary>聊天可以，知识库不行</summary>
    <p>检索还要嵌入模型。去设置 → 嵌入，单独配。</p>
  </details>
  <details class="fold">
    <summary>我把真钥匙发到对话里了</summary>
    <p>马上去服务商控制台作废这把钥匙，再生成新的。不要心存侥幸。</p>
  </details>
</section>
"""
