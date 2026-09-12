(() => {
  'use strict';
  const video = document.getElementById('bgvid');
  const wrap = document.getElementById('wrap');
  const hero = document.querySelector('.hero-copy');
  const sticky = wrap.querySelector('.sticky');
  const progress = document.getElementById('progress');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 640px)');
  const coarse = window.matchMedia('(pointer: coarse)');
  const FPS = 24;
  const TAU_MS = 100;
  const clamp = value => Math.max(0, Math.min(1, value));
  const geometry = { top: 0, height: 1, viewport: 1, travel: 1 };
  let target = 0, current = 0, raf = null, previousTime = null;
  let active = false, failed = false, seeking = false;
  let lastFrame = 143, desiredFrame = 0, completedFrame = -1, pendingFrame = null;

  function measure() {
    let top = 0;
    for (let el = wrap; el; el = el.offsetParent) top += el.offsetTop;
    geometry.top = top;
    geometry.height = wrap.offsetHeight;
    geometry.viewport = window.innerHeight;
    // Use the actual sticky box, not the changing mobile browser viewport.
    geometry.travel = Math.max(1, geometry.height - sticky.offsetHeight);
  }

  function stop() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    previousTime = null;
  }

  function requestRender() {
    if (active && raf === null) {
      if (previousTime === null) previousTime = performance.now();
      raf = requestAnimationFrame(render);
    }
  }

  function paint() {
    progress.style.transform = 'scaleX(' + current + ')';
    const phase = clamp((current - 0.35) / 0.40);
    hero.style.setProperty('--fp', (phase * phase * (3 - 2 * phase)).toFixed(5));
    desiredFrame = Math.round(current * lastFrame);
  }

  function seekLatest() {
    // The latest desired frame is the entire queue. Never interrupt a decoder seek.
    if (!active || failed || seeking || video.seeking || video.readyState < 2 ||
        desiredFrame === completedFrame || !Number.isFinite(video.duration)) return;
    seeking = true;
    pendingFrame = desiredFrame;
    try {
      video.pause();
      video.currentTime = desiredFrame / FPS;
    } catch {
      seeking = false;
      pendingFrame = null;
      // A subsequent readiness event or scroll will retry, without a busy loop.
    }
  }

  function render(now) {
    raf = null;
    if (!active) return;
    const dt = Math.max(0, now - previousTime);
    previousTime = now;
    current += (target - current) * (1 - Math.exp(-dt / TAU_MS));
    if (Math.abs(target - current) * lastFrame <= 0.5) current = target;
    paint();
    seekLatest();
    if (current !== target) requestRender();
    else previousTime = null;
  }

  function update() {
    target = clamp((window.scrollY - geometry.top) / geometry.travel);
    const visible = window.scrollY + geometry.viewport > geometry.top &&
      window.scrollY < geometry.top + geometry.height;
    const nextActive = visible && !document.hidden && !reduced.matches;
    if (!nextActive) {
      active = false;
      stop();
      // Keep the page progress correct without an offscreen animation loop.
      if (!document.hidden) { current = reduced.matches ? 0 : target; paint(); }
      return;
    }
    if (!active) current = target; // Restored scroll position / returning to the hero.
    active = true;
    requestRender();
  }

  function refresh() { measure(); update(); }

  function setSource() {
    video.pause();
    if (reduced.matches) {
      stop();
      active = false;
      video.removeAttribute('src');
      video.preload = 'none';
      video.load();
      return;
    }
    const src = mobile.matches ? video.dataset.mobileSrc : video.dataset.desktopSrc;
    if (video.getAttribute('src') === src) return;
    seeking = false;
    pendingFrame = null;
    completedFrame = -1;
    failed = !video.canPlayType('video/mp4');
    wrap.classList.add('video-fallback');
    if (failed) return;
    video.preload = 'auto';
    video.src = src;
    video.load();
  }

  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      lastFrame = Math.max(0, Math.round(video.duration * FPS) - 1);
      completedFrame = -1;
      refresh();
    }
  });
  function ready() {
    if (failed || reduced.matches) return;
    wrap.classList.remove('video-fallback');
    requestRender();
  }
  video.addEventListener('loadeddata', ready);
  video.addEventListener('canplay', ready);
  video.addEventListener('seeked', () => {
    // Some engines emit seeked without an application seek during initialization.
    if (pendingFrame !== null) completedFrame = pendingFrame;
    pendingFrame = null;
    seeking = false;
    // Render first so a reversal in the same event turn cannot flush a stale target.
    requestRender();
  });
  video.addEventListener('error', () => {
    if (reduced.matches) return;
    failed = true;
    seeking = false;
    pendingFrame = null;
    wrap.classList.add('video-fallback');
  });
  // Guard against browser-initiated playback; this video is always scroll-controlled.
  video.addEventListener('play', () => video.pause());

  function glass() { document.documentElement.classList.toggle('lite-glass', coarse.matches); }
  coarse.addEventListener('change', glass);
  mobile.addEventListener('change', () => { setSource(); refresh(); });
  reduced.addEventListener('change', () => { setSource(); refresh(); });
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
  window.addEventListener('load', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(refresh);
    observer.observe(wrap);
    observer.observe(sticky);
  }
  glass();
  setSource();
  refresh();
})();
