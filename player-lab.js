(() => {
  "use strict";

  const nonce = decodeURIComponent(location.hash.slice(1));
  const state = {
    port: null,
    embedId: null,
    mode: "unknown",
    verbose: true,
    fullUrls: false,
    api: null,
    media: null,
    initialized: false,
    scriptLoaded: false,
    candidates: [],
    resources: [],
    unpatch: [],
    seq: 0,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const localLog = $("#local-log");
  const facts = $("#facts");
  const playerHost = $("#rumble-player");

  function redactUrl(raw) {
    if (!raw || typeof raw !== "string" || state.fullUrls) return raw;
    try {
      const url = new URL(raw, location.href);
      const keys = [...url.searchParams.keys()];
      const suffix = keys.length ? `?${keys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : "";
      return `${url.origin}${url.pathname}${suffix}`;
    } catch {
      return raw;
    }
  }

  function clean(value, depth = 0) {
    if (depth > 6) return "<max-depth>";
    if (typeof value === "string") return /^https?:\/\//i.test(value) ? redactUrl(value) : value.slice(0, 3000);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, depth + 1));
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 120)) output[key] = clean(item, depth + 1);
      return output;
    }
    return value;
  }

  function send(payload) {
    try { state.port?.postMessage({ nonce, ...payload }); } catch {}
  }

  function log(level, area, message, data, verbose = false) {
    if (verbose && !state.verbose) return;
    const event = { seq: ++state.seq, ts: new Date().toISOString(), level, area, message, data: clean(data) };
    localLog.textContent += `${event.ts.slice(11, 23)} ${level.toUpperCase()} [${area}] ${message}${data === undefined ? "" : `\n${JSON.stringify(event.data, null, 2)}`}\n`;
    localLog.scrollTop = localLog.scrollHeight;
    send({ type: "log", ...event, verbose });
  }

  function recordCandidate(url, kind, source) {
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    if (!/rumble|rmbl|\.m3u8|\.mp4|\.webm|\.aac|\.m4a|\.mp3|hls-vod/i.test(url)) return;
    if (state.candidates.some((item) => item.url === url && item.source === source)) return;
    const item = { url, kind: kind || classifyUrl(url), source, at: new Date().toISOString() };
    state.candidates.push(item);
    if (state.candidates.length > 300) state.candidates.shift();
    log("success", "candidate", `Discovered ${item.kind} candidate through ${source}.`, item, true);
    send({ type: "candidate", url: item.url, kind: item.kind, source: item.source, at: item.at });
  }

  function classifyUrl(url) {
    if (/\.m3u8(?:$|\?)/i.test(url) || /hls-vod/i.test(url)) return "hls";
    if (/\.(aac|m4a|mp3|opus)(?:$|\?)/i.test(url)) return "audio";
    if (/\.mp4(?:$|\?)/i.test(url)) return "mp4";
    if (/\.webm(?:$|\?)/i.test(url)) return "webm";
    if (/embedjs/i.test(url)) return "player-script-or-json";
    return "resource";
  }

  function rangeSnapshot(range) {
    const output = [];
    if (!range) return output;
    for (let i = 0; i < range.length; i += 1) output.push([Number(range.start(i).toFixed(3)), Number(range.end(i).toFixed(3))]);
    return output;
  }

  function mediaSnapshot(media = findMedia()) {
    if (!media) return null;
    return {
      tag: media.tagName.toLowerCase(),
      src: redactUrl(media.getAttribute("src") || ""),
      currentSrc: redactUrl(media.currentSrc || ""),
      rawSrc: state.fullUrls ? media.getAttribute("src") || "" : undefined,
      rawCurrentSrc: state.fullUrls ? media.currentSrc || "" : undefined,
      currentTime: Number.isFinite(media.currentTime) ? Number(media.currentTime.toFixed(3)) : String(media.currentTime),
      duration: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : String(media.duration),
      paused: media.paused,
      ended: media.ended,
      seeking: media.seeking,
      readyState: media.readyState,
      networkState: media.networkState,
      playbackRate: media.playbackRate,
      volume: media.volume,
      muted: media.muted,
      videoWidth: media.videoWidth || null,
      videoHeight: media.videoHeight || null,
      buffered: rangeSnapshot(media.buffered),
      seekable: rangeSnapshot(media.seekable),
      error: media.error ? { code: media.error.code, message: media.error.message } : null,
    };
  }

  function apiSnapshot() {
    if (!state.api) return null;
    const methods = [];
    let cursor = state.api;
    const seen = new Set();
    while (cursor && cursor !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(cursor)) {
        if (!seen.has(name) && typeof state.api[name] === "function") methods.push(name);
        seen.add(name);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    return { methods: methods.sort().slice(0, 200) };
  }

  function snapshot() {
    const media = findMedia();
    const result = {
      mode: state.mode,
      origin: location.origin,
      embedId: state.embedId,
      initialized: state.initialized,
      scriptLoaded: state.scriptLoaded,
      rumbleGlobalType: typeof window.Rumble,
      media: mediaSnapshot(media),
      api: apiSnapshot(),
      candidates: state.candidates.slice(-100).map(clean),
      recentResources: state.resources.slice(-100).map((url) => redactUrl(url)),
      playerHtmlPrefix: playerHost.innerHTML.slice(0, 700),
    };
    renderFacts(result);
    send({ type: "snapshot", snapshot: clean(result) });
    return result;
  }

  function renderFacts(result) {
    const flat = {
      mode: result.mode,
      origin: result.origin,
      embedId: result.embedId,
      initialized: result.initialized,
      scriptLoaded: result.scriptLoaded,
      rumbleGlobalType: result.rumbleGlobalType,
      mediaTag: result.media?.tag || null,
      mediaCurrentSrc: result.media?.currentSrc || null,
      mediaDuration: result.media?.duration ?? null,
      playbackRate: result.media?.playbackRate ?? null,
      candidates: result.candidates.length,
      apiMethods: result.api?.methods?.length || 0,
    };
    facts.innerHTML = Object.entries(flat).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value ?? "—"))}</dd>`).join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function findMedia() {
    const media = document.querySelector("#videoPlayer video, .video-player video, #rumble-player video, video, audio");
    if (media && state.media !== media) attachMedia(media);
    return media || state.media;
  }

  function attachMedia(media) {
    state.media = media;
    if (media.dataset.rumbleLabObserved === "1") return;
    media.dataset.rumbleLabObserved = "1";
    log("success", "dom", "Observed an HTML media element inserted by the player.", mediaSnapshot(media));
    recordCandidate(media.currentSrc || media.src, "media-src", "DOM discovery");
    const important = ["loadstart", "loadedmetadata", "canplay", "play", "playing", "pause", "waiting", "stalled", "ratechange", "seeking", "seeked", "ended", "error", "emptied"];
    for (const name of important) {
      media.addEventListener(name, () => {
        const snap = mediaSnapshot(media);
        recordCandidate(media.currentSrc || media.src, "media-src", `media event:${name}`);
        log(name === "error" ? "error" : ["waiting", "stalled"].includes(name) ? "warn" : ["playing", "loadedmetadata", "canplay"].includes(name) ? "success" : "info", "media", name, snap, !["error", "playing", "loadedmetadata", "canplay"].includes(name));
        if (["loadedmetadata", "canplay", "playing", "error"].includes(name)) snapshot();
      });
    }
  }

  function patchMethod(object, name, wrapper) {
    try {
      const original = object[name];
      if (typeof original !== "function") return;
      object[name] = wrapper(original);
      state.unpatch.push(() => { object[name] = original; });
      log("info", "instrument", `Patched ${name}.`, undefined, true);
    } catch (error) {
      log("warn", "instrument", `Could not patch ${name}.`, error, true);
    }
  }

  function patchSetter(proto, property, label) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor?.set || !descriptor.configurable) throw new Error("Setter is unavailable or non-configurable");
      Object.defineProperty(proto, property, {
        ...descriptor,
        set(value) {
          if (typeof value === "string") recordCandidate(value, classifyUrl(value), `${label}.${property} setter`);
          return descriptor.set.call(this, value);
        },
      });
      state.unpatch.push(() => Object.defineProperty(proto, property, descriptor));
      log("info", "instrument", `Patched ${label}.${property} setter.`, undefined, true);
    } catch (error) {
      log("warn", "instrument", `Could not patch ${label}.${property}.`, error, true);
    }
  }

  function installInstrumentation() {
    if (state.unpatch.length) return;

    patchSetter(HTMLMediaElement.prototype, "src", "HTMLMediaElement");
    if (window.HTMLSourceElement) patchSetter(HTMLSourceElement.prototype, "src", "HTMLSourceElement");

    patchMethod(Element.prototype, "setAttribute", (original) => function(name, value) {
      if (String(name).toLowerCase() === "src" && typeof value === "string") recordCandidate(value, classifyUrl(value), `${this.tagName || "element"}.setAttribute`);
      return original.apply(this, arguments);
    });

    patchMethod(Node.prototype, "appendChild", (original) => function(node) {
      if (node?.src) recordCandidate(node.src, classifyUrl(node.src), `appendChild:${node.tagName || node.nodeName}`);
      return original.apply(this, arguments);
    });

    patchMethod(URL, "createObjectURL", (original) => function(object) {
      const url = original.apply(this, arguments);
      log("info", "instrument", "URL.createObjectURL called.", { result: url, objectType: object?.type || object?.constructor?.name }, true);
      return url;
    });

    patchMethod(window, "fetch", (original) => function(input, init) {
      const url = typeof input === "string" ? input : input?.url;
      if (url) {
        state.resources.push(url);
        recordCandidate(url, classifyUrl(url), "fetch");
        log("info", "network", "fetch called.", { url: redactUrl(url), method: init?.method || input?.method || "GET", mode: init?.mode || input?.mode }, true);
      }
      return original.apply(this, arguments);
    });

    patchMethod(XMLHttpRequest.prototype, "open", (original) => function(method, url) {
      if (url) {
        try {
          const absolute = new URL(url, location.href).href;
          state.resources.push(absolute);
          recordCandidate(absolute, classifyUrl(absolute), "XMLHttpRequest.open");
          log("info", "network", "XHR opened.", { method, url: redactUrl(absolute) }, true);
        } catch (error) {
          log("warn", "network", "XHR URL instrumentation could not normalize a URL.", { method, url: String(url), error }, true);
        }
      }
      return original.apply(this, arguments);
    });

    const domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.("video,audio")) attachMedia(node);
          node.querySelectorAll?.("video,audio").forEach(attachMedia);
          if (node.src) recordCandidate(node.src, classifyUrl(node.src), `MutationObserver:${node.tagName}`);
        }
      }
      findMedia();
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    state.unpatch.push(() => domObserver.disconnect());

    if (window.PerformanceObserver) {
      try {
        const perf = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.resources.push(entry.name);
            recordCandidate(entry.name, classifyUrl(entry.name), `PerformanceObserver:${entry.initiatorType}`);
          }
        });
        perf.observe({ type: "resource", buffered: true });
        state.unpatch.push(() => perf.disconnect());
      } catch (error) {
        log("warn", "instrument", "PerformanceObserver resource mode failed.", error, true);
      }
    }

    log("success", "instrument", "Browser instrumentation installed.");
  }

  function removeInstrumentation() {
    while (state.unpatch.length) {
      try { state.unpatch.pop()(); } catch {}
    }
    log("info", "instrument", "Browser instrumentation removed.");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = src;
      script.onload = () => resolve(script);
      script.onerror = () => reject(new Error(`Script failed to load: ${redactUrl(src)}`));
      document.head.append(script);
    });
  }

  async function loadRumbleBootstrap() {
    if (state.scriptLoaded && typeof window.Rumble === "function") return;
    const candidates = [
      `https://rumble.com/embedJS/${state.embedId}`,
      `https://rumble.com/embedJS/${state.embedId}/`,
    ];
    let lastError = null;
    for (const src of candidates) {
      try {
        log("info", "bootstrap", "Loading Rumble classic player script.", { src });
        await loadScript(src);
        state.scriptLoaded = true;
        log("success", "bootstrap", "Rumble script load event fired.", { src, rumbleType: typeof window.Rumble });
        if (typeof window.Rumble === "function") return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (typeof window.Rumble === "function") return;
        lastError = new Error("Script loaded but window.Rumble was not a function");
      } catch (error) {
        lastError = error;
        log("warn", "bootstrap", "Rumble script candidate failed.", { src, error });
      }
    }
    throw lastError || new Error("Unable to load Rumble player bootstrap");
  }

  function attachApi(api) {
    state.api = api;
    const events = ["play", "pause", "videoEnd", "ended", "ready", "timeupdate", "error", "buffering"];
    if (typeof api?.on === "function") {
      for (const eventName of events) {
        try {
          api.on(eventName, (data) => {
            log(eventName === "error" ? "error" : ["play", "ready"].includes(eventName) ? "success" : "info", "api-event", eventName, data, !["error", "play", "ready", "videoEnd", "ended"].includes(eventName));
            findMedia();
            if (["ready", "play", "videoEnd", "ended", "error"].includes(eventName)) snapshot();
          });
        } catch (error) {
          log("warn", "api", `Could not register ${eventName}.`, error, true);
        }
      }
    }
    log("success", "api", "Rumble API callback supplied a player object.", apiSnapshot());
  }

  async function initializePlayer() {
    if (!state.embedId) throw new Error("The parent has not supplied an embed ID");
    if (state.initialized) {
      log("warn", "bootstrap", "Player is already initialized.");
      return;
    }
    installInstrumentation();
    await loadRumbleBootstrap();
    if (typeof window.Rumble !== "function") throw new Error("window.Rumble is unavailable after script loading");

    playerHost.innerHTML = "";
    const host = document.createElement("div");
    host.id = `rumble_${state.embedId}`;
    host.style.width = "100%";
    host.style.minHeight = "290px";
    playerHost.append(host);

    let callbackCount = 0;
    const options = {
      video: state.embedId,
      div: host.id,
      rel: 0,
      autoplay: 0,
      ui: {
        logo: { hidden: false },
        fullscreen: { hidden: false },
        autoplay: { hidden: true },
      },
      api(api) {
        callbackCount += 1;
        if (!state.api) attachApi(api);
        log("info", "api", `Rumble API callback invocation ${callbackCount}.`, apiSnapshot(), true);
        setTimeout(() => { findMedia(); snapshot(); }, 200);
      },
    };

    log("info", "bootstrap", "Calling window.Rumble('play', options).", { options: { ...options, api: "<callback>" } });
    window.Rumble("play", options);
    state.initialized = true;
    $("#lab-mode").textContent = `${state.mode}; initialized`;
    setTimeout(() => { findMedia(); snapshot(); }, 800);
    setTimeout(() => { findMedia(); snapshot(); }, 2500);
  }

  function callApi(method, ...args) {
    const media = findMedia();
    if (media) {
      if (method === "play") return media.play();
      if (method === "pause") return media.pause();
      if (method === "back") { media.currentTime = Math.max(0, media.currentTime - 15); return; }
      if (method === "forward") { media.currentTime = Math.min(Number.isFinite(media.duration) ? media.duration : Infinity, media.currentTime + 30); return; }
      if (method === "rate") { media.playbackRate = media.playbackRate === 1.5 ? 1 : 1.5; if ("preservesPitch" in media) media.preservesPitch = true; return; }
    }
    const api = state.api;
    if (!api) throw new Error("No media element or Rumble API is ready");
    if (method === "play" && typeof api.play === "function") return api.play();
    if (method === "pause" && typeof api.pause === "function") return api.pause();
    if (["back", "forward"].includes(method) && typeof api.getCurrentTime === "function" && typeof api.setCurrentTime === "function") {
      const current = Number(api.getCurrentTime()) || 0;
      return api.setCurrentTime(Math.max(0, current + (method === "back" ? -15 : 30)));
    }
    if (method === "rate") throw new Error("No direct media element is available for playbackRate");
    if (typeof api[method] === "function") return api[method](...args);
    throw new Error(`Unsupported command: ${method}`);
  }

  function destroyPlayer() {
    try { state.media?.pause(); } catch {}
    try { state.api?.pause?.(); } catch {}
    playerHost.innerHTML = `<p class="message">Player destroyed. Reload the lab frame to perform a clean second run.</p>`;
    state.api = null;
    state.media = null;
    state.initialized = false;
    removeInstrumentation();
    snapshot();
  }

  async function execute(command) {
    try {
      if (command === "inspect") return snapshot();
      if (command === "destroy") return destroyPlayer();
      const result = callApi(command);
      if (result?.then) await result;
      log("success", "control", `Command completed: ${command}.`, mediaSnapshot(findMedia()));
      snapshot();
    } catch (error) {
      log("error", "control", `Command failed: ${command}.`, error);
      send({ type: "error", message: `${command}: ${error.message}` });
    }
  }

  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "rumble-lab-connect" || data.nonce !== nonce || !event.ports?.[0]) return;
    state.port = event.ports[0];
    state.port.onmessage = (portEvent) => {
      const message = portEvent.data;
      if (!message || message.nonce !== nonce) return;
      if (message.type === "init") {
        state.embedId = message.embedId;
        state.mode = message.mode;
        state.verbose = message.verbose !== false;
        state.fullUrls = message.fullUrls === true;
        $("#lab-mode").textContent = `${state.mode}; ID ${state.embedId}`;
        log("success", "bridge", "Private MessageChannel connected.", { mode: state.mode, embedId: state.embedId, origin: location.origin });
        send({ type: "ready" });
      } else if (message.type === "command") {
        execute(message.command);
      }
    };
    state.port.start();
  });

  $("#initialize").addEventListener("click", () => initializePlayer().catch((error) => {
    log("error", "bootstrap", "Player initialization failed.", error);
    send({ type: "error", message: `Initialization failed: ${error.message}` });
  }));
  $("#play").addEventListener("click", () => execute("play"));
  $("#pause").addEventListener("click", () => execute("pause"));
  $("#back").addEventListener("click", () => execute("back"));
  $("#forward").addEventListener("click", () => execute("forward"));
  $("#rate").addEventListener("click", () => execute("rate"));
  $("#inspect").addEventListener("click", () => execute("inspect"));
  $("#destroy").addEventListener("click", () => execute("destroy"));

  log("info", "startup", "Player laboratory document loaded.", { noncePresent: Boolean(nonce), origin: location.origin });
})();
