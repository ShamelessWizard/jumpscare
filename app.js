(() => {
  "use strict";

  const config = window.JUMPSCARE_CONFIG;
  const form = document.querySelector("#form");
  const image = document.querySelector("#sign-image");
  const canvas = document.querySelector("#signature");
  const context = canvas.getContext("2d");
  const video = document.querySelector("#scare");
  const setup = document.querySelector("#setup");
  const message = document.querySelector("#setup-message");
  const start = document.querySelector("#start");
  const fullscreen = document.querySelector("#fullscreen");
  const cancel = document.querySelector("#cancel");
  const clear = document.querySelector("#clear");
  const accept = document.querySelector("#accept");
  const inkWidth = config.inkWidth * canvas.width / 2360;

  let phase = "setup";
  let generation = 0;
  let scareTimer;
  let resetTimer;
  let playbackTimeout;
  let pointerId = null;
  let previousPoint = null;
  let hasInk = false;
  let wakeLock;
  let videoFrameRequest = null;
  let animationFrameRequest = null;
  let lastFramePaint = -Infinity;

  video.src = config.videoSrc;
  video.muted = false;
  video.loop = false;
  context.strokeStyle = config.inkColor;
  context.fillStyle = config.inkColor;
  context.lineWidth = inkWidth;
  context.lineCap = "round";
  context.lineJoin = "round";

  function setPhase(next) {
    phase = next;
    document.body.dataset.phase = next;
    const signing = next === "ready" || next === "countdown";
    cancel.disabled = !signing && next !== "accepted";
    clear.disabled = !signing;
    accept.disabled = !signing || !hasInk;
    canvas.style.pointerEvents = signing ? "auto" : "none";
  }

  function stopDrawing() {
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    pointerId = null;
    previousPoint = null;
  }

  function eraseSignature() {
    stopDrawing();
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    accept.disabled = true;
  }

  function stopVideoFrames() {
    if (videoFrameRequest !== null) video.cancelVideoFrameCallback(videoFrameRequest);
    if (animationFrameRequest !== null) cancelAnimationFrame(animationFrameRequest);
    videoFrameRequest = null;
    animationFrameRequest = null;
  }

  function scheduleVideoFrame(token) {
    if (token !== generation) return;
    if (videoFrameRequest !== null || animationFrameRequest !== null) return;
    const paint = (timestamp) => paintVideoFrame(timestamp, token);
    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameRequest = video.requestVideoFrameCallback(paint);
    } else {
      animationFrameRequest = requestAnimationFrame(paint);
    }
  }

  function paintVideoFrame(timestamp, token) {
    // A callback already queued before cancellation belongs to its old round.
    // It must not clear the new round's callback ID or paint its last frame.
    if (token !== generation) return;
    videoFrameRequest = null;
    animationFrameRequest = null;
    if (phase !== "starting" && phase !== "playing") return;

    // Keep the signature visible until a decoded frame is ready. Paint into
    // the same canvas as the ink; the native video never becomes visible.
    // Older browsers use a fallback capped at 30 paints per second.
    const shouldPaint = typeof video.requestVideoFrameCallback === "function"
      || timestamp - lastFramePaint >= 1000 / 30;
    if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && shouldPaint) {
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        showSetup("Video playback was interrupted. Tap Start to prepare the signature pad again.");
        return;
      }
      lastFramePaint = timestamp;
      if (phase === "starting") {
        clearTimeout(playbackTimeout);
        setPhase("playing");
        // Start the reset clock when the first frame is actually painted.
        resetTimer = setTimeout(reset, config.resetAfterMs);
      }
    }

    if (!video.paused && !video.ended) scheduleVideoFrame(token);
  }

  function stopRound() {
    generation += 1; // Invalidates pending play() promises as well as timers.
    clearTimeout(scareTimer);
    clearTimeout(resetTimer);
    clearTimeout(playbackTimeout);
    stopVideoFrames();
    video.pause();
    // The canvas keeps the final painted frame until it is cleared here.
    // Native video end/seek rendering cannot change the visible surface.
    eraseSignature();
  }

  function reset() {
    stopRound();
    setPhase("ready");
    // Start each round with a fresh decoding pipeline at time zero. Seeking a
    // finished decoder can retain old surfaces on replay. Keep the same DOM
    // element so the Start tap's media permission is retained.
    video.load();
  }

  function showSetup(text) {
    stopRound();
    setPhase("setup");
    message.textContent = text;
    setup.hidden = false;
    start.disabled = !image.complete || image.naturalWidth === 0;
    start.textContent = "Start";
    if (wakeLock) void wakeLock.release().catch(() => {});
  }

  async function keepAwake() {
    if (!navigator.wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      if (phase === "setup") await wakeLock.release();
    } catch {
      // Optional: the station still works when the browser denies a wake lock.
    }
  }

  // Call play() directly inside a tap handler, before any await, to unlock sound
  // on this same video element. Keep the moving image covered until the scare.
  start.addEventListener("click", () => {
    start.disabled = true;
    start.textContent = "Preparing…";
    message.textContent = "Preparing the signature pad…";
    const token = ++generation;
    video.load();
    const playback = video.play();

    if (fullscreen.checked && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {});
    }

    playbackTimeout = setTimeout(() => {
      if (token === generation) showSetup("The video is taking too long to load. Check the connection, then tap Start.");
    }, 15000);

    playback.then(() => {
      if (token !== generation) return;
      clearTimeout(playbackTimeout);
      video.pause();
      video.load();
      eraseSignature();
      setPhase("ready");
      setup.hidden = true;
      void keepAwake();
    }).catch(() => {
      if (token === generation) showSetup("Could not prepare the video. Check that the MP4 is available, then tap Start again.");
    });
  });

  function startCountdown() {
    setPhase("countdown");
    // Start already unlocked this player. Don't briefly play it on a stroke:
    // a clip that starts immediately could leak audio before the scare.
    scareTimer = setTimeout(playScare, config.delayMs);
  }

  function playScare() {
    if (phase !== "countdown" && phase !== "accepted") return;
    stopDrawing();
    setPhase("starting");
    lastFramePaint = -Infinity;
    const token = generation;

    // Don't leave a stuck station if a network interruption prevents playing.
    playbackTimeout = setTimeout(() => {
      if (token === generation) showSetup("Playback was interrupted. Tap Start to prepare the signature pad again.");
    }, 15000);

    // load() prepared a clean time-zero resource. Await actual playback before
    // requesting frames; do not race an asynchronous seek with a new play().
    video.play().then(() => {
      if (token === generation && phase === "starting") scheduleVideoFrame(token);
    }).catch(() => {
      if (token === generation) showSetup("Tap Start to enable video playback again.");
    });
  }

  video.addEventListener("ended", () => {
    if (phase !== "playing" || !video.ended) return;
    stopVideoFrames();
    // Retain the already painted frame until resetAfterMs. Do not redraw the
    // video after "ended", when its native presentation may change.
  });

  video.addEventListener("error", () => {
    if (!video.error) return;
    showSetup("The video could not load. Check the MP4 file and server, then tap Start again.");
  });

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if ((phase !== "ready" && phase !== "countdown") || pointerId !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    previousPoint = pointFromEvent(event);
    context.beginPath();
    context.arc(previousPoint.x, previousPoint.y, inkWidth / 2, 0, Math.PI * 2);
    context.fill();
    hasInk = true;
    if (phase === "ready") startCountdown();
    accept.disabled = false;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || !previousPoint) return;
    event.preventDefault();
    const points = event.getCoalescedEvents?.() || [event];
    for (const sample of points.length ? points : [event]) {
      const point = pointFromEvent(sample);
      context.beginPath();
      context.moveTo(previousPoint.x, previousPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      previousPoint = point;
    }
  });

  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(name, (event) => {
      if (event.pointerId === pointerId) stopDrawing();
    });
  }

  clear.addEventListener("click", eraseSignature);
  cancel.addEventListener("click", reset);
  accept.addEventListener("click", () => {
    if (phase === "countdown" && hasInk) {
      stopDrawing();
      setPhase("accepted"); // Keep the original first-stroke countdown running.
    }
  });

  // Never surprise someone on returning from another tab or a locked screen.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) showSetup("Tap Start, then hand over the iPad.");
  });
  window.addEventListener("pagehide", () => showSetup("Tap Start, then hand over the iPad."));
  form.addEventListener("contextmenu", (event) => event.preventDefault());

  function imageReady() {
    start.disabled = false;
    start.textContent = "Start";
  }

  function imageFailed() {
    showSetup("The signature image could not load. Check scaled_jumpscare_static.png and reload the page.");
    start.disabled = true;
  }

  image.addEventListener("load", imageReady);
  image.addEventListener("error", imageFailed);
  if (image.complete) {
    if (image.naturalWidth > 0) imageReady();
    else imageFailed();
  }
  setPhase("setup");
})();
