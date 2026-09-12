# Scroll animation

## Behavior and tradeoffs

The six-second originals each contain 144 frames at 24 fps. The old touch path
waited 150 ms between seeks (about seven updates per second), used a 30 fps grid,
and spread the animation across an 800vh section.

`scripts/hero-scroll.js` now shares one eased progress value between video, text,
and the progress bar. Each animation tick uses elapsed time:

```text
progress += (target - progress) * (1 - exp(-elapsedMilliseconds / 100))
```

The 100 ms value is a time constant, not a total animation duration: roughly 63%
of the remaining distance is covered in 100 ms. Within half a source frame, the
timeline snaps to its exact target and the animation loop stops. The decoder gets
at most one seek at a time; a slow decoder skips intermediate targets and receives
the newest eased frame after completing its previous request. Targets use the
24 fps grid, including the last frame at 143/24 seconds. Text follows the eased
timeline; a slow decoder can still make the displayed video lag behind it.

The section is 300svh on mobile (<=640px) and 400svh on desktop. Its sticky box is
100svh, leaving two or three viewport heights of scroll travel. Small viewport
units and measuring the actual sticky height prevent Android toolbar changes
from changing the denominator. Older browsers fall back to vh.

Scroll control remains forward/reverse, with no autoplay. Work stops offscreen
and in hidden tabs; returning restores the current scroll target. Buffering waits
for a readiness event without spinning. Reduced motion uses the poster, skips
video loading, and puts all hero text in a compact static layout. Live preference
changes and responsive source changes are handled. Media errors expose the poster
while the foreground timeline remains usable. Existing touch blur reduction stays.

Every frame in the new files is independently decodable. This makes random seeks
cheaper at the cost of bandwidth; it does not create additional motion detail or
guarantee 60 fps. The originals are preserved. No dependencies were added, and the
game script was left unchanged.

## Reproduce the assets

Run from the repository root with FFmpeg (libx264 enabled). `-n` prevents accidental
overwriting; these commands create separate outputs.

```sh
mkdir -p assets
ffmpeg -hide_banner -loglevel error -n -i Hand_flipping_BTC_animation.mp4 -map 0:v:0 -an -c:v libx264 -g 1 -crf 20 -pix_fmt yuv420p -movflags +faststart assets/hand-btc-desktop-scrub.mp4
ffmpeg -hide_banner -loglevel error -n -i Hand_flipping_BTC_mobile.mp4 -map 0:v:0 -an -c:v libx264 -g 1 -crf 20 -pix_fmt yuv420p -movflags +faststart assets/hand-btc-mobile-scrub.mp4
ffmpeg -hide_banner -loglevel error -n -i Hand_flipping_BTC_animation.mp4 -frames:v 1 -q:v 2 assets/hand-btc-poster.jpg
```

| Asset | Resolution | Bytes | Frames / keyframes |
| --- | --- | ---: | ---: |
| Original desktop | 1280 x 720 | 1,413,946 | 144 / 10 |
| Desktop scrub | 1280 x 720 | 3,623,976 | 144 / 144 |
| Original mobile | 960 x 540 | 678,287 | 144 / 9 |
| Mobile scrub | 960 x 540 | 2,307,415 | 144 / 144 |
| Poster | 1280 x 720 | 26,891 | — |

Both derived MP4s retain 24 fps and exactly six seconds. Their `moov` atom precedes
`mdat` for fast startup. SSIM versus the corresponding original is 0.997177
(desktop) and 0.996732 (mobile); these are compression similarity measurements,
not smoothness measurements. The poster and sampled desktop frames were visually
inspected for obvious encoding problems.

## Checks performed

```sh
node --check scripts/hero-scroll.js
node --test tests/hero-scroll.test.cjs
git diff --check
```

Nine deterministic tests cover easing after scroll stops, endpoints, a busy
decoder plus reversal, buffering, hidden/offscreen suspension and return,
restored scroll, geometry changes, reduced motion, responsive sources, media
errors, elapsed-time equivalence at 60/120 Hz, and duplicate suppression.
Media inspection confirmed all 144 frames are keyframes and startup metadata
appears before video data.

**Still unverified:** actual browser rendering, seek latency, presented-frame
timing, and physical Android/iOS performance. No connected browser or physical
device was available during implementation. The tests model asynchronous media
events; they do not run a real video decoder.

## Device acceptance check

Use physical Android Chrome first, then iOS Safari and desktop. Compare the
previous site and this version on the same device with similar swipe speeds.
Serve files over HTTP with byte-range support (the intended host should return
206 for a video Range request). Check a cold cache as well as a warm cache because
the independently decodable videos are larger.

1. Slowly swipe forward, fling rapidly, reverse immediately, then stop. Confirm
   motion eases to the correct frame without replaying old targets or flickering.
2. Visit the first and last frames, reload midway, rotate, and collapse/expand
   the Android toolbar. Confirm the text sequence and section exit remain usable.
3. Leave the hero, background the tab, and return. Confirm there is no catch-up
   through obsolete frames. In a performance recording, the hero render callback
   should cease after settling; the existing game has its own separate loop.
4. Throttle the connection, block the video, and enable reduced motion. Confirm
   the poster is visible, the hero stays readable, and buffering can recover.
5. Check the game controls and layout remain unchanged.

To capture local timing samples, paste this into DevTools on either version and
make continuous swipes for ten seconds. Inspect the returned console table.
The observer only collects in memory; it sends nothing to a server.

```js
(() => {
  const video = document.getElementById('bgvid');
  const seeks = [], intervals = [];
  let started = null, previous = null, callback = null;
  const seeking = () => { started = performance.now(); };
  const seeked = () => {
    if (started !== null) seeks.push(performance.now() - started);
    started = null;
  };
  const presented = (now, metadata) => {
    const time = metadata.expectedDisplayTime;
    if (previous !== null) intervals.push(time - previous);
    previous = time;
    callback = video.requestVideoFrameCallback(presented);
  };
  video.addEventListener('seeking', seeking);
  video.addEventListener('seeked', seeked);
  if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(presented);
  setTimeout(() => {
    video.removeEventListener('seeking', seeking);
    video.removeEventListener('seeked', seeked);
    if (callback !== null) video.cancelVideoFrameCallback(callback);
    const summary = values => {
      values.sort((a, b) => a - b);
      const percentile = p => values.length ? values[Math.ceil(values.length * p) - 1].toFixed(1) : 'n/a';
      return { samples: values.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
    };
    console.table({ seekLatency: summary(seeks), presentedInterval: summary(intervals) });
  }, 10000);
})();
```

Presented intervals include intentional holds if scrolling pauses or advances
less than one source frame. Compare continuous-motion samples; do not interpret
all long intervals as dropped frames. Seek latency is event-to-event and excludes
the wait before issuing a seek. Older browsers without video-frame callbacks
only report seek latency. Record device, browser, viewport, cache state, and
gesture alongside results; no device measurements are claimed above.
