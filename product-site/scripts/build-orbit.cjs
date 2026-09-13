const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..');
const React = require(path.join(repo, 'web/node_modules/react'));
const { renderToStaticMarkup } = require(path.join(repo, 'web/node_modules/react-dom/server'));
const icons = require(path.join(repo, 'web/node_modules/lucide-react'));
const features = require('./orbit-content.cjs');
const icon = name => renderToStaticMarkup(React.createElement(icons[name], { 'aria-hidden': true, focusable: false, strokeWidth: 1.6 }));
const G = 'https://github.com/accomplish-zrh/Knorvia';
const external = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
const featureSections = features.map(f => `<article id="${f.id}" class="fallback-feature"><img src="assets/orbit/${f.id}.webp" width="1536" height="1024" loading="lazy" alt="${f.label}概念艺术"><div><h2>${f.label}</h2><p>${f.description}</p><a href="assets/${f.screenshot}-1440.webp">查看实机画面</a></div></article>`).join('');
const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Knorvia · 有个想法，就从这里开始。</title>
<meta name="description" content="Knorvia 是个人 AI 工作台。聊想法，做图像和视频，把资料放在手边；连接自己的模型，让助手一起推进工作。">
<meta name="theme-color" content="#f4f7f8"><meta name="color-scheme" content="light"><link rel="canonical" href="https://knorvia.xyz/">
<meta property="og:title" content="Knorvia · 有个想法，就从这里开始。"><meta property="og:description" content="聊想法，做图像和视频，也把用到的资料放在手边。"><meta property="og:type" content="website"><meta property="og:url" content="https://knorvia.xyz/"><meta property="og:locale" content="zh_CN"><meta property="og:image" content="https://knorvia.xyz/assets/social-preview.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="favicon.ico" sizes="any"><link rel="apple-touch-icon" href="assets/brand.png">
<link rel="preload" href="assets/fonts/geist-400.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="assets/fonts/geist-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/knorvia-hand.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="orbit.css?v=20260912-7"><script src="orbit-app.js?v=20260912-7" defer></script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Knorvia', url: 'https://knorvia.xyz/', applicationCategory: 'ProductivityApplication', operatingSystem: 'Windows', license: G + '/blob/main/LICENSE', downloadUrl: G + '/releases/latest' })}</script>
</head><body>
<a class="skip-link" href="#feature-dock">跳到功能导航</a>
<header class="site-header">
 <a class="brand" href="#" aria-label="Knorvia 首页"><img src="assets/brand.png" alt="" width="38" height="38"><span>Knorvia</span></a>
 <div class="header-actions"><button class="quiet-button about-button" data-open-about>关于</button><a href="${G}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 源码"><span class="source-label">GitHub</span>${icon('Github')}</a><button class="download-button luminous-button" data-open-download><span>下载应用</span> ${icon('ArrowDownToLine')}</button></div>
</header>
<main>
 <section class="universe" aria-labelledby="hero-title">
  <div class="scene-fallback" aria-hidden="true"><img src="assets/brand-relief.webp" width="1254" height="1254" alt=""></div>
  <canvas id="orbit-canvas" aria-hidden="true"></canvas>
  <div class="scene-atmosphere" aria-hidden="true"><div class="sun-shaft sun-shaft-wide"></div><div class="sun-shaft sun-shaft-fine"></div></div>
  <div class="orbit-labels">${features.map(f => `<button tabindex="-1" aria-hidden="true" class="orbit-label" data-feature="${f.id}"><span>${f.label}</span>${icon('ArrowUpRight')}</button>`).join('')}</div>
  <div class="hero-copy"><span class="hero-eyebrow">个人 AI 工作台</span><h1 id="hero-title"><span class="hero-thought">有个想法，</span><span class="hero-outcome">就从这里开始。</span></h1><p>聊想法，做图像和视频，也把用到的资料放在手边。</p></div>
  <p id="scene-status" class="scene-status" role="status">正在展开你的空间</p>
  <div class="scene-controls"><button class="icon-button" id="motion-toggle" aria-pressed="false" aria-label="暂停动效" title="暂停动效"><span class="pause-glyph">${icon('Pause')}</span><span class="play-glyph" hidden>${icon('Play')}</span></button><button class="icon-button" id="reset-view" aria-label="重置视角" title="重置视角">${icon('RotateCcw')}</button></div>
  <div class="scene-caption" aria-hidden="true"><span class="scene-indicator"></span><span id="scene-caption-text">自由探索</span><span class="scene-caption-rule"></span><span class="scene-caption-count">06 个创作入口</span></div>
  <div class="explore-bar"><p class="interaction-hint" id="interaction-hint">拖动照片旋转或收放 · 轻点查看详情</p><nav class="feature-dock" id="feature-dock" aria-label="探索 Knorvia 功能"><span class="dock-selection" aria-hidden="true" hidden></span>${features.map(f => `<a href="#${f.id}" data-feature="${f.id}">${icon(f.icon)}<span>${f.label}</span></a>`).join('')}</nav></div>
  <a class="next-page" href="#site-footer">更多信息 ${icon('ArrowDown')}</a>
 </section>
 <div class="fallback-contents">${featureSections}</div>

</main>
<footer class="site-footer" id="site-footer"><div class="footer-main"><div class="footer-brand"><span>Knorvia</span><p class="handwritten-note">给好奇心，留个位置。</p></div><nav aria-label="产品资源">${external(G+'/blob/main/README.md','使用文档')}${external(G+'/releases','发行更新')}${external(G,'开放源码')}${external(G+'/issues','反馈建议')}</nav><button class="download-button luminous-button" data-open-download><span>下载应用</span>${icon('ArrowDownToLine')}</button></div><div class="footer-bottom"><span>在自己的电脑上，把想做的事接着做。</span><div class="footer-minor"><span class="service-links">${external('https://api.knorvia.xyz','中转')}<span aria-hidden="true">·</span>${external('https://wzyp.cn/shop/future','小铺')}</span>${external(G+'/blob/main/LICENSE','Apache-2.0')}</div></div></footer>
<dialog class="feature-dialog" id="feature-dialog" aria-labelledby="detail-title">
 <div class="detail-shell">
  <header class="detail-header"><span class="detail-category" id="detail-category"></span><div class="detail-navigation"><small id="detail-page-count" aria-hidden="true"></small><button class="icon-button" data-page-previous aria-label="介绍上一页">${icon('ChevronLeft')}</button><button class="icon-button" data-page-next aria-label="介绍下一页">${icon('ChevronRight')}</button><span></span><button class="icon-button" data-close-dialog aria-label="关闭详情">${icon('X')}</button></div></header>
  <div class="detail-body" tabindex="0" role="region" aria-labelledby="detail-title">
   <div class="detail-copy"><h2 id="detail-title"></h2><p id="detail-description"></p></div>
   <div class="detail-visual" id="detail-visual"><button class="screenshot-button" id="open-screenshot" aria-label="放大实机画面"><img id="detail-screenshot" width="1440" height="920" decoding="async" alt=""><span class="preview-state"><span class="preview-loading">实机画面载入中</span><span class="preview-failed">画面暂未载入，轻点重试</span></span><span class="preview-cue luminous-button">${icon('Expand')}<span>查看实机</span></span></button><p>开发版实机画面<span>白色 · 原生玻璃</span></p></div>
   <div class="detail-tags" id="detail-tags"></div>
   <div id="detail-reading" hidden><div id="detail-features"></div><aside class="detail-example"><div class="example-heading"><span>可以这样开始</span><button id="copy-example" class="copy-example">${icon('Copy')}<span id="copy-example-label">复制示例</span></button></div><p id="detail-example-text"></p><span id="example-copy-status" class="visually-hidden" role="status"></span></aside></div>
   <p class="detail-note" id="detail-note"></p>
  </div>
  <nav class="detail-pager" id="detail-pager" aria-label="当前功能的介绍页"></nav>
  <span class="visually-hidden" id="detail-page-status" role="status" aria-live="polite"></span>
 </div>
</dialog>
<dialog class="zoom-dialog" id="zoom-dialog" aria-label="放大的实机画面"><div class="zoom-shell"><header class="zoom-header"><span id="zoom-title">实机画面</span><div class="zoom-tools" role="group" aria-label="画面缩放"><button class="icon-button" id="zoom-out" aria-label="缩小画面">${icon('Minus')}</button><output id="zoom-level" aria-live="polite">100%</output><button class="icon-button" id="zoom-in" aria-label="放大画面">${icon('Plus')}</button><button class="zoom-fit" id="zoom-fit" aria-pressed="true">适应窗口</button></div><button class="icon-button zoom-close" data-close-dialog aria-label="关闭大图">${icon('X')}</button></header><div class="zoom-stage" id="zoom-stage" tabindex="0" role="region" aria-label="实机截图，可放大并滚动查看"><div class="zoom-plane"><img id="zoom-screenshot" width="1440" height="920" draggable="false" alt=""></div></div><footer class="zoom-footer"><span>白色 · 原生玻璃</span><span id="zoom-hint">放大后可拖动画面</span></footer></div></dialog>
<dialog class="info-dialog" id="download-dialog" aria-labelledby="download-title"><div class="info-shell"><button class="icon-button info-close" data-close-dialog aria-label="关闭下载">${icon('X')}</button><img class="download-brand" src="assets/brand.png" width="88" height="88" alt=""><span class="download-platform">Windows · v1.0.0</span><h2 id="download-title">把 Knorvia 带到你的桌面。</h2><p>在 Windows 电脑上安装，连接自己的模型服务，开始下一件想做的事。</p><a class="download-button luminous-button full" href="${G}/releases/download/v1.0.0/Knorvia-1.0.0-setup.exe"><span>下载 Windows 安装包</span> ${icon('ArrowDownToLine')}</a><a class="portable-link" href="${G}/releases/download/v1.0.0/Knorvia-1.0.0-portable.zip">下载便携版 ${icon('ArrowUpRight')}</a><div class="download-handoff"><button class="copy-example" id="copy-download-link">${icon('Copy')}<span>复制下载页链接</span></button><p id="download-copy-status" role="status">稍后在电脑上继续。</p><input id="download-page-link" aria-label="下载页链接" value="https://knorvia.xyz/#install" readonly hidden></div><p class="release-note">当前可下载的是 v1.0.0。网站画面来自开发版，v1.0.0 的实际功能请以发行说明为准。</p>${external(G + '/releases/latest', '发行说明与校验文件 ↗')}</div></dialog>
<dialog class="info-dialog" id="about-dialog" aria-labelledby="about-title"><div class="info-shell"><button class="icon-button info-close" data-close-dialog aria-label="关闭关于">${icon('X')}</button><h2 id="about-title">给想做的事，留个工作台。</h2><p>Knorvia 是你的个人 AI 工作台。和助手聊想法、看文件、做作品，再按自己的习惯选择模型与工具。</p><div class="about-facts"><h3>本地优先</h3><p>在自己的电脑上管理资料与工作记录。使用在线模型或联网工具时，相关内容会发送到你配置的服务。</p><h3>模型由你连接</h3><p>连接自己选择的模型服务。客户端不内置模型钱包，可用能力、额度和费用由所选服务商决定。</p><h3>按需要，添些新本领</h3><p>通过 Skill、插件和 CLI 接入需要的工具，按当前任务选用文档、学习或创作流程。</p></div><div class="about-links">${external(G, 'GitHub 源码')}${external(G + '/blob/main/THIRD_PARTY_NOTICES.md', '第三方声明')}${external('https://api.knorvia.xyz', '模型中转服务')}${external('https://wzyp.cn/shop/future', '小铺')}</div></div></dialog>
<script id="feature-data" type="application/json">${JSON.stringify(features).replace(/</g, '\\u003c')}</script>
<noscript><style>.scene-controls,.orbit-labels,.scene-status,.interaction-hint,.about-button,[data-open-about]{display:none}.download-button[data-open-download]{display:none}.universe{min-height:100svh;height:100dvh}.fallback-contents{display:grid}.site-footer{position:relative}.hero-copy{opacity:1;transform:none}</style><p class="noscript-download">${external(G + '/releases/latest', '前往 GitHub 下载 Knorvia')}</p></noscript>
</body></html>`;
fs.writeFileSync(path.join(root, 'index.html'), html);
fs.copyFileSync(path.join(root, 'node_modules/three/build/three.module.min.js'), path.join(root, 'assets/three.module.js'));
const room = fs.readFileSync(path.join(root, 'node_modules/three/examples/jsm/environments/RoomEnvironment.js'), 'utf8').replace("from 'three'", "from './three.module.js'");
fs.writeFileSync(path.join(root, 'assets/RoomEnvironment.js'), room);
console.log('Built Knorvia spatial single-page gallery with six conceptual covers and real product details.');
