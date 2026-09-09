'use strict';

const { palettes } = require('./window-appearance');
const { TITLEBAR_HEIGHT, WINDOW_CORNER_RADIUS } = require('./window-chrome');

// The native loading document is self-contained, so its first frame needs no
// renderer, network, font download or timer that delays application readiness.
function startupScreen({ logo, theme = 'snow', frost = false, reducedMotion = false } = {}) {
  const palette = palettes[Object.hasOwn(palettes, theme) ? theme : 'snow'];
  const c = palette.colors;
  if (typeof logo !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(logo)) throw new Error('A local base64 logo is required');
  return `<!doctype html><html lang="zh-CN" data-reduced-motion="${reducedMotion === true}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Knorvia</title>
  <style>
    :root { color-scheme:${palette.dark ? 'dark' : 'light'}; --bg:${c.bg}; --fg:${c.ink}; --muted:${c.muted}; --accent:${c.lilac}; }
    * { box-sizing:border-box; }
    html,body { width:100%; height:100%; margin:0; overflow:hidden; border-radius:${WINDOW_CORNER_RADIUS}px; }
    body { display:grid; place-items:center; color:var(--fg); background:${frost ? 'transparent' : 'var(--bg)'}; font-family:'Segoe UI Variable',system-ui,sans-serif; user-select:none; }
    .chrome { position:fixed; inset:0 0 auto; height:${TITLEBAR_HEIGHT}px; -webkit-app-region:drag; z-index:10; }
    .caption { position:absolute; top:0; right:0; height:100%; display:none; -webkit-app-region:no-drag; }
    .caption button { width:46px; height:100%; border:0; background:transparent; color:var(--fg); font-size:12px; cursor:pointer; }
    .caption button:hover { background:#7f7f7f24; }.caption .close:hover { background:#e81123; color:white; }
    .scene { position:relative; display:flex; flex-direction:column; align-items:center; padding:32px; isolation:isolate; }
    .light { position:absolute; z-index:-1; width:400px; height:320px; top:-62px; pointer-events:none; border-radius:50%;
      background:radial-gradient(ellipse at 35% 40%,#9ccebb2e,transparent 60%),radial-gradient(ellipse at 70% 58%,#bcb0d82b,transparent 60%); mask-image:radial-gradient(ellipse,#000 30%,transparent 72%);
      animation:light-arrival 1100ms cubic-bezier(.16,1,.3,1) both; }
    .emblem { width:100px; height:100px; position:relative; display:grid; place-items:center; perspective:600px; }
    .contour { position:absolute; inset:0; width:100%; height:100%; color:var(--accent); opacity:.4; animation:contour-in 900ms 120ms ease-out both; }
    .contour rect { stroke-dasharray:100; stroke-dashoffset:0; animation:line-draw 1050ms 180ms cubic-bezier(.16,1,.3,1) both; }
    .mark { position:relative; width:76px; height:76px; border-radius:19px; overflow:hidden; transform-origin:50% 80%;
      box-shadow:0 12px 24px #0000000c,0 2px 5px #00000008; animation:mark-arrival 780ms cubic-bezier(.16,1,.3,1) both; }
    .mark img { display:block; width:100%; height:100%; object-fit:contain; }
    .sheen { position:absolute; inset:-50%; background:linear-gradient(110deg,transparent 37%,#ffffff80 50%,transparent 63%); opacity:0; pointer-events:none; animation:light-pass 1000ms 160ms cubic-bezier(.22,1,.36,1) both; }
    h1 { margin:22px 0 0; font-size:25px; font-weight:590; letter-spacing:-.035em; line-height:1.3; animation:word-arrival 640ms 110ms cubic-bezier(.16,1,.3,1) both; }
    .status { margin:12px 0 0; font-size:12px; line-height:1.5; color:var(--muted); animation:word-arrival 640ms 190ms cubic-bezier(.16,1,.3,1) both; }
    .activity { margin-top:25px; width:64px; height:2px; border-radius:3px; overflow:hidden; background:color-mix(in srgb,var(--fg) 7%,transparent); animation:word-arrival 640ms 260ms ease-out both; }
    .activity i { display:block; width:35px; height:100%; background:linear-gradient(90deg,transparent,var(--accent),transparent); transform:translateX(-36px); animation:activity-scan 2100ms 900ms ease-in-out infinite; }
    @keyframes mark-arrival { from { opacity:0; transform:translateY(12px) rotateX(12deg) rotateY(-14deg) rotateZ(-5deg) scale(.9); } 72% { opacity:1; transform:translateY(-1px) rotateX(0) rotateY(0) rotateZ(.5deg) scale(1.012); } to { opacity:1; transform:none; } }
    @keyframes light-arrival { from { opacity:0; transform:scale(.8); } to { opacity:1; transform:scale(1); } }
    @keyframes contour-in { from { opacity:0; transform:scale(.93); } to { opacity:.4; transform:scale(1); } }
    @keyframes line-draw { from { stroke-dashoffset:100; } to { stroke-dashoffset:0; } }
    @keyframes light-pass { from { transform:translateX(-75%); opacity:0; } 25% { opacity:.8; } to { transform:translateX(75%); opacity:0; } }
    @keyframes word-arrival { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
    @keyframes activity-scan { 0% { transform:translateX(-36px); } 72%,100% { transform:translateX(65px); } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none !important; transform:none !important; }.sheen { display:none; }.activity i { width:100%; opacity:.5; } }
    html[data-reduced-motion="true"] *,html[data-reduced-motion="true"] *::before,html[data-reduced-motion="true"] *::after { animation:none !important; transform:none !important; }
    html[data-reduced-motion="true"] .sheen { display:none; } html[data-reduced-motion="true"] .activity i { width:100%; opacity:.5; }
  </style></head><body>
    <div class="chrome"><div class="caption" id="caption"></div></div>
    <main class="scene" aria-label="Knorvia 正在启动">
      <div class="light" aria-hidden="true"></div>
      <div class="emblem" aria-hidden="true"><svg class="contour" viewBox="0 0 100 100" fill="none"><rect x="2" y="2" width="96" height="96" rx="25" stroke="currentColor" stroke-width=".7" pathLength="100"/></svg><div class="mark"><img src="data:image/png;base64,${logo}" alt=""><span class="sheen"></span></div></div>
      <h1>Knorvia</h1><p class="status" role="status">正在准备你的工作空间</p><div class="activity" aria-hidden="true"><i></i></div>
    </main>
    <script>(function(){
      var chrome=window.knorviaDesktop&&window.knorviaDesktop.chrome;
      if(!chrome||chrome.captionOverlay||chrome.trafficLights)return;
      var caption=document.getElementById('caption');caption.style.display='flex';
      caption.innerHTML='<button id="min" aria-label="Minimize">&#x2013;</button><button id="max" aria-label="Maximize">&#x25A1;</button><button id="cls" class="close" aria-label="Close">&#x2715;</button>';
      document.getElementById('min').onclick=function(){chrome.windowMinimize();};
      document.getElementById('max').onclick=function(){chrome.windowMaximize();};
      document.getElementById('cls').onclick=function(){chrome.windowClose();};
    })();</script>
  </body></html>`;
}

module.exports = { startupScreen };
