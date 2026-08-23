"""Overview — warm desk scene and first-hour board."""

from __future__ import annotations

from .marks import desk_scene


def body() -> str:
    return f"""
<div class="desk-board">
<figure class="scene">
  {desk_scene()}
  <figcaption>灯亮着，本子摊开。点下面的入口，桌子上对应的角落会跟着亮起来。</figcaption>
</figure>

<section class="well" aria-labelledby="desk">
  <h2 id="desk">先把这张桌子认熟</h2>
  <p>Knorvia 不是某个聊天网站，也不是「装完就自带无限大脑」。它是一张<strong>住在你电脑里的工作台</strong>：对话是摊开的本子，工具是笔筒，资料库是抽屉，知识库是书架。要请一位会说话的帮手，得另外连上语言模型。</p>
  <div class="switcher">
    <div class="tabs" role="radiogroup" aria-label="此刻最想做的事">
      <label for="tab-a"><input type="radio" name="now" id="tab-a" checked>先让它开口</label>
      <label for="tab-b"><input type="radio" name="now" id="tab-b">搞懂这些词</label>
      <label for="tab-c"><input type="radio" name="now" id="tab-c">怕把钥匙弄丢</label>
      <label for="tab-d"><input type="radio" name="now" id="tab-d">已经能聊，想干活</label>
    </div>
    <div class="panel panel-a">
      <p>亮起来的是<strong>对话本</strong>。先去 <strong>设置 → LLM</strong> 填 Base URL、模型名、API Key，点「运行测试」，再回对话说「回我一个字：好」。</p>
      <p>若你连 API 三个词都没听过，去 <em>04 接线</em>，那里有一趟「请求旅行」。</p>
    </div>
    <div class="panel panel-b">
      <p>笔筒和整出戏不是一回事。<em>03 名词</em>里五位角色站成一排，还有小测。</p>
    </div>
    <div class="panel panel-c">
      <p>真钥匙只属于你。不要发给聊天框、客服、截图。本页模拟检查<strong>不联网、不保存</strong>。见 <em>08 边界</em>。</p>
    </div>
    <div class="panel panel-d">
      <p>按今天的活选一条路：问概念、喂教材、写长文、做图或做视频。见 <em>07 活计</em>。</p>
    </div>
  </div>
</section>
</div>

<section class="well" aria-labelledby="hour">
  <h2 id="hour">十分钟就够的小事</h2>
  <p class="progress-out" aria-hidden="true"></p>
  <p id="check-live" class="status" role="status" aria-live="polite"></p>
  <div class="checklist">
    <label><input type="checkbox"> 知道大脑要另外请来，不是开机就有无限额度。</label>
    <label><input type="checkbox"> 能指出 Base URL、模型名、API Key 各管什么。</label>
    <label><input type="checkbox"> 决定不把真钥匙发给任何人（包括这只聊天框）。</label>
    <label><input type="checkbox"> 分得清抽屉（资料库）和书架（知识库）。</label>
    <label><input type="checkbox"> 愿意在设置里跑一次诊断，而不是对着空白对话发呆。</label>
  </div>
</section>

<section class="warn" aria-labelledby="key-warn">
  <h2 id="key-warn">比功能更先说</h2>
  <p><strong>不要把真实 API Key 发给任何人。</strong> 钥匙等于用你的钱去喊那位员工。示例只写 <code>sk-xxxx…xxxx</code>。</p>
  <details class="fold">
    <summary>为什么是 HTML，不是一篇 Markdown？</summary>
    <p>因为你需要切换场景、勾选、模拟接线。Markdown 预览做不到这些。脚本只在隔离预览框里跑。</p>
  </details>
</section>
"""
