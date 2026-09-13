(() => {
  'use strict';
  const assetBase = new URL('.', document.currentScript.src);
  const asset = file => new URL(file, assetBase).href;
  const features = JSON.parse(document.getElementById('feature-data').textContent);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const featureDialog = document.getElementById('feature-dialog');
  const zoomDialog = document.getElementById('zoom-dialog');
  const dialogs = [...document.querySelectorAll('dialog')];
  const motionButton = document.getElementById('motion-toggle');
  const dock = [...document.querySelectorAll('.feature-dock a')];
  const labels = [...document.querySelectorAll('.orbit-label')];
  const closing = new Map();
  const dialogSources = new Map();
  const warmedScreenshots = new Set();
  const dockContainer = document.getElementById('feature-dock');
  const dockSelection = dockContainer.querySelector('.dock-selection');
  let copyTimer, copyToken = 0;
  let chapterAnimations = [];
  const chapterMarker = document.createElement('span');
  chapterMarker.className = 'chapter-marker'; chapterMarker.setAttribute('aria-hidden', 'true');
  let scene, manualPaused = reduced.matches, active = -1, detailPage = 0, galleryIndex = -1, returnFocus, historyOwned = false, universeVisible = true;
  document.body.classList.add('enhanced');

  function syncMotion() {
    const paused = manualPaused || reduced.matches;
    scene?.setPaused(paused || dialogs.some(d => d.open));
    document.documentElement.classList.toggle('dialog-open', dialogs.some(d => d.open));
    document.documentElement.classList.toggle('motion-paused', paused);
    motionButton.setAttribute('aria-pressed', String(paused));
    const label = reduced.matches ? '已遵循系统减少动态效果设置' : paused ? '播放动效' : '暂停动效';
    motionButton.setAttribute('aria-label', label);
    motionButton.title = label;
    motionButton.disabled = reduced.matches;
    motionButton.querySelector('.play-glyph').hidden = !paused;
    motionButton.querySelector('.pause-glyph').hidden = paused;
    syncSceneCaption();
  }

  function syncSceneCaption(index = galleryIndex) {
    const caption = document.getElementById('scene-caption-text');
    if (caption) caption.textContent = index >= 0 ? `探索 · ${features[index].label}`
      : manualPaused || reduced.matches ? '动效已暂停' : '自由探索';
  }

  function showDialog(dialog, source) {
    const exit = closing.get(dialog);
    closing.delete(dialog); exit?.cancel(); dialog.classList.remove('is-closing');
    if (!dialogs.some(d => d.open)) returnFocus = source || document.activeElement;
    if (!dialog.open) {
      dialogSources.set(dialog, source || document.activeElement);
      dialog.showModal();
    }
    syncMotion();
  }

  function dismiss(dialog) {
    if (!dialog.open || closing.has(dialog)) return;
    if (reduced.matches) { dialog.close(); return; }
    // Continue from the visible entrance pose, including an early Escape.
    const pose = getComputedStyle(dialog);
    const from = { opacity: pose.opacity, transform: pose.transform };
    dialog.classList.add('is-closing');
    const exit = dialog.animate([from,
      { opacity: 0, transform: 'translateY(9px) scale(.982)' }],
    { duration: 180, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' });
    closing.set(dialog, exit);
    exit.finished.then(() => {
      if (closing.get(dialog) !== exit) return;
      closing.delete(dialog); dialog.close(); exit.cancel(); dialog.classList.remove('is-closing');
    }).catch(() => {});
  }

  function warmScreenshot(index) {
    const f = features[index];
    if (!f || warmedScreenshots.has(f.screenshot)) return;
    warmedScreenshots.add(f.screenshot);
    const image = new Image(); image.decoding = 'async'; setScreenshotSource(image, f);
  }

  function setScreenshotSource(image, feature) {
    image.sizes = '(max-width: 640px) calc(100vw - 66px), 424px';
    image.srcset = `${asset(`assets/${feature.screenshot}-720.webp`)} 720w, ${asset(`assets/${feature.screenshot}-1440.webp`)} 1440w`;
    image.src = asset(`assets/${feature.screenshot}-1440.webp`);
  }

  function clearFeature() {
    active = -1;
    scene?.select(-1);
    syncDock(galleryIndex);
  }

  function syncDock(index) {
    dock.forEach((a, i) => {
      a.classList.toggle('is-active', i === index);
      if (i === index) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      a.title = i === galleryIndex ? `${features[i].label} · 再次点击查看详情` : `转到${features[i].label}`;
    });
    document.getElementById('interaction-hint').textContent = galleryIndex >= 0
      ? `再点「${features[galleryIndex].label}」查看详情 · 拖动继续探索`
      : '拖动照片旋转或收放 · 轻点查看详情';
    positionDockSelection(index);
    syncSceneCaption(index);
  }

  function positionDockSelection(index = active >= 0 ? active : galleryIndex) {
    dockSelection.hidden = index < 0;
    if (index < 0) return;
    const link = dock[index];
    dockSelection.style.width = link.offsetWidth + 'px';
    dockSelection.style.height = link.offsetHeight + 'px';
    dockSelection.style.transform = `translate3d(${link.offsetLeft}px,${link.offsetTop}px,0)`;
  }
  const dockObserver = new ResizeObserver(() => positionDockSelection());
  dockObserver.observe(dockContainer);
  window.addEventListener('pagehide', e => { if (!e.persisted) dockObserver.disconnect(); });

  function renderFeature(index) {
    active = index;
    const f = features[index];
    document.getElementById('detail-category').textContent = f.label;
    const screenshot = document.getElementById('detail-screenshot');
    document.getElementById('open-screenshot').classList.remove('is-loaded', 'is-unavailable');
    setScreenshotSource(screenshot, f);
    screenshot.alt = f.alt;
    if (screenshot.complete && screenshot.naturalWidth) document.getElementById('open-screenshot').classList.add('is-loaded');
    document.getElementById('detail-tags').replaceChildren(...f.features.map(([title]) => {
      const tag = document.createElement('span'); tag.textContent = title; return tag;
    }));
    document.getElementById('detail-pager').replaceChildren(chapterMarker, ...f.pages.map((page, i) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.detailPage = i;
      button.textContent = page.label; button.setAttribute('aria-label', `${f.label}：${page.label}，第 ${i + 1} 页`);
      return button;
    }));
    document.getElementById('detail-note').textContent = ['images', 'videos'].includes(f.id)
      ? '图像与视频共用创作台，这里展示开发版。能力与费用由所选模型服务决定；公开版功能请查看发行说明。'
      : '这里的画面与介绍来自开发版，公开版功能请查看发行说明。';
    renderDetailPage(0);
    syncDock(index);
    scene?.select(index);
  }

  function renderDetailPage(index, animate = false) {
    const f = features[active];
    if (!f || index < 0 || index >= f.pages.length) return;
    if (animate && index === detailPage) return;
    const direction = index >= detailPage ? 1 : -1;
    detailPage = index;
    const page = f.pages[index];
    document.getElementById('detail-title').textContent = page.headline;
    document.getElementById('detail-description').textContent = page.description;
    document.getElementById('detail-page-count').textContent = `${index + 1} / ${f.pages.length}`;
    document.getElementById('detail-page-status').textContent = `${f.label} · ${page.label}，第 ${index + 1} 页，共 ${f.pages.length} 页`;
    document.getElementById('detail-visual').hidden = !page.overview;
    document.getElementById('detail-tags').hidden = !page.overview;
    document.getElementById('detail-reading').hidden = !!page.overview;
    document.getElementById('detail-features').replaceChildren(...(page.points || []).map(([title, body]) => {
      const item = document.createElement('section'); item.className = 'feature-point';
      const h = document.createElement('h3'); h.textContent = title;
      const p = document.createElement('p'); p.textContent = body;
      item.append(h, p); return item;
    }));
    document.getElementById('detail-example-text').textContent = page.example || '';
    clearTimeout(copyTimer); copyToken++;
    document.getElementById('copy-example').removeAttribute('aria-busy');
    document.getElementById('copy-example').removeAttribute('data-copy-state');
    document.getElementById('copy-example-label').textContent = '复制示例';
    document.getElementById('example-copy-status').textContent = '';
    const previous = featureDialog.querySelector('[data-page-previous]');
    const next = featureDialog.querySelector('[data-page-next]');
    const focusedControl = document.activeElement;
    previous.disabled = index === 0;
    next.disabled = index === f.pages.length - 1;
    document.querySelectorAll('[data-detail-page]').forEach(button => {
      if (Number(button.dataset.detailPage) === index) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    positionChapterMarker();
    if ((focusedControl === next && next.disabled) || (focusedControl === previous && previous.disabled)) {
      document.querySelector(`[data-detail-page="${index}"]`)?.focus({ preventScroll: true });
    }
    const body = document.querySelector('.detail-body');
    body.scrollTop = 0;
    requestAnimationFrame(updateReadingEdge);
    chapterAnimations.forEach(animation => animation.cancel()); chapterAnimations = [];
    if (animate && !reduced.matches) {
      const layers = [...body.querySelectorAll('.detail-copy,#detail-visual,#detail-tags,.feature-point,.detail-example,.detail-note')]
        .filter(layer => layer.getClientRects().length);
      chapterAnimations = layers.map((layer, i) => layer.animate([
        { opacity: .35, transform: `translate3d(${direction * 12}px,4px,0)` },
        { opacity: 1, transform: 'translate3d(0,0,0)' },
      ], { duration: 380, delay: Math.min(i * 22, 100), easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' }));
    }
  }

  function positionChapterMarker() {
    const current = document.querySelector('[data-detail-page][aria-current]');
    if (!current || !featureDialog.open) return;
    chapterMarker.style.width = current.offsetWidth + 'px';
    chapterMarker.style.transform = `translate3d(${current.offsetLeft}px,${current.offsetTop}px,0)`;
  }
  const chapterObserver = new ResizeObserver(positionChapterMarker);
  chapterObserver.observe(document.getElementById('detail-pager'));
  window.addEventListener('pagehide', e => { if (!e.persisted) chapterObserver.disconnect(); });

  function openFeature(id, source, writeHistory = true) {
    const index = features.findIndex(f => f.id === id);
    if (index < 0) return;
    renderFeature(index);
    showDialog(featureDialog, source);
    positionChapterMarker();
    if (writeHistory && location.hash !== '#' + id) {
      if (historyOwned) history.replaceState({ knorviaFeature: true }, '', '#' + id);
      else { history.pushState({ knorviaFeature: true }, '', '#' + id); historyOwned = true; }
    }
  }

  for (const [index, f] of features.entries()) {
    dock[index].addEventListener('click', e => {
      e.preventDefault();
      if (!document.body.classList.contains('scene-ready')) { openFeature(f.id, dock[index]); return; }
      if (galleryIndex === index) openFeature(f.id, dock[index]);
      else { warmScreenshot(index); scene.focus(index); }
    });
    labels[index].addEventListener('click', e => { e.preventDefault(); openFeature(f.id, dock[index]); });
    for (const button of [dock[index], labels[index]]) {
      button.addEventListener('pointerenter', () => scene?.highlight(index));
      button.addEventListener('pointerleave', () => scene?.highlight(-1));
    }
    dock[index].addEventListener('keydown', e => {
      let next;
      if (e.key === 'ArrowRight') next = (index + 1) % features.length;
      if (e.key === 'ArrowLeft') next = (index - 1 + features.length) % features.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = features.length - 1;
      if (next !== undefined) { e.preventDefault(); dock[next].focus(); scene?.highlight(next); }
    });
    dock[index].addEventListener('blur', () => scene?.highlight(-1));
  }

  const universeObserver = new IntersectionObserver(([entry]) => {
    universeVisible = entry.isIntersecting && entry.intersectionRatio > .01;
    document.documentElement.classList.toggle('scene-out-of-view', !universeVisible);
    scene?.setInView(universeVisible);
  }, { threshold: .01 });
  universeObserver.observe(document.querySelector('.universe'));
  document.documentElement.classList.add('footer-pending');
  const footerObserver = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      document.documentElement.classList.remove('footer-pending'); footerObserver.disconnect();
    }
  }, { threshold: .08 });
  footerObserver.observe(document.getElementById('site-footer'));
  window.addEventListener('pagehide', e => { if (!e.persisted) footerObserver.disconnect(); });
  window.addEventListener('pagehide', e => { if (!e.persisted) universeObserver.disconnect(); });

  for (const d of dialogs) {
    d.querySelectorAll('[data-close-dialog]').forEach(b => b.addEventListener('click', () => dismiss(d)));
    d.addEventListener('cancel', e => { e.preventDefault(); dismiss(d); });
    let downOutside = false;
    d.addEventListener('pointerdown', e => { downOutside = e.target === d && outside(d, e); });
    d.addEventListener('pointerup', e => { if (downOutside && e.target === d && outside(d, e)) dismiss(d); downOutside = false; });
    d.addEventListener('close', () => {
      if (d === featureDialog) {
        if (zoomDialog.open) {
          closing.get(zoomDialog)?.cancel(); closing.delete(zoomDialog);
          zoomDialog.classList.remove('is-closing'); zoomDialog.close();
        }
        clearFeature();
        if (historyOwned) { historyOwned = false; history.back(); }
        else if (features.some(f => location.hash === '#' + f.id)) history.replaceState(null, '', location.pathname + location.search);
      }
      const source = dialogSources.get(d); dialogSources.delete(d);
      syncMotion();
      if (source?.isConnected && source.closest('dialog')?.open) source.focus({ preventScroll: true });
      if (!dialogs.some(x => x.open)) { returnFocus?.focus({ preventScroll: true }); returnFocus = null; }
    });
  }

  function outside(dialog, event) {
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }

  document.querySelectorAll('[data-page-next],[data-page-previous]').forEach(b => b.addEventListener('click', () => {
    renderDetailPage(detailPage + (b.hasAttribute('data-page-next') ? 1 : -1), true);
  }));
  document.getElementById('detail-pager').addEventListener('click', e => {
    const button = e.target.closest('[data-detail-page]');
    if (button) renderDetailPage(Number(button.dataset.detailPage), true);
  });
  const readingBody = document.querySelector('.detail-body');
  function updateReadingEdge() {
    document.getElementById('detail-pager').classList.toggle('has-more',
      readingBody.scrollHeight - readingBody.scrollTop - readingBody.clientHeight > 8);
  }
  readingBody.addEventListener('scroll', updateReadingEdge, { passive: true });
  const readingObserver = new ResizeObserver(updateReadingEdge);
  readingObserver.observe(readingBody);
  window.addEventListener('pagehide', e => { if (!e.persisted) readingObserver.disconnect(); });
  let swipe, suppressedSwipePointer;
  readingBody.addEventListener('pointerdown', e => {
    suppressedSwipePointer = undefined;
    if (e.pointerType !== 'touch' || !e.isPrimary || (e.target.closest('button,a') && !e.target.closest('#open-screenshot'))) return;
    swipe = { x: e.clientX, y: e.clientY, time: e.timeStamp, id: e.pointerId };
  }, { passive: true });
  readingBody.addEventListener('pointerup', e => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6 && e.timeStamp - swipe.time < 900) {
      suppressedSwipePointer = e.pointerId;
      renderDetailPage(detailPage + (dx < 0 ? 1 : -1), true);
    }
    swipe = null;
  }, { passive: true });
  readingBody.addEventListener('pointercancel', () => { swipe = null; }, { passive: true });
  readingBody.addEventListener('click', event => {
    if (event.detail && suppressedSwipePointer !== undefined &&
        (event.pointerId === undefined || event.pointerId === suppressedSwipePointer)) {
      event.preventDefault(); event.stopPropagation();
      suppressedSwipePointer = undefined;
    }
  }, true);
  document.getElementById('copy-example').addEventListener('click', async () => {
    const button = document.getElementById('copy-example');
    if (button.getAttribute('aria-busy') === 'true') return;
    const token = ++copyToken;
    const pageAtCopy = detailPage, topicAtCopy = active;
    const value = document.getElementById('detail-example-text').textContent;
    button.setAttribute('aria-busy', 'true'); button.dataset.copyState = 'copying';
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(value);
      if (token !== copyToken || pageAtCopy !== detailPage || topicAtCopy !== active) return;
      button.dataset.copyState = 'copied';
      document.getElementById('copy-example-label').textContent = '已复制';
      document.getElementById('example-copy-status').textContent = '示例已复制，可以粘贴到 Knorvia 中使用。';
      copyTimer = setTimeout(() => {
        document.getElementById('copy-example-label').textContent = '复制示例';
        button.removeAttribute('data-copy-state');
      }, 1800);
    } catch {
      if (token !== copyToken || pageAtCopy !== detailPage || topicAtCopy !== active) return;
      button.dataset.copyState = 'error';
      document.getElementById('example-copy-status').textContent = '暂时无法访问剪贴板，可选中下方文字复制。';
      const range = document.createRange(); range.selectNodeContents(document.getElementById('detail-example-text'));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } finally {
      if (token === copyToken) button.removeAttribute('aria-busy');
    }
  });
  const screenshot = document.getElementById('detail-screenshot');
  screenshot.addEventListener('load', () => {
    document.getElementById('open-screenshot').classList.remove('is-unavailable');
    document.getElementById('open-screenshot').classList.add('is-loaded');
    updateReadingEdge();
  });
  screenshot.addEventListener('error', () => document.getElementById('open-screenshot').classList.add('is-unavailable'));
  featureDialog.addEventListener('keydown', e => {
    if (zoomDialog.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown'].includes(e.key)) {
      e.preventDefault(); renderDetailPage(detailPage + (['ArrowRight', 'PageDown'].includes(e.key) ? 1 : -1), true);
    }
  });
  document.getElementById('open-screenshot').addEventListener('click', e => {
    const original = document.getElementById('detail-screenshot');
    if (!original.complete || !original.naturalWidth) {
      e.currentTarget.classList.remove('is-unavailable');
      original.src = original.src;
      return;
    }
    const image = document.getElementById('zoom-screenshot'); image.src = original.src; image.alt = original.alt;
    document.getElementById('zoom-title').textContent = `${features[active].label} · 实机画面`;
    viewerScale = 1;
    showDialog(zoomDialog, e.currentTarget);
    updateViewer(false);
    viewer.focus({ preventScroll: true });
  });

  // Fit the full frame first; enlargement stays inside a scrollable viewport.
  const viewer = document.getElementById('zoom-stage');
  const viewerImage = document.getElementById('zoom-screenshot');
  let viewerScale = 1, viewerFit = 1, viewerDrag;
  function updateViewer(preserve = true) {
    if (!zoomDialog.open) return;
    const width = viewerImage.naturalWidth || 1440, height = viewerImage.naturalHeight || 920;
    const oldWidth = viewerImage.offsetWidth || 1, oldHeight = viewerImage.offsetHeight || 1;
    const centerX = (viewer.scrollLeft + viewer.clientWidth / 2) / Math.max(oldWidth, viewer.clientWidth);
    const centerY = (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(oldHeight, viewer.clientHeight);
    viewerFit = Math.min(1, viewer.clientWidth / width, viewer.clientHeight / height);
    const maxScale = Math.max(2, 1 / viewerFit);
    viewerScale = Math.max(1, Math.min(maxScale, viewerScale));
    const imageWidth = width * viewerFit * viewerScale;
    const imageHeight = height * viewerFit * viewerScale;
    viewerImage.style.width = imageWidth + 'px';
    viewerImage.style.height = imageHeight + 'px';
    viewer.classList.toggle('is-zoomed', viewerScale > 1.01);
    document.getElementById('zoom-level').textContent = `${Math.round(viewerFit * viewerScale * 100)}%`;
    const focusedControl = document.activeElement;
    document.getElementById('zoom-out').disabled = viewerScale <= 1.01;
    document.getElementById('zoom-in').disabled = viewerScale >= maxScale - .01;
    if (focusedControl?.matches('#zoom-in:disabled,#zoom-out:disabled')) viewer.focus({ preventScroll: true });
    document.getElementById('zoom-fit').setAttribute('aria-pressed', String(viewerScale <= 1.01));
    document.getElementById('zoom-hint').textContent = viewerScale > 1.01 ? '拖动画面查看细节' : '放大后可拖动画面';
    viewer.scrollLeft = preserve ? centerX * Math.max(imageWidth, viewer.clientWidth) - viewer.clientWidth / 2 : 0;
    viewer.scrollTop = preserve ? centerY * Math.max(imageHeight, viewer.clientHeight) - viewer.clientHeight / 2 : 0;
  }
  function changeViewerScale(factor) { viewerScale *= factor; updateViewer(); }
  document.getElementById('zoom-in').addEventListener('click', () => changeViewerScale(1.7));
  document.getElementById('zoom-out').addEventListener('click', () => changeViewerScale(1 / 1.7));
  document.getElementById('zoom-fit').addEventListener('click', () => { viewerScale = 1; updateViewer(false); });
  viewerImage.addEventListener('load', () => updateViewer(false));
  const viewerObserver = new ResizeObserver(() => updateViewer()); viewerObserver.observe(viewer);
  window.addEventListener('pagehide', e => { if (!e.persisted) viewerObserver.disconnect(); });
  viewer.addEventListener('dblclick', event => {
    if (event.pointerType === 'touch') return;
    viewerScale = viewerScale > 1.01 ? 1 : Math.max(2, 1 / viewerFit); updateViewer();
  });
  viewer.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0 || viewerScale <= 1.01) return;
    event.preventDefault(); viewer.focus({ preventScroll: true });
    viewerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewer.scrollLeft, top: viewer.scrollTop };
    viewer.setPointerCapture(event.pointerId); viewer.classList.add('is-dragging');
  });
  viewer.addEventListener('pointermove', event => {
    if (!viewerDrag || event.pointerId !== viewerDrag.id) return;
    viewer.scrollLeft = viewerDrag.left + viewerDrag.x - event.clientX;
    viewer.scrollTop = viewerDrag.top + viewerDrag.y - event.clientY;
  });
  function endViewerDrag() { viewerDrag = null; viewer.classList.remove('is-dragging'); }
  viewer.addEventListener('pointerup', endViewerDrag);
  viewer.addEventListener('pointercancel', endViewerDrag);
  viewer.addEventListener('lostpointercapture', endViewerDrag);
  zoomDialog.addEventListener('close', endViewerDrag);
  zoomDialog.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') { viewerScale = 1; updateViewer(false); }
      else changeViewerScale(event.key === '-' ? 1 / 1.7 : 1.7);
    }
  });
  const downloadCopy = document.getElementById('copy-download-link');
  downloadCopy.addEventListener('click', async () => {
    if (downloadCopy.getAttribute('aria-busy') === 'true') return;
    downloadCopy.setAttribute('aria-busy', 'true');
    const link = document.getElementById('download-page-link');
    try {
      await navigator.clipboard.writeText(link.value);
      document.getElementById('download-copy-status').textContent = '链接已复制，可在 Windows 电脑上打开。';
    } catch {
      link.hidden = false; link.focus(); link.select();
      document.getElementById('download-copy-status').textContent = '选中下方链接，复制到电脑打开。';
    } finally { downloadCopy.removeAttribute('aria-busy'); }
  });
  document.querySelectorAll('[data-open-about]').forEach(b => b.addEventListener('click', () => showDialog(document.getElementById('about-dialog'), b)));
  document.querySelectorAll('[data-open-download]').forEach(b => b.addEventListener('click', () => showDialog(document.getElementById('download-dialog'), b)));
  motionButton.addEventListener('click', () => { manualPaused = !manualPaused; syncMotion(); });
  document.getElementById('reset-view').addEventListener('click', () => {
    scene?.reset();
  });
  // One scheduled write per pointer frame; settled and offscreen controls do no work.
  const lightControls = [];
  document.querySelectorAll('.luminous-button').forEach(button => {
    const light = document.createElement('span');
    light.className = 'button-light'; light.setAttribute('aria-hidden', 'true'); button.prepend(light);
    const host = button.closest('.screenshot-button') || button;
    let rect, frame = 0, pointer;
    function position(e) {
      if (reduced.matches || e.pointerType === 'touch') return;
      pointer = { x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0; if (!rect || !pointer) return;
        const x = Math.max(-1, Math.min(1, (pointer.x - rect.left) / rect.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (pointer.y - rect.top) / rect.height * 2 - 1));
        button.style.setProperty('--light-x', `${x * rect.width * .31}px`);
        button.style.setProperty('--light-at', `${50 + x * 32}%`);
        button.style.setProperty('--button-x', `${x * 1.4}px`);
        button.style.setProperty('--button-y', `${y * .65}px`);
        button.style.setProperty('--button-rx', `${-y * 2}deg`);
        button.style.setProperty('--button-ry', `${x * 2.5}deg`);
      });
    }
    function reset() {
      cancelAnimationFrame(frame); frame = 0; pointer = null; rect = null;
      button.classList.remove('is-lit', 'is-pressed');
      ['--light-x', '--light-at', '--button-x', '--button-y', '--button-rx', '--button-ry'].forEach(name => button.style.removeProperty(name));
    }
    host.addEventListener('pointerenter', e => {
      if (e.pointerType === 'touch') return;
      rect = button.getBoundingClientRect(); button.classList.add('is-lit'); position(e);
    });
    host.addEventListener('pointermove', position, { passive: true });
    host.addEventListener('pointerleave', reset);
    host.addEventListener('pointercancel', reset);
    host.addEventListener('pointerdown', e => { if (e.button === 0) button.classList.add('is-pressed'); });
    host.addEventListener('pointerup', () => button.classList.remove('is-pressed'));
    host.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') button.classList.add('is-pressed'); });
    host.addEventListener('keyup', () => button.classList.remove('is-pressed'));
    host.addEventListener('blur', reset);
    lightControls.push(reset);
  });
  function resetLights() { lightControls.forEach(reset => reset()); }
  window.addEventListener('blur', resetLights);
  window.addEventListener('pagehide', resetLights);
  window.addEventListener('resize', resetLights, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetLights(); });
  reduced.addEventListener('change', resetLights);
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      chapterAnimations.forEach(animation => animation.cancel()); chapterAnimations = [];
    }
  });
  reduced.addEventListener('change', () => { manualPaused = reduced.matches; syncMotion(); });
  window.addEventListener('popstate', () => {
    historyOwned = false;
    const id = location.hash.slice(1);
    if (features.some(f => f.id === id)) openFeature(id, null, false);
    else if (featureDialog.open) featureDialog.close();
  });
  window.addEventListener('hashchange', fromHash);
  function fromHash() {
    const aliases = { workbench: 'workspace', creation: 'images', capabilities: 'bots' };
    const id = aliases[location.hash.slice(1)] || location.hash.slice(1);
    if (features.some(f => f.id === id)) openFeature(id, null, false);
    else if (id === 'install') showDialog(document.getElementById('download-dialog'));
  }
  fromHash(); syncMotion();

  let dockLightFrame = 0, dockLightPointer;
  dockContainer.addEventListener('pointermove', event => {
    if (reduced.matches || event.pointerType === 'touch') return;
    dockLightPointer = event.clientX;
    if (dockLightFrame) return;
    dockLightFrame = requestAnimationFrame(() => {
      dockLightFrame = 0;
      const bounds = dockContainer.getBoundingClientRect();
      dockContainer.style.setProperty('--dock-light-x', `${Math.max(0, Math.min(bounds.width, dockLightPointer - bounds.left))}px`);
    });
  }, { passive: true });
  function resetDockLight() {
    cancelAnimationFrame(dockLightFrame); dockLightFrame = 0;
    dockContainer.style.removeProperty('--dock-light-x');
  }
  dockContainer.addEventListener('pointerleave', resetDockLight);
  window.addEventListener('blur', resetDockLight);
  reduced.addEventListener('change', resetDockLight);
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('page-hidden', document.hidden);
    if (document.hidden) resetDockLight();
  });
  window.addEventListener('pagehide', resetDockLight);

  import(asset('orbit-scene.js?v=20260912-7')).then(({ createOrbitScene }) => {
    scene = createOrbitScene(document.getElementById('orbit-canvas'), features, {
      labels,
      onHover(index) { dock.forEach((a, i) => a.classList.toggle('is-hovered', i === index)); syncSceneCaption(index >= 0 ? index : galleryIndex); },
      onFocus(index) { galleryIndex = index; syncDock(active >= 0 ? active : index); },
      onSelect(index) { openFeature(features[index].id, dock[index]); },
      onReady() { document.body.classList.remove('scene-failed'); document.body.classList.add('scene-ready'); document.getElementById('scene-status').textContent = ''; },
      onFailure() { document.body.classList.remove('scene-ready'); document.body.classList.add('scene-failed'); document.getElementById('scene-status').textContent = ''; },
    });
    syncMotion(); scene.setInView(universeVisible); if (active >= 0) scene.select(active);
    if (new URLSearchParams(location.search).has('inspect')) window.__orbit = scene;
  }).catch(error => {
    document.body.classList.add('scene-failed');
    document.getElementById('scene-status').textContent = '';
    motionButton.hidden = true;
    console.info('Spatial enhancement unavailable; feature navigation is available.', error.message);
  });
})();
