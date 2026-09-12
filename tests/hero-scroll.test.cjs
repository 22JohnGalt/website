const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../scripts/hero-scroll.js'), 'utf8');

// Model asynchronous video seeks and browser events with a deterministic clock.
// This checks scheduling and lifecycle, not browser decoding or visual smoothness.
function setup({ reduced = false, mobile = false, scroll = 0 } = {}) {
  function element(extra = {}) {
    const listeners = {}, classes = new Set();
    return Object.assign({
      style: { setProperty(k, v) { this[k] = v; } },
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle(c, value) { if (value) classes.add(c); else classes.delete(c); },
      },
      addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
      emit(name) { for (const callback of listeners[name] || []) callback(); },
    }, extra);
  }
  let clock = 0, id = 0, mediaTime = 0;
  const callbacks = new Map(), seeks = [];
  const sticky = element({ offsetHeight: 800 });
  const wrap = element({ offsetTop: 0, offsetHeight: mobile ? 2400 : 3200,
    querySelector: () => sticky });
  const hero = element(), progress = element();
  const video = element({ duration: NaN, readyState: 0, seeking: false,
    dataset: { mobileSrc: 'mobile.mp4', desktopSrc: 'desktop.mp4' },
    pause() { this.paused = true; }, canPlayType: () => 'probably',
    getAttribute(name) { return this[name]; }, removeAttribute(name) { delete this[name]; },
    load() { this.readyState = 0; this.seeking = false; mediaTime = 0; },
  });
  Object.defineProperty(video, 'currentTime', {
    get: () => mediaTime,
    set(value) {
      assert.equal(video.seeking, false, 'must never overlap seeks');
      assert.ok(value >= 0 && value <= 143 / 24, 'must stay inside the frame range');
      assert.ok(Math.abs(value * 24 - Math.round(value * 24)) < 1e-9);
      video.seeking = true; mediaTime = value; seeks.push(value);
    },
  });
  const motionMQ = element({ matches: reduced }), mobileMQ = element({ matches: mobile });
  const coarseMQ = element({ matches: mobile });
  const document = element({ hidden: false, documentElement: element(),
    getElementById: id => ({ bgvid: video, wrap, progress })[id],
    querySelector: () => hero,
  });
  const window = element({ scrollY: scroll, innerHeight: 800,
    matchMedia: q => q.includes('reduced-motion') ? motionMQ : q.includes('max-width') ? mobileMQ : coarseMQ,
  });
  runInNewContext(source, { window, document, performance: { now: () => clock },
    requestAnimationFrame(fn) { callbacks.set(++id, fn); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
  });
  const env = {
    video, window, document, wrap, sticky, hero, progress, seeks, callbacks,
    frame(ms = 16) {
      clock += ms;
      const batch = [...callbacks.values()]; callbacks.clear();
      for (const fn of batch) fn(clock);
    },
    complete() { if (video.seeking) { video.seeking = false; video.emit('seeked'); } },
    ready() { video.duration = 6; video.readyState = 2; video.emit('loadedmetadata'); video.emit('canplay'); },
    scroll(y) { window.scrollY = y; window.emit('scroll'); },
    settle() {
      for (let i = 0; i < 200 && (callbacks.size || video.seeking); i++) {
        env.frame(); env.complete();
      }
      assert.equal(callbacks.size, 0, 'render loop must stop after settling');
      assert.equal(video.seeking, false);
    },
    reduce(value) { motionMQ.matches = value; motionMQ.emit('change'); },
    mobile(value) { mobileMQ.matches = value; mobileMQ.emit('change'); },
    position: () => Number(progress.style.transform.match(/\((.*)\)/)[1]),
  };
  return env;
}

test('eases after scrolling stops and reaches the last frame with no permanent loop', () => {
  const e = setup({ mobile: true }); e.ready(); e.settle();
  e.scroll(1600); e.frame();
  const first = e.position();
  assert.ok(first > 0 && first < 1);
  e.complete(); e.frame();
  assert.ok(e.position() > first, 'motion continues without another scroll event');
  e.settle();
  assert.equal(e.position(), 1);
  assert.equal(e.video.currentTime, 143 / 24);
  assert.equal(e.hero.style['--fp'], '1.00000');
});

test('a busy decoder receives only the newest frame after reversal', () => {
  const e = setup(); e.ready(); e.settle();
  e.scroll(2400); e.frame();
  const count = e.seeks.length;
  e.scroll(1800); e.frame(); e.scroll(0);
  for (let i = 0; i < 60; i++) e.frame();
  assert.equal(e.seeks.length, count);
  e.complete(); e.frame();
  assert.equal(e.seeks.at(-1), 0);
  e.settle();
});

test('buffering retains the target and resumes without another scroll', () => {
  const e = setup(); e.ready(); e.settle();
  e.video.readyState = 1;
  const count = e.seeks.length;
  e.scroll(1200); e.settle();
  assert.equal(e.seeks.length, count);
  e.video.readyState = 2; e.video.emit('canplay'); e.settle();
  assert.equal(e.video.currentTime, 72 / 24);
});

test('hidden and offscreen states suspend work; returning restores the target', () => {
  const e = setup(); e.ready(); e.settle();
  e.scroll(1200); e.frame();
  e.document.hidden = true; e.document.emit('visibilitychange'); e.complete();
  assert.equal(e.callbacks.size, 0);
  e.scroll(1800);
  e.document.hidden = false; e.document.emit('visibilitychange'); e.settle();
  assert.equal(e.video.currentTime, 107 / 24);
  e.scroll(4000); assert.equal(e.callbacks.size, 0);
  e.scroll(0); e.settle(); assert.equal(e.video.currentTime, 0);
});

test('restored scroll and viewport changes use the actual sticky height', () => {
  const e = setup({ scroll: 1200 }); e.ready(); e.settle();
  assert.equal(e.video.currentTime, 72 / 24);
  e.window.innerHeight = 900; e.window.emit('resize'); e.settle();
  assert.equal(e.position(), 0.5, 'toolbar height must not change the timeline');
  e.wrap.offsetHeight = 2400; e.sticky.offsetHeight = 600;
  e.window.emit('resize'); e.settle();
  assert.equal(e.video.currentTime, 95 / 24);
});

test('reduced motion avoids video loading and reacts to live preference changes', () => {
  const e = setup({ reduced: true });
  assert.equal(e.video.src, undefined);
  assert.equal(e.callbacks.size, 0);
  e.scroll(1200); assert.equal(e.callbacks.size, 0);
  e.reduce(false); e.ready(); e.settle();
  assert.equal(e.video.src, 'desktop.mp4');
  e.reduce(true);
  assert.equal(e.video.src, undefined);
  assert.equal(e.callbacks.size, 0);
});

test('source changes reset decoding and errors retain a usable text timeline', () => {
  const e = setup(); e.ready(); e.settle();
  e.scroll(1200); e.frame();
  e.mobile(true); e.ready(); e.settle();
  assert.equal(e.video.src, 'mobile.mp4');
  e.video.emit('error');
  assert.ok(e.wrap.classList.contains('video-fallback'));
  const count = e.seeks.length;
  e.scroll(2400); e.settle();
  assert.equal(e.seeks.length, count);
  assert.equal(e.hero.style['--fp'], '1.00000');
});

test('easing uses elapsed time equally on 60 Hz and 120 Hz displays', () => {
  function after(hz) {
    const e = setup(); e.ready(); e.settle(); e.scroll(2400);
    for (let i = 0; i < hz / 5; i++) { e.frame(1000 / hz); e.complete(); }
    return e.position();
  }
  assert.ok(Math.abs(after(60) - after(120)) < 1e-9);
});

test('slow swipes are not capped to seven updates per second on touch', () => {
  const e = setup({ mobile: true }); e.ready(); e.settle();
  const count = e.seeks.length;
  for (let i = 1; i <= 60; i++) { e.scroll(i * 10); e.frame(1000 / 60); e.complete(); }
  assert.ok(e.seeks.length - count > 24);
  e.settle();
  const settledCount = e.seeks.length;
  e.scroll(600); e.settle();
  assert.equal(e.seeks.length, settledCount, 'duplicate target must not seek again');
});
