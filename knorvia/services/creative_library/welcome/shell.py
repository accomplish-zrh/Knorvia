"""Editorial atlas chrome for the v3 welcome pack."""

from __future__ import annotations

from html import escape

from .marks import brand_mark

LIBRARY_HTML_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; "
    "base-uri 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; "
    "worker-src 'none'; child-src 'none'; manifest-src 'none'"
)

CSS = r"""
:root {
  color-scheme: light;
  --paper: #fbf3e8;
  --paper-2: #f3e6d4;
  --ink: #2b221b;
  --muted: #6d5c4f;
  --line: rgba(90, 52, 28, .12);
  --card: #fffaf4;
  --sky: #4f8fb8;
  --sky-soft: #d5e7f3;
  --sage: #3e8a68;
  --sage-2: #2f6d53;
  --peach: #e08b5c;
  --lamp: #f0c36a;
  --wood: #c48a58;
  --wood-deep: #9a6840;
  --rose: #c45c4a;
  --ok: #2f7d57;
  --shadow: 0 18px 50px rgba(92, 48, 16, .12);
  --sans: "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --mono: "Cascadia Mono", "Sarasa Mono SC", Consolas, monospace;
  --r: 22px;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --paper: #1b1612;
    --paper-2: #241d17;
    --ink: #f3ebe3;
    --muted: #c0b0a2;
    --line: rgba(255, 228, 200, .12);
    --card: #2a221c;
    --sky: #8ebddc;
    --sky-soft: #31485a;
    --sage: #86c8a6;
    --sage-2: #5fa883;
    --peach: #e8a67a;
    --lamp: #f5c97a;
    --wood: #6d4a32;
    --wood-deep: #4a3222;
    --rose: #ef8b7c;
    --ok: #8ee0b4;
    --shadow: 0 18px 50px rgba(0, 0, 0, .35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--sans);
  color: var(--ink);
  background:
    radial-gradient(900px 420px at 12% -10%, color-mix(in srgb, var(--lamp) 35%, transparent), transparent 60%),
    radial-gradient(700px 380px at 110% 8%, color-mix(in srgb, var(--sky) 28%, transparent), transparent 55%),
    linear-gradient(180deg, var(--paper) 0%, var(--paper-2) 100%);
  line-height: 1.7;
}
.skip {
  position: absolute; left: -999px; top: 12px; z-index: 20;
  padding: 8px 14px; border-radius: 999px;
  background: var(--ink); color: var(--paper);
}
.skip:focus { left: 14px; }
.wrap { max-width: 920px; min-width: 0; margin: 0 auto; padding: 22px 18px 72px; }
main, .well, .warn, .switcher, .switcher .panel { min-width: 0; max-width: 100%; }
header.mast {
  display: grid; gap: 10px; margin-bottom: 18px;
}
.brand {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 6px 12px 6px 6px; width: max-content;
  border-radius: 999px; background: color-mix(in srgb, var(--card) 80%, transparent);
  box-shadow: var(--shadow);
  font-size: 13px;
}
.brand .illu { width: 36px; height: 36px; }
.kicker { margin: 0; color: var(--peach); font-size: 13px; letter-spacing: .04em; }
h1 { margin: 0; font-size: clamp(28px, 6vw, 46px); line-height: 1.12; letter-spacing: -.03em; }
.lede { margin: 0; max-width: 38rem; color: var(--muted); font-size: 16px; }
nav.rail ol {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin: 8px 0 0; padding: 0; list-style: none; counter-reset: ch;
}
nav.rail li {
  counter-increment: ch;
  padding: 7px 12px; border-radius: 999px;
  background: var(--card); font-size: 12.5px; color: var(--muted);
  box-shadow: 0 1px 0 var(--line);
}
nav.rail li.current {
  background: var(--ink); color: var(--paper);
}
nav.rail li.current span::before,
nav.rail li span { }
.nav-hint { margin: 8px 0 0; color: var(--muted); font-size: 12.5px; }
main { display: grid; gap: 18px; }
.scene {
  position: relative; overflow: hidden;
  border-radius: 28px; background: var(--card); box-shadow: var(--shadow);
}
.scene .illu { display: block; width: 100%; height: auto; }
.scene figcaption, .cap {
  padding: 12px 16px 16px; color: var(--muted); font-size: 14px;
}
.well, .warn, details.fold {
  background: var(--card); border-radius: var(--r); box-shadow: var(--shadow); padding: 18px 18px 16px;
}
.warn { background: color-mix(in srgb, var(--rose) 14%, var(--card)); }
.warn strong { color: var(--rose); }
.well h2, .warn h2, .scene h2, .trail-head h2 { margin: 0 0 10px; font-size: 22px; letter-spacing: -.02em; }
.well h3, .warn h3 { margin: 14px 0 6px; font-size: 16px; }
p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }
code {
  font-family: var(--mono); font-size: .92em;
  padding: .08em .35em; border-radius: 8px;
  background: color-mix(in srgb, var(--sky) 16%, var(--card));
  overflow-wrap: anywhere;
  word-break: break-word;
}
pre {
  overflow: auto; margin: 0 0 12px; padding: 14px 16px; border-radius: 16px;
  background: var(--ink); color: var(--paper); font-family: var(--mono); font-size: 13px;
}
.desk-board .zone { opacity: .55; }
.desk-board:has(#tab-a:checked) .zone-chat,
.desk-board:has(#tab-b:checked) .zone-tools,
.desk-board:has(#tab-c:checked) .zone-drawer,
.desk-board:has(#tab-d:checked) .zone-shelf { opacity: 1; }
.switcher { display: grid; gap: 12px; }
.switcher .tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.switcher .tabs label {
  position: relative; cursor: pointer;
  padding: 9px 14px; border-radius: 999px;
  background: color-mix(in srgb, var(--card) 70%, var(--paper));
  box-shadow: inset 0 0 0 1px var(--line);
  font-size: 14px;
}
.switcher .tabs input[type="radio"] {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.switcher .tabs input:focus, .switcher .tabs input:focus-visible { outline: none; }
.switcher .tabs label:has(:checked) {
  background: var(--ink); color: var(--paper); box-shadow: none;
}
.switcher .tabs label:has(:focus-visible) {
  outline: 3px solid var(--lamp); outline-offset: 3px;
}
.switcher .panel { display: none; padding: 2px 2px 0; }
.switcher:has(#tab-a:checked) .panel-a,
.switcher:has(#tab-b:checked) .panel-b,
.switcher:has(#tab-c:checked) .panel-c,
.switcher:has(#tab-d:checked) .panel-d,
.switcher:has(#pv-openai:checked) .panel-openai,
.switcher:has(#pv-deepseek:checked) .panel-deepseek,
.switcher:has(#pv-qwen:checked) .panel-qwen,
.switcher:has(#pv-kimi:checked) .panel-kimi,
.switcher:has(#pv-silicon:checked) .panel-silicon,
.switcher:has(#pv-openrouter:checked) .panel-openrouter,
.switcher:has(#pv-ollama:checked) .panel-ollama,
.switcher:has(#pv-custom:checked) .panel-custom,
.switcher:has(#j-you:checked) .panel-you,
.switcher:has(#j-desk:checked) .panel-desk,
.switcher:has(#j-post:checked) .panel-post,
.switcher:has(#j-clerk:checked) .panel-clerk,
.switcher:has(#j-key:checked) .panel-key,
.switcher:has(#j-back:checked) .panel-back { display: block; }
.journey:has(#j-you:checked) .jp-you,
.journey:has(#j-desk:checked) .jp-desk,
.journey:has(#j-post:checked) .jp-post,
.journey:has(#j-clerk:checked) .jp-clerk,
.journey:has(#j-key:checked) .jp-key,
.journey:has(#j-back:checked) .jp-back {
  filter: drop-shadow(0 0 10px var(--lamp));
}
.journey .tabs label { min-width: 7.2rem; text-align: center; }
.trail .tabs {
  display: grid; grid-template-columns: 1fr; gap: 10px;
}
@media (min-width: 720px) {
  .trail .tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.trail .tabs label {
  display: grid; justify-items: center; gap: 8px;
  border-radius: 22px; padding: 14px 10px 12px; min-width: 0;
  background: var(--card);
}
.trail .tabs label .emoji {
  width: 52px; height: 52px; border-radius: 18px;
  display: grid; place-items: center; font-size: 26px;
  background: var(--sky-soft);
}
.trail:has(#tab-b:checked) .tabs label[for="tab-b"] .emoji { background: var(--sage); color: var(--paper); }
.trail:has(#tab-c:checked) .tabs label[for="tab-c"] .emoji { background: var(--peach); color: var(--paper); }
.trail:has(#tab-d:checked) .tabs label[for="tab-d"] .emoji { background: var(--lamp); }
.trail .panel {
  border-radius: 22px; padding: 14px; background: var(--sky-soft);
}
.stamps.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.stamps label {
  flex: 0 1 auto;
  max-width: 100%;
  border-radius: 16px !important;
  padding: 12px 14px !important;
  box-shadow: 4px 4px 0 color-mix(in srgb, var(--peach) 35%, transparent) !important;
}
.switcher .tabs label:has(:focus-visible),
.stamps label:has(:focus-visible),
.trail .tabs label:has(:focus-visible),
.journey .tabs label:has(:focus-visible) {
  outline: 3px solid var(--lamp);
  outline-offset: 3px;
}
.checklist { counter-reset: done; display: grid; gap: 8px; }
.checklist label {
  display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start;
  padding: 10px 12px; border-radius: 16px; background: var(--card);
}
.checklist input { margin-top: 4px; accent-color: var(--sage); }
.checklist input:checked { counter-increment: done; }
.progress-out::after { content: "已勾选 " counter(done) " 项"; color: var(--sage); font-size: 13px; }
.field { display: grid; gap: 6px; margin-bottom: 10px; }
.field span { font-size: 13px; color: var(--muted); }
input[type="text"], input[type="password"], select, textarea {
  width: 100%; padding: 11px 12px; border-radius: 14px; border: 0;
  background: color-mix(in srgb, var(--paper) 70%, var(--card));
  color: var(--ink); font: inherit; box-shadow: inset 0 0 0 1px var(--line);
}
button {
  font: inherit; cursor: pointer; border: 0; border-radius: 999px;
  padding: 10px 16px; background: var(--ink); color: var(--paper);
}
button.ghost { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
button:focus-visible, a:focus-visible, summary:focus-visible,
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--lamp); outline-offset: 2px;
}
details.fold { padding: 4px 16px 12px; }
details.fold summary { cursor: pointer; list-style: none; padding: 12px 0; font-weight: 650; }
details.fold summary::-webkit-details-marker { display: none; }
details.fold summary::after { content: " ▾"; color: var(--peach); }
.quiz { display: grid; gap: 10px; }
.q { padding: 12px; border-radius: 16px; background: color-mix(in srgb, var(--sky-soft) 55%, var(--card)); }
.q fieldset { border: 0; margin: 0; padding: 0; }
.q legend { font-weight: 650; margin-bottom: 8px; }
.status {
  min-height: 1.5em; padding: 12px 14px; border-radius: 16px;
  background: var(--card);
}
.status[data-tone="bad"] { background: color-mix(in srgb, var(--rose) 18%, var(--card)); }
.status[data-tone="ok"] { background: color-mix(in srgb, var(--ok) 18%, var(--card)); }
.wizard .pane { display: none; }
.wizard .pane.is-on { display: block; }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.lane {
  display: grid; gap: 10px;
}
@media (min-width: 720px) {
  .lane.two { grid-template-columns: 1fr 1fr; }
}
.chip {
  padding: 14px 14px 12px; border-radius: 20px; background: var(--card);
}
.chip h3 { margin: 0 0 6px; font-size: 15px; }
.chip p { margin: 0; color: var(--muted); font-size: 13.5px; }
.timeline { display: grid; gap: 0; }
.t-item {
  display: grid; grid-template-columns: 22px 1fr; gap: 12px;
}
.t-item .dot {
  width: 14px; height: 14px; margin-top: 6px; border-radius: 50%;
  background: var(--peach); box-shadow: 0 0 0 6px color-mix(in srgb, var(--peach) 22%, transparent);
}
.t-item .body { padding-bottom: 16px; border-left: 2px dashed var(--line); margin-left: 6px; padding-left: 0; }
.t-item { grid-template-columns: 22px 1fr; }
.t-item .dot { justify-self: start; }
.lights { display: flex; gap: 10px; flex-wrap: wrap; }
.light {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 999px; background: var(--card);
}
.light i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.light.go i { background: var(--ok); }
.light.wait i { background: var(--lamp); }
.light.stop i { background: var(--rose); }
footer.foot {
  margin-top: 20px; color: var(--muted); font-size: 12.5px;
}
@media (max-width: 640px) {
  .wrap { padding: 14px 12px 56px; }
  h1 { font-size: 28px; }
  nav.rail ol { gap: 6px; }
  nav.rail li { font-size: 12px; padding: 6px 10px; }
  .trail .tabs label { grid-template-columns: 52px 1fr; justify-items: start; text-align: left; }
  .journey .tabs label { min-width: 0; flex: 1 1 42%; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { animation: none !important; transition: none !important; }
}
@media (prefers-contrast: more) {
  :root { --muted: #3a2e26; --line: rgba(40,24,12,.45); }
  nav.rail li, .well, .chip, .checklist label, button.ghost {
    box-shadow: inset 0 0 0 2px var(--ink);
  }
}
""".strip()

# V3 is intentionally a separate visual system while the former CSS remains above
# as migration evidence during the redesign. Only this stylesheet is emitted.
CSS_V3 = r"""
:root {
  color-scheme: light;
  --canvas:#e9ece8; --paper:#f8f7f2; --paper-2:#efeee7; --ink:#17211f;
  --muted:#66706c; --hair:rgba(23,33,31,.13); --solid:#17211f;
  --aqua:#34bba5; --aqua-pale:#cfece5; --coral:#ee785f; --sun:#f2bc55;
  --blue:#5379d8; --plum:#6e5a8a; --danger:#b84238; --ok:#24755f;
  --shadow:0 28px 80px rgba(27,39,35,.11); --soft:0 10px 30px rgba(27,39,35,.07);
  --sans:"Segoe UI Variable","PingFang SC","Microsoft YaHei UI",sans-serif;
  --serif:"Iowan Old Style","Songti SC","STSong",serif;
  --mono:"Cascadia Code","Sarasa Mono SC",Consolas,monospace;
}
@media(prefers-color-scheme:dark){:root{
  color-scheme:dark; --canvas:#101715; --paper:#17201e; --paper-2:#1d2926;
  --ink:#edf2ed; --muted:#a7b3ad; --hair:rgba(237,242,237,.13); --solid:#edf2ed;
  --aqua:#56d5bd; --aqua-pale:#203f39; --coral:#ff947d; --sun:#f4c76d;
  --blue:#7899ec; --plum:#b2a0cb; --danger:#ff968c; --ok:#65d1ad;
  --shadow:0 28px 80px rgba(0,0,0,.35); --soft:0 10px 30px rgba(0,0,0,.22);
}}
*{box-sizing:border-box} html,body{margin:0;min-height:100%} html{scroll-behavior:smooth}
main,.sheet,.index,nav.rail,nav.rail ol,.switcher,.stamps label{min-width:0;max-width:100%}
body{font-family:var(--sans);color:var(--ink);line-height:1.72;background:var(--canvas);overflow-wrap:anywhere}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.45;background:
  radial-gradient(circle at 12% 5%,color-mix(in srgb,var(--aqua) 22%,transparent),transparent 26rem),
  radial-gradient(circle at 95% 20%,color-mix(in srgb,var(--sun) 20%,transparent),transparent 24rem),
  repeating-linear-gradient(90deg,transparent 0,transparent calc(8.333% - 1px),var(--hair) calc(8.333% - 1px),var(--hair) 8.333%)}
.skip{position:fixed;left:-999px;top:12px;z-index:99;background:var(--solid);color:var(--paper);padding:9px 15px;border-radius:4px}.skip:focus{left:14px}
.folio{max-width:1320px;margin:0 auto;padding:24px}.atlas{display:grid;grid-template-columns:258px minmax(0,1fr);min-height:calc(100vh - 48px);background:var(--paper);border:1px solid var(--hair);box-shadow:var(--shadow)}
.index{position:relative;padding:32px 24px;border-right:1px solid var(--hair);background:color-mix(in srgb,var(--paper-2) 84%,transparent)}
.brand{display:flex;align-items:center;gap:12px;font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.brand .illu{width:38px;height:38px;flex:none}
.index-rule{height:1px;background:var(--ink);opacity:.2;margin:24px 0 18px}.index-label{margin:0 0 12px;color:var(--muted);font-size:10px;letter-spacing:.18em;text-transform:uppercase}
nav.rail ol{display:grid;gap:1px;margin:0;padding:0;list-style:none}
nav.rail li{position:relative;padding:8px 5px;color:var(--muted);font-size:11.5px;line-height:1.35;border-bottom:1px solid var(--hair)}
nav.rail li.current{margin:3px -9px;padding:10px 13px;color:var(--paper);background:var(--solid);border:0}
.nav-hint{margin:18px 0 0;color:var(--muted);font-size:10.5px;line-height:1.6}
.sheet{min-width:0;padding:0 0 42px}.mast{position:relative;min-height:318px;padding:46px clamp(28px,6vw,78px) 38px;overflow:hidden;border-bottom:1px solid var(--hair);display:grid;align-content:end}
.mast:before{content:"";position:absolute;right:-7%;top:-42%;width:50%;aspect-ratio:1;border:1px solid var(--hair);border-radius:50%;box-shadow:0 0 0 38px transparent,0 0 0 39px var(--hair),0 0 0 88px transparent,0 0 0 89px var(--hair)}
.mast:after{content:attr(data-chapter);position:absolute;right:5%;bottom:-.22em;color:color-mix(in srgb,var(--aqua) 17%,transparent);font:800 clamp(120px,21vw,250px)/1 var(--serif);letter-spacing:-.09em}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 19px;position:relative;z-index:1;color:var(--coral);font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.eyebrow:before{content:"";width:34px;height:2px;background:currentColor}
h1{position:relative;z-index:1;max-width:720px;margin:0;font:650 clamp(38px,7vw,76px)/1.04 var(--serif);letter-spacing:-.055em}.lede{position:relative;z-index:1;max-width:590px;margin:18px 0 0;color:var(--muted);font-size:16px}
main{display:grid;gap:0;min-width:0}main>section,main>figure,main>.desk-board{margin:0;border-bottom:1px solid var(--hair)}
.well,.warn{position:relative;padding:clamp(30px,5vw,62px) clamp(28px,6vw,78px);background:transparent}.warn{background:color-mix(in srgb,var(--coral) 9%,var(--paper))}
.well:before,.warn:before{content:attr(aria-labelledby);position:absolute;right:24px;top:24px;color:var(--hair);font:10px var(--mono);text-transform:uppercase}
h2{max-width:720px;margin:0 0 22px;font:650 clamp(25px,3.2vw,38px)/1.15 var(--serif);letter-spacing:-.025em}h3{margin:12px 0 7px;font-size:15px}p{max-width:760px;margin:0 0 12px}p:last-child{margin-bottom:0}strong{font-weight:750}
code{font-family:var(--mono);font-size:.88em;padding:.12em .38em;border-radius:3px;background:color-mix(in srgb,var(--blue) 12%,var(--paper));word-break:break-word}pre{overflow:auto;margin:14px 0;padding:18px;border-left:4px solid var(--aqua);background:var(--solid);color:var(--paper);font:13px/1.65 var(--mono)}
.scene{position:relative;overflow:hidden;margin:0;background:var(--paper-2)}.scene .illu{display:block;width:100%;height:auto}.scene figcaption,.cap{padding:12px 20px;color:var(--muted);font-size:11px;letter-spacing:.035em;border-top:1px solid var(--hair)}
.desk-board>.scene{border-bottom:1px solid var(--hair)}.desk-board>.well{border-bottom:0}
.switcher{display:grid;gap:18px;min-width:0}.switcher .tabs{display:flex;flex-wrap:wrap;gap:0;border-bottom:1px solid var(--hair)}.switcher .tabs label{position:relative;cursor:pointer;padding:10px 14px;color:var(--muted);font-size:12px;border-bottom:3px solid transparent;margin-bottom:-1px}.switcher .tabs input[type=radio]{position:absolute;width:1px;height:1px;margin:-1px;clip:rect(0,0,0,0);overflow:hidden}.switcher .tabs label:has(:checked){color:var(--ink);border-color:var(--aqua);font-weight:750}.switcher .tabs label:has(:focus-visible){outline:3px solid var(--sun);outline-offset:2px}.switcher .panel{display:none;min-width:0;padding:20px;background:var(--paper-2);border-left:3px solid var(--aqua)}
.switcher:has(#tab-a:checked) .panel-a,.switcher:has(#tab-b:checked) .panel-b,.switcher:has(#tab-c:checked) .panel-c,.switcher:has(#tab-d:checked) .panel-d,.switcher:has(#pv-openai:checked) .panel-openai,.switcher:has(#pv-deepseek:checked) .panel-deepseek,.switcher:has(#pv-qwen:checked) .panel-qwen,.switcher:has(#pv-kimi:checked) .panel-kimi,.switcher:has(#pv-silicon:checked) .panel-silicon,.switcher:has(#pv-openrouter:checked) .panel-openrouter,.switcher:has(#pv-ollama:checked) .panel-ollama,.switcher:has(#pv-custom:checked) .panel-custom,.switcher:has(#j-you:checked) .panel-you,.switcher:has(#j-desk:checked) .panel-desk,.switcher:has(#j-post:checked) .panel-post,.switcher:has(#j-clerk:checked) .panel-clerk,.switcher:has(#j-key:checked) .panel-key,.switcher:has(#j-back:checked) .panel-back{display:block}
.desk-board .zone{opacity:.28;transition:opacity .25s,filter .25s}.desk-board:has(#tab-a:checked) .zone-chat,.desk-board:has(#tab-b:checked) .zone-tools,.desk-board:has(#tab-c:checked) .zone-drawer,.desk-board:has(#tab-d:checked) .zone-shelf{opacity:1;filter:drop-shadow(0 8px 12px color-mix(in srgb,var(--aqua) 25%,transparent))}
.lane{display:grid;gap:1px;background:var(--hair);border:1px solid var(--hair)}.lane.two{grid-template-columns:repeat(2,minmax(0,1fr))}.chip{position:relative;min-width:0;padding:22px;background:var(--paper)}.chip:after{content:"↗";position:absolute;right:15px;top:13px;color:var(--aqua);font-size:13px}.chip h3{margin:0 24px 8px 0;font:650 16px var(--serif)}.chip p{margin:0;color:var(--muted);font-size:12.5px}
.timeline{display:grid;margin-top:18px;border-top:1px solid var(--hair)}.t-item{display:grid;grid-template-columns:38px 1fr;gap:12px;padding:14px 0;border-bottom:1px solid var(--hair);counter-increment:step}.timeline{counter-reset:step}.t-item .dot{width:26px;height:26px;margin:0;border:1px solid var(--hair);border-radius:50%;display:grid;place-items:center}.t-item .dot:after{content:counter(step,decimal-leading-zero);font:9px var(--mono);color:var(--coral)}
.checklist{display:grid;gap:1px;background:var(--hair);border:1px solid var(--hair);counter-reset:done}.checklist label{display:grid;grid-template-columns:22px 1fr;gap:10px;padding:13px 15px;background:var(--paper);font-size:13px}.checklist input{margin-top:4px;accent-color:var(--aqua)}.checklist input:checked{counter-increment:done}.progress-out:after{content:"已完成 " counter(done) " 项";font:11px var(--mono);color:var(--ok)}
.status{min-height:2em;padding:12px 15px;background:var(--paper-2);border-left:3px solid var(--sun);font-size:13px}.status[data-tone=bad]{border-color:var(--danger)}.status[data-tone=ok]{border-color:var(--ok)}
.field{display:grid;gap:5px;margin:12px 0}.field span{color:var(--muted);font:11px var(--mono)}input[type=text],input[type=password],select,textarea{width:100%;padding:12px 13px;border:1px solid var(--hair);border-radius:0;background:var(--paper);color:var(--ink);font:13px var(--mono)}button{border:0;border-radius:0;padding:11px 17px;background:var(--solid);color:var(--paper);font:700 12px var(--sans);cursor:pointer}button.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--hair)}.row{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--sun);outline-offset:2px}
details.fold{margin-top:12px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}details.fold summary{cursor:pointer;padding:13px 3px;list-style:none;font-weight:700;font-size:13px}details.fold summary:after{content:"＋";float:right;color:var(--aqua)}details.fold[open] summary:after{content:"−"}details.fold>p{padding:0 3px 14px;color:var(--muted);font-size:13px}
.quiz{display:grid;gap:1px;background:var(--hair);border:1px solid var(--hair)}.q{padding:18px;background:var(--paper)}.q fieldset{border:0;margin:0;padding:0}.q legend{margin-bottom:10px;font-weight:750}.q label{font-size:13px}.q input{accent-color:var(--aqua)}
.wizard .pane{display:none;min-height:180px;padding:20px;background:var(--paper-2);border-left:3px solid var(--blue)}.wizard .pane.is-on{display:block}.lights{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.light{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--hair);font:11px var(--mono)}.light i{width:8px;height:8px;border-radius:50%}.light.go i{background:var(--ok)}.light.wait i{background:var(--sun)}.light.stop i{background:var(--danger)}
.stamps.tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--hair)}.stamps label{text-align:center;border-right:1px solid var(--hair);border-bottom:1px solid var(--hair);margin:0!important}.stamps label:has(:checked){background:var(--solid);color:var(--paper);border-bottom-color:var(--solid)}
.journey .tabs label{flex:1 1 120px;text-align:center}.journey:has(#j-you:checked) .jp-you,.journey:has(#j-desk:checked) .jp-desk,.journey:has(#j-post:checked) .jp-post,.journey:has(#j-clerk:checked) .jp-clerk,.journey:has(#j-key:checked) .jp-key,.journey:has(#j-back:checked) .jp-back{filter:drop-shadow(0 0 8px var(--sun))}
.trail .tabs{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--hair)}.trail .tabs label{display:grid;gap:8px;text-align:left;border-right:1px solid var(--hair);margin:0;padding:18px 14px}.trail .emoji{display:grid;place-items:center;width:34px;height:34px;background:var(--aqua-pale);filter:grayscale(.2)}.trail .panel{border-left:0;border-top:3px solid var(--aqua)}
.foot{padding:22px clamp(28px,6vw,78px);color:var(--muted);font-size:10px;border-top:1px solid var(--hair)}
@media(max-width:900px){.folio{padding:0}.atlas{grid-template-columns:1fr;border:0;min-height:100vh}.index{position:relative;padding:14px 18px;border-right:0;border-bottom:1px solid var(--hair)}.index-rule,.index-label,.nav-hint{display:none}.brand{margin-bottom:10px}nav.rail ol{display:flex;overflow:auto;scrollbar-width:thin;gap:6px;padding-bottom:4px}nav.rail li{flex:0 0 auto;padding:7px 10px;border:1px solid var(--hair)}nav.rail li:before{display:none}nav.rail li.current{margin:0;padding:7px 10px}.mast{min-height:280px}.mast:after{font-size:150px}}
@media(max-width:620px){.mast{min-height:250px;padding:34px 20px 28px}.mast:before{width:80%;right:-36%}h1{font-size:39px}.lede{font-size:14px}.well,.warn{padding:34px 20px}.lane.two{grid-template-columns:1fr}.stamps.tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.trail .tabs{grid-template-columns:1fr 1fr}.trail .tabs label{padding:13px 10px}.scene figcaption{font-size:10px}.journey .tabs label{flex:1 1 44%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important;transition:none!important}}
@media(prefers-contrast:more){:root{--hair:currentColor}.atlas,.lane,.quiz,input,select,textarea{border-width:2px}}
""".strip()

JS = r"""
(function () {
  var reduce = false;
  try {
    reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (err) {}
  document.documentElement.classList.toggle("reduce-motion", reduce);

  function $(id) { return document.getElementById(id); }
  function setStatus(el, message, tone) {
    if (!el) return;
    el.textContent = message;
    if (tone) el.setAttribute("data-tone", tone);
    else el.removeAttribute("data-tone");
  }
  function looksLikePlaceholder(value) {
    var s = String(value || "").toLowerCase();
    return !s || /x{4,}|your-key|example|示例|••••|····|\*{4,}|placeholder/.test(s);
  }

  document.querySelectorAll("[data-wizard]").forEach(function (root) {
    var panes = [].slice.call(root.querySelectorAll("[data-pane]"));
    var index = 0;
    function show() {
      panes.forEach(function (pane, i) {
        pane.classList.toggle("is-on", i === index);
        pane.hidden = i !== index;
      });
      var live = root.querySelector("[data-wizard-live]");
      if (live) live.textContent = "第 " + (index + 1) + " / " + panes.length + " 步";
    }
    root.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-wizard-next],[data-wizard-prev]");
      if (!btn || !root.contains(btn)) return;
      if (btn.hasAttribute("data-wizard-next")) index = Math.min(panes.length - 1, index + 1);
      else index = Math.max(0, index - 1);
      show();
    });
    show();
  });

  var checkBtn = $("sim-check");
  if (checkBtn) {
    checkBtn.addEventListener("click", function () {
      var provider = ($("sim-provider") || {}).value || "";
      var base = (($("sim-base") || {}).value || "").trim();
      var model = (($("sim-model") || {}).value || "").trim();
      var key = (($("sim-key") || {}).value || "").trim();
      var out = $("sim-result");
      if (!base) return setStatus(out, "还没写邮局门牌。Base URL 空着，信不知道往哪送。", "bad");
      if (/\/chat\/completions\/?$/i.test(base) || /\/completions\/?$/i.test(base)) {
        return setStatus(out, "门牌多写了一截。通常填到 /v1 为止，不要带 /chat/completions。", "bad");
      }
      if (!/^https?:\/\//i.test(base)) {
        return setStatus(out, "门牌要以 http:// 或 https:// 开头。家里的 Ollama 常见 http://localhost:11434/v1。", "bad");
      }
      if (!model) return setStatus(out, "没写找哪位员工。模型名必须和控制台里的全名一模一样。", "bad");
      if (/\s/.test(key)) return setStatus(out, "钥匙里不该有空格。从控制台复制后，不要手动折行。", "bad");
      if (looksLikePlaceholder(key)) {
        return setStatus(out, "这是占位示例，不是真钥匙。请到服务商网站自己生成，并且永远不要把真钥匙发给任何人。", "bad");
      }
      if (key.length < 8) return setStatus(out, "这串太短，不太像一把 API Key。", "bad");
      var extra = provider ? ("你选的是「" + provider + "」。") : "";
      setStatus(out, extra + "格式看起来像样。注意：这一页不会联网，也不会保存。请打开「设置 → LLM」，粘贴真实值后点「运行测试」。", "ok");
    });
  }

  var quizBtn = $("quiz-grade");
  if (quizBtn) {
    quizBtn.addEventListener("click", function () {
      var form = $("welcome-quiz");
      var out = $("quiz-result");
      if (!form) return;
      var items = [].slice.call(form.querySelectorAll("[data-answer]"));
      var total = items.length;
      var right = 0;
      var missing = 0;
      items.forEach(function (item) {
        var expect = item.getAttribute("data-answer");
        var picked = item.querySelector("input:checked");
        if (!picked) missing += 1;
        else if (picked.value === expect) right += 1;
      });
      if (missing) setStatus(out, "还有 " + missing + " 题没选。慢慢来。", "bad");
      else if (right === total) setStatus(out, "全对。工作台的地形你已经摸清了。", "ok");
      else setStatus(out, "对了 " + right + " / " + total + "。错的那些回「名词」那一篇再对一下。", "bad");
    });
  }

  var countBox = $("check-live");
  var checks = document.querySelectorAll(".checklist input[type='checkbox']");
  function recount() {
    var n = 0;
    checks.forEach(function (box) { if (box.checked) n += 1; });
    if (countBox) countBox.textContent = "这一页你勾了 " + n + " / " + checks.length + " 件小事。";
  }
  checks.forEach(function (box) { box.addEventListener("change", recount); });
  recount();

  var reveal = $("toggle-key");
  var keyInput = $("sim-key");
  if (reveal && keyInput) {
    reveal.addEventListener("click", function () {
      var hide = keyInput.getAttribute("type") === "text";
      keyInput.setAttribute("type", hide ? "password" : "text");
      reveal.textContent = hide ? "显示" : "隐藏";
    });
  }

  var decoder = $("decode-run");
  if (decoder) {
    decoder.addEventListener("click", function () {
      var raw = (($("decode-input") || {}).value || "").toLowerCase();
      var out = $("decode-result");
      if (!raw.trim()) return setStatus(out, "先贴一段报错原文（请打码钥匙）。", "bad");
      if (/401|unauthorized|invalid api key|incorrect api key/.test(raw)) {
        return setStatus(out, "多半是钥匙不对、过期，或复制少了字符。换一把新 Key，确认服务商和 Base URL 是一家。", "bad");
      }
      if (/404|model_not_found|does not exist|unknown model/.test(raw)) {
        return setStatus(out, "模型名对不上。到服务商控制台复制完整名字，不要凭记忆写简称。", "bad");
      }
      if (/ssl|certificate|certif/.test(raw)) {
        return setStatus(out, "证书或代理问题。检查系统时间；本地模型一般走 http://localhost。", "bad");
      }
      if (/timeout|timed out|network|connect|enotfound|dns/.test(raw)) {
        return setStatus(out, "信没送到邮局：Base URL 写错、没网、或本地服务没开。", "bad");
      }
      if (/empty|no content|max tokens|finish_reason/.test(raw)) {
        return setStatus(out, "有的推理模型把额度花在「心里想」上，表面上像空回复。换一个对话模型，或看诊断日志。", "bad");
      }
      setStatus(out, "没有命中常见模板。对照「设置 → LLM → 诊断」里的请求目标。", "bad");
    });
  }
})();
""".strip()


def wrap_page(
    *,
    title: str,
    kicker: str,
    lede: str,
    nav_html: str,
    body: str,
    page_id: str,
) -> str:
    safe_title = escape(title)
    chapter = title.split(" ", 1)[0]
    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN" data-welcome-pack="v3" data-welcome-page="'
        + escape(page_id, quote=True)
        + '">\n'
        "<head>\n"
        '  <meta charset="utf-8">\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '  <meta http-equiv="Content-Security-Policy" content="' + LIBRARY_HTML_CSP + '">\n'
        '  <meta name="referrer" content="no-referrer">\n'
        "  <title>" + safe_title + "</title>\n"
        "  <style>\n" + CSS_V3 + "\n  </style>\n"
        "</head>\n"
        "<body>\n"
        '  <a class="skip" href="#main">跳到正文</a>\n'
        '  <div class="folio"><div class="atlas">\n'
        '    <aside class="index">\n'
        '      <div class="brand">' + brand_mark() + "<span>Knorvia Field Guide</span></div>\n"
        '      <div class="index-rule"></div><p class="index-label">Contents / 10 chapters</p>\n'
        + nav_html
        + "\n    </aside>\n"
        '    <div class="sheet">\n'
        '      <header class="mast" data-chapter="' + escape(chapter, quote=True) + '">\n'
        '        <p class="eyebrow">' + escape(kicker) + "</p>\n"
        "        <h1>" + safe_title + "</h1>\n"
        '        <p class="lede">' + escape(lede) + "</p>\n      </header>\n"
        '      <main id="main">\n' + body + "\n      </main>\n"
        '      <footer class="foot">\n'
        "      <p>离线自包含的导览。预览在隔离沙箱里运行；删掉整个文件夹后，Knorvia 不会擅自再种一套。</p>\n"
        "      </footer>\n"
        "    </div>\n"
        "  </div></div>\n"
        "  <script>\n" + JS + "\n  </script>\n"
        "</body>\n"
        "</html>\n"
    )
