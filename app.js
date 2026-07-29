const APP_VERSION = "0.3.0-capability-lab";
const EXAMPLE_EMBED = "https://rumble.com/embed/v5a6o71/";
const DB_NAME = "rumble-capability-lab";
const DB_VERSION = 1;
const RUN_STORE = "runs";
const MAX_SAVED_RUNS = 20;
const MEDIA_EVENT_NAMES = [
  "loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay",
  "canplaythrough", "play", "playing", "pause", "waiting", "stalled",
  "suspend", "seeking", "seeked", "ratechange", "volumechange", "ended",
  "emptied", "abort", "error"
];

const TEST_DEFINITIONS = [
  ["environment", "Environment", "Secure context, PWA mode, browser APIs and native HLS declarations."],
  ["url-parse", "URL parsing", "Classify the URL and extract public or internal Rumble identifiers."],
  ["slug-cors", "Slug resolver CORS", "Fetch /embed/slug/ candidates and parse an internal player ID."],
  ["oembed-cors", "oEmbed CORS", "Read Rumble oEmbed directly from the static page."],
  ["embedjs-cors", "Player JSON CORS", "Read embedJS player metadata and enumerate media candidates."],
  ["deterministic-hls", "Deterministic HLS", "Construct /hls-vod/<id>/playlist.m3u8 without a metadata service."],
  ["audio-media", "Native audio", "Load a direct audio or HLS candidate in a persistent audio element."],
  ["video-media", "Native video/HLS", "Load the HLS candidate using Safari's native media engine."],
  ["lab-sandbox", "Sandboxed player lab", "Run the Rumble script in an opaque-origin sandbox."],
  ["lab-origin", "Same-origin player lab", "Fallback lab with DOM and network instrumentation."],
  ["sw-observer", "Service-worker observer", "Observe request URLs without relaying or caching media."],
  ["storage", "Local persistence", "IndexedDB, quota estimate and persistent-storage capability."],
  ["media-session", "Media Session", "Lock-screen metadata and action-handler availability."],
];

const state = {
  sequence: 0,
  events: [],
  tests: new Map(),
  parsed: null,
  metadata: null,
  candidates: [],
  activeControllers: new Set(),
  runId: crypto.randomUUID?.() || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  runStartedAt: new Date().toISOString(),
  lastSummary: null,
  lab: null,
  swMessages: 0,
  mediaThrottle: new WeakMap(),
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  url: $("#rumble-url"),
  testGrid: $("#test-grid"),
  log: $("#log-output"),
  filter: $("#log-filter"),
  eventCount: $("#event-count"),
  copyStatus: $("#copy-status"),
  audio: $("#audio-probe"),
  video: $("#video-probe"),
  audioFacts: $("#audio-facts"),
  videoFacts: $("#video-facts"),
  labFacts: $("#lab-facts"),
  labShell: $("#lab-shell"),
  labPlaceholder: $("#lab-placeholder"),
  history: $("#history-list"),
  fullUrls: $("#opt-full-urls"),
  swObserve: $("#opt-sw-observe"),
  autoPlay: $("#opt-auto-play"),
  saveRuns: $("#opt-save-runs"),
  verbose: $("#opt-verbose"),
};

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack };
      }
      if (typeof item === "bigint") return item.toString();
      return item;
    }));
  } catch {
    return fallback;
  }
}

function redactUrl(raw, forceFull = false) {
  if (!raw || typeof raw !== "string") return raw;
  if (forceFull || elements.fullUrls?.checked) return raw;
  try {
    const url = new URL(raw, location.href);
    if (url.origin === location.origin) return `${url.origin}${url.pathname}`;
    const params = [...url.searchParams.keys()];
    const suffix = params.length ? `?${params.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : "";
    return `${url.origin}${url.pathname}${suffix}`;
  } catch {
    return raw.replace(/([?&][^=\s]+)=([^&\s]+)/g, "$1=<redacted>");
  }
}

function sanitizeData(value, forceFull = false, depth = 0) {
  if (depth > 7) return "<max-depth>";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return redactUrl(value, forceFull);
    return value.length > 4000 ? `${value.slice(0, 4000)}…<truncated>` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeData(item, forceFull, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 150)) {
      output[key] = sanitizeData(item, forceFull, depth + 1);
    }
    return output;
  }
  return value;
}

function log(level, area, message, data = undefined, { verbose = false } = {}) {
  if (verbose && !elements.verbose.checked) return;
  const event = {
    seq: ++state.sequence,
    ts: nowIso(),
    level,
    area,
    message,
    data: data === undefined ? undefined : sanitizeData(data),
  };
  state.events.push(event);
  if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000);
  renderLog();
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](`[Rumble Lab:${area}] ${message}`, data ?? "");
  return event;
}

function renderLog() {
  const query = elements.filter.value.trim().toLowerCase();
  const lines = state.events
    .filter((event) => {
      if (!query) return true;
      return JSON.stringify(event).toLowerCase().includes(query);
    })
    .map((event) => {
      const stamp = event.ts.slice(11, 23);
      const head = `${stamp} #${String(event.seq).padStart(4, "0")} ${event.level.toUpperCase().padEnd(7)} [${event.area}] ${event.message}`;
      if (event.data === undefined) return head;
      return `${head}\n${JSON.stringify(event.data, null, 2).split("\n").map((line) => `  ${line}`).join("\n")}`;
    });
  elements.log.textContent = lines.join("\n");
  elements.eventCount.textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"}`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setTest(id, status, detail = "") {
  const existing = state.tests.get(id) || {};
  state.tests.set(id, { ...existing, status, detail, updatedAt: nowIso() });
  const card = elements.testGrid.querySelector(`[data-test-id="${CSS.escape(id)}"]`);
  if (card) {
    card.dataset.status = status;
    $("p", card).textContent = detail || TEST_DEFINITIONS.find(([key]) => key === id)?.[2] || "";
  }
  log(status === "fail" ? "error" : status === "warn" ? "warn" : status === "pass" ? "success" : "info", "test", `${id}: ${status}`, detail, { verbose: status === "idle" });
}

function initializeTests() {
  elements.testGrid.innerHTML = "";
  for (const [id, title, description] of TEST_DEFINITIONS) {
    state.tests.set(id, { status: "idle", detail: description, updatedAt: nowIso() });
    const card = document.createElement("article");
    card.className = "test-card";
    card.dataset.testId = id;
    card.dataset.status = "idle";
    card.innerHTML = `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>`;
    elements.testGrid.append(card);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function toast(message) {
  const existing = $(".toast");
  existing?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

function setCopyStatus(message, isError = false) {
  elements.copyStatus.textContent = message;
  elements.copyStatus.style.color = isError ? "var(--danger)" : "var(--success)";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    if (!ok) throw new Error("Clipboard write failed");
  }
}

function timeoutSignal(ms, label = "request") {
  const controller = new AbortController();
  state.activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(new DOMException(`${label} timed out after ${ms} ms`, "TimeoutError")), ms);
  return {
    signal: controller.signal,
    finish() {
      clearTimeout(timer);
      state.activeControllers.delete(controller);
    },
  };
}

function stopAll() {
  for (const controller of state.activeControllers) controller.abort(new DOMException("Stopped by user", "AbortError"));
  state.activeControllers.clear();
  for (const media of [elements.audio, elements.video]) {
    try {
      media.pause();
      media.removeAttribute("src");
      media.load();
    } catch {}
  }
  sendLabCommand("destroy");
  log("warn", "control", "All active requests and media probes were stopped by the user.");
  toast("Stopped all activity");
}

function parseRumbleUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a Rumble URL or internal embed ID first.");
  if (/^v[a-z0-9]+$/i.test(trimmed)) {
    return {
      raw: trimmed,
      canonicalUrl: `https://rumble.com/embed/${trimmed}/`,
      host: "rumble.com",
      type: "bare-embed-id",
      publicId: null,
      publicSlug: null,
      embedId: trimmed,
      publisherPrefix: null,
      resolutionSource: "bare embed ID",
    };
  }
  const url = new URL(trimmed);
  const host = url.hostname.toLowerCase();
  const isRumble = host === "rumble.com" || host.endsWith(".rumble.com");
  if (!isRumble) throw new Error(`Unsupported hostname: ${host}`);

  const parts = url.pathname.split("/").filter(Boolean);
  let embedId = null;
  let publisherPrefix = null;
  let publicId = null;
  let publicSlug = null;
  let type = "unknown-rumble";

  if (parts[0] === "embed") {
    type = parts[1] === "slug" ? "slug-resolver" : "embed";
    if (parts[1] === "slug") {
      publicSlug = parts[2] || null;
      publicId = publicSlug?.match(/^(v[a-z0-9]+)/i)?.[1] || null;
    } else {
      const value = parts[1] || url.searchParams.get("v") || "";
      const idMatch = value.match(/^(?:([a-z0-9]+)\.)?(v[a-z0-9]+)$/i);
      if (idMatch) {
        publisherPrefix = idMatch[1] || null;
        embedId = idMatch[2];
      }
    }
  } else {
    const basename = parts[0] || "";
    const publicMatch = basename.match(/^(v[a-z0-9]+)(?:-|\.html|$)/i);
    if (publicMatch) {
      type = "watch-page";
      publicId = publicMatch[1];
      publicSlug = basename.replace(/\.html$/i, "");
    } else if (parts[0] === "video" && parts[1]) {
      type = "alternate-video-page";
      publicSlug = parts[1].replace(/\.html$/i, "");
      publicId = publicSlug.match(/^(v[a-z0-9]+)/i)?.[1] || null;
    }
  }

  const queryId = url.searchParams.get("v");
  if (!embedId && queryId && /^v[a-z0-9]+$/i.test(queryId)) embedId = queryId;

  return {
    raw: trimmed,
    canonicalUrl: `${url.origin}${url.pathname}`,
    host,
    type,
    publicId,
    publicSlug,
    embedId,
    publisherPrefix,
    resolutionSource: embedId ? "input URL" : null,
  };
}

function updateIdentity(parsed = state.parsed) {
  $("#identity-type").textContent = parsed?.type || "—";
  $("#identity-public").textContent = parsed?.publicSlug || parsed?.publicId || "—";
  $("#identity-embed").textContent = parsed?.embedId || "—";
  $("#identity-source").textContent = parsed?.resolutionSource || "—";
}

function parseInput({ silent = false } = {}) {
  try {
    const parsed = parseRumbleUrl(elements.url.value);
    state.parsed = parsed;
    state.metadata = null;
    state.candidates = [];
    updateIdentity(parsed);
    setTest("url-parse", "pass", `${parsed.type}; embed ID ${parsed.embedId || "not yet known"}.`);
    log("success", "resolver", "Parsed Rumble URL.", parsed);
    if (!silent) toast("Rumble URL parsed");
    return parsed;
  } catch (error) {
    state.parsed = null;
    updateIdentity(null);
    setTest("url-parse", "fail", error.message);
    log("error", "resolver", "URL parsing failed.", error);
    if (!silent) toast(error.message);
    return null;
  }
}

function extractEmbedIdFromText(text) {
  if (!text) return null;
  const patterns = [
    /["']embedUrl["']\s*:\s*["'][^"']*?\/embed\/(?:[a-z0-9]+\.)?(v[a-z0-9]+)/i,
    /Rumble\s*\(\s*["']play["']\s*,\s*\{[\s\S]{0,500}?["']?video["']?\s*:\s*["'](v[a-z0-9]+)/i,
    /data-video=["'](v[a-z0-9]+)["']/i,
    /id=["']vid_(v[a-z0-9]+)["']/i,
    /rumble\.com\/embed\/(?:[a-z0-9]+\.)?(v[a-z0-9]+)/i,
    /["']video["']\s*:\s*["'](v[a-z0-9]+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function acceptResolvedId(embedId, source) {
  if (!/^v[a-z0-9]+$/i.test(embedId || "")) return false;
  state.parsed = state.parsed || {};
  state.parsed.embedId = embedId;
  state.parsed.resolutionSource = source;
  updateIdentity();
  log("success", "resolver", `Resolved internal embed ID through ${source}.`, { embedId });
  return true;
}

async function fetchText(url, { timeout = 10000, area = "network", headers = {}, mode = "cors" } = {}) {
  const guard = timeoutSignal(timeout, url);
  const started = performance.now();
  log("info", area, "Fetching text resource.", { url: redactUrl(url), mode });
  try {
    const response = await fetch(url, {
      method: "GET",
      mode,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "strict-origin-when-cross-origin",
      headers,
      signal: guard.signal,
    });
    const text = await response.text();
    log(response.ok ? "success" : "warn", area, "Text response received.", {
      url: redactUrl(url),
      status: response.status,
      type: response.type,
      redirected: response.redirected,
      finalUrl: redactUrl(response.url),
      bytes: text.length,
      elapsedMs: Math.round(performance.now() - started),
      contentType: response.headers.get("content-type"),
      accessControlAllowOrigin: response.headers.get("access-control-allow-origin"),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, text };
  } finally {
    guard.finish();
  }
}

async function fetchJson(url, options = {}) {
  const { response, text } = await fetchText(url, options);
  try {
    return { response, data: JSON.parse(text), text };
  } catch (error) {
    log("error", options.area || "network", "Response was not valid JSON.", { url: redactUrl(url), prefix: text.slice(0, 180), error });
    throw new Error(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

async function resolveThroughSlug() {
  const parsed = state.parsed;
  if (!parsed) throw new Error("Parse the input first.");
  if (parsed.embedId) {
    setTest("slug-cors", "warn", "Skipped because the input already contained an embed ID.");
    return parsed.embedId;
  }
  const candidates = [...new Set([parsed.publicSlug, parsed.publicId].filter(Boolean))];
  if (!candidates.length) {
    setTest("slug-cors", "warn", "No public slug was available for this input.");
    return null;
  }
  setTest("slug-cors", "running", `Trying ${candidates.length} slug candidate(s).`);
  for (const slug of candidates) {
    const url = `https://rumble.com/embed/slug/${encodeURIComponent(slug)}`;
    try {
      const { text } = await fetchText(url, { area: "slug-cors", timeout: 10000 });
      const embedId = extractEmbedIdFromText(text);
      if (embedId) {
        acceptResolvedId(embedId, `/embed/slug/${slug}`);
        setTest("slug-cors", "pass", `CORS-readable slug route resolved ${embedId}.`);
        return embedId;
      }
      log("warn", "slug-cors", "Slug response was readable but no internal embed ID was recognized.", { slug, prefix: text.slice(0, 240) });
    } catch (error) {
      log("warn", "slug-cors", "Slug candidate failed.", { slug, error });
    }
  }
  setTest("slug-cors", "fail", "No CORS-readable slug candidate produced an internal embed ID.");
  return null;
}

async function resolveThroughOembed() {
  const parsed = state.parsed;
  if (!parsed) throw new Error("Parse the input first.");
  setTest("oembed-cors", "running", "Requesting Rumble oEmbed directly.");
  const endpoint = `https://rumble.com/api/Media/oembed.json?url=${encodeURIComponent(parsed.raw)}`;
  try {
    const { data } = await fetchJson(endpoint, { area: "oembed-cors", timeout: 10000 });
    const embedId = extractEmbedIdFromText(data?.html || "") || data?.embedId || null;
    if (embedId) acceptResolvedId(embedId, "direct oEmbed");
    if (data?.title || embedId) {
      state.metadata = {
        ...(state.metadata || {}),
        oembed: sanitizeData({
          title: data.title,
          author_name: data.author_name,
          thumbnail_url: data.thumbnail_url,
          duration: data.duration,
          provider_name: data.provider_name,
          width: data.width,
          height: data.height,
          embedId,
        }),
      };
      setTest("oembed-cors", "pass", embedId ? `Readable; resolved ${embedId}.` : "Readable metadata, but no embed ID was parsed.");
      return embedId;
    }
    throw new Error("oEmbed returned no recognized metadata");
  } catch (error) {
    setTest("oembed-cors", "fail", `${error.name || "Error"}: ${error.message}`);
    log("warn", "oembed-cors", "Direct oEmbed probe failed; this is expected when CORS is absent.", error);
    return null;
  }
}

function walkMediaCandidates(node, path = [], output = []) {
  if (!node || output.length > 300) return output;
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node)) {
      const keyPath = path.join(".").toLowerCase();
      let kind = "other";
      if (keyPath.includes("audio") || /\.(aac|m4a|mp3|opus)(?:$|\?)/i.test(node)) kind = "audio";
      else if (keyPath.includes("hls") || /\.m3u8(?:$|\?)/i.test(node)) kind = "hls";
      else if (keyPath.includes("mp4") || /\.mp4(?:$|\?)/i.test(node)) kind = "mp4";
      else if (keyPath.includes("webm") || /\.webm(?:$|\?)/i.test(node)) kind = "webm";
      output.push({ kind, url: node, path: path.join("."), meta: {}, bitrate: null, width: null, height: null, live: null, hint: keyPath.includes("auto") ? "auto" : null });
    }
    return output;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkMediaCandidates(item, [...path, String(index)], output));
    return output;
  }
  if (typeof node !== "object") return output;

  if (typeof node.url === "string" && /^https?:\/\//i.test(node.url)) {
    const keyPath = path.join(".").toLowerCase();
    const url = node.url;
    const lower = `${keyPath} ${url}`.toLowerCase();
    let kind = "other";
    if (keyPath.includes("audio") || /\.(aac|m4a|mp3|opus)(?:$|\?)/i.test(url)) kind = "audio";
    else if (keyPath.includes("hls") || /\.m3u8(?:$|\?)/i.test(url)) kind = "hls";
    else if (keyPath.includes("mp4") || /\.mp4(?:$|\?)/i.test(url)) kind = "mp4";
    else if (keyPath.includes("webm") || /\.webm(?:$|\?)/i.test(url)) kind = "webm";
    output.push({
      kind,
      url,
      path: path.join("."),
      meta: sanitizeData(node.meta || {}),
      bitrate: node.meta?.bitrate || node.bitrate || null,
      width: node.meta?.w || node.width || null,
      height: node.meta?.h || node.height || null,
      live: node.meta?.live ?? null,
      hint: lower.includes("auto") ? "auto" : null,
    });
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "url" || key === "meta") continue;
    if (value && typeof value === "object") walkMediaCandidates(value, [...path, key], output);
  }
  return output;
}

function normalizeMetadata(data, sourceUrl) {
  const candidates = walkMediaCandidates(data);
  if (typeof data?.u === "string" && /^https?:\/\//i.test(data.u)) {
    candidates.push({ kind: /m3u8/i.test(data.u) ? "hls" : "other", url: data.u, path: "u", meta: {} });
  }
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      deduped.push(candidate);
    }
  }
  return {
    sourceUrl,
    title: data?.title || null,
    author: typeof data?.author === "object" ? data.author.name : data?.author || null,
    authorUrl: typeof data?.author === "object" ? data.author.url : null,
    duration: Number(data?.duration) || null,
    thumbnail: data?.i || data?.thumbnail || null,
    pubDate: data?.pubDate || null,
    live: data?.live ?? null,
    vid: data?.vid || null,
    link: data?.l || data?.share_url || null,
    candidates: deduped,
    topLevelKeys: Object.keys(data || {}),
  };
}

async function probeEmbedJson({ deep = false } = {}) {
  const id = state.parsed?.embedId;
  if (!id) {
    setTest("embedjs-cors", "warn", "No internal embed ID is available yet.");
    return null;
  }
  setTest("embedjs-cors", "running", deep ? "Trying a bounded u1–u10 shard sweep." : "Trying the canonical u3 metadata endpoint.");
  const shards = deep ? ["u3", "u4", "u2", "u6", "u7", "u8", "u9", "u10", "u1", "u5"] : ["u3"];
  const ids = [...new Set([id, id.replace(/^v/i, "")])];
  for (const candidateId of ids) {
    for (const shard of shards) {
      const endpoint = `https://rumble.com/embedJS/${shard}/?request=video&ver=2&v=${encodeURIComponent(candidateId)}`;
      try {
        const { data, text } = await fetchJson(endpoint, { area: "embedjs-cors", timeout: deep ? 5000 : 9000 });
        if (!data || data === false || typeof data !== "object") {
          log("warn", "embedjs-cors", "Metadata endpoint returned no usable object.", { shard, candidateId, prefix: text.slice(0, 120) });
          continue;
        }
        const normalized = normalizeMetadata(data, endpoint);
        if (!normalized.candidates.length && !normalized.title) {
          log("warn", "embedjs-cors", "Metadata object had no recognized title or media candidates.", normalized);
          continue;
        }
        state.metadata = { ...(state.metadata || {}), player: normalized };
        state.candidates = normalized.candidates;
        setTest("embedjs-cors", "pass", `${shard} returned ${normalized.candidates.length} media candidate(s).`);
        log("success", "embedjs-cors", "Rumble player metadata was CORS-readable.", normalized);
        updateMediaSession(normalized);
        return normalized;
      } catch (error) {
        log("warn", "embedjs-cors", "Metadata candidate failed.", { shard, candidateId, error });
      }
    }
  }
  setTest("embedjs-cors", "fail", `${shards.length} shard route(s) were not readable or returned no usable metadata.`);
  return null;
}

function deterministicHlsUrl(id = state.parsed?.embedId) {
  if (!id) return null;
  return `https://rumble.com/hls-vod/${id.replace(/^v/i, "")}/playlist.m3u8`;
}

function selectCandidate(kind) {
  const candidates = state.candidates || [];
  const exact = candidates.filter((candidate) => candidate.kind === kind);
  exact.sort((a, b) => (Number(a.bitrate) || Infinity) - (Number(b.bitrate) || Infinity));
  return exact[0] || null;
}

async function runEnvironmentTests() {
  setTest("environment", "running", "Collecting browser and media declarations.");
  const displayMode = getDisplayMode();
  const hlsTypes = {
    appleMpegUrl: elements.audio.canPlayType("application/vnd.apple.mpegurl"),
    xMpegUrl: elements.audio.canPlayType("application/x-mpegURL"),
    mp4Audio: elements.audio.canPlayType("audio/mp4; codecs=mp4a.40.2"),
    mp4Video: elements.video.canPlayType("video/mp4; codecs=avc1.42E01E,mp4a.40.2"),
  };
  const report = {
    appVersion: APP_VERSION,
    href: redactUrl(location.href),
    secureContext: isSecureContext,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayMode,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
    APIs: {
      serviceWorker: "serviceWorker" in navigator,
      mediaSession: "mediaSession" in navigator,
      indexedDB: "indexedDB" in window,
      storageManager: "storage" in navigator,
      performanceObserver: "PerformanceObserver" in window,
      broadcastChannel: "BroadcastChannel" in window,
      locks: Boolean(navigator.locks),
      messageChannel: "MessageChannel" in window,
      webShare: Boolean(navigator.share),
      mediaSource: "MediaSource" in window,
      managedMediaSource: "ManagedMediaSource" in window,
    },
    hlsTypes,
  };
  log("success", "environment", "Environment report collected.", report);
  const nativeHls = Boolean(hlsTypes.appleMpegUrl || hlsTypes.xMpegUrl);
  setTest("environment", isSecureContext && nativeHls ? "pass" : "warn", `Secure=${isSecureContext}; display=${displayMode}; native HLS declaration=${nativeHls}.`);
  updateBadges();
  return report;
}

function getDisplayMode() {
  if (navigator.standalone) return "standalone-ios";
  const modes = ["fullscreen", "standalone", "minimal-ui", "browser"];
  return modes.find((mode) => matchMedia(`(display-mode: ${mode})`).matches) || "unknown";
}

async function testStorage() {
  setTest("storage", "running", "Opening IndexedDB and requesting storage details.");
  try {
    const db = await openDb();
    db.close();
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    let persistRequest = null;
    if (navigator.storage?.persist && !persisted) {
      try { persistRequest = await navigator.storage.persist(); } catch (error) { persistRequest = { error: error.message }; }
    }
    const report = { indexedDB: true, estimate, persisted, persistRequest };
    log("success", "storage", "Local storage capability report.", report);
    setTest("storage", "pass", `IndexedDB opened; persisted=${persisted ?? "unknown"}.`);
    return report;
  } catch (error) {
    setTest("storage", "fail", error.message);
    log("error", "storage", "Storage test failed.", error);
    return null;
  }
}

function testMediaSession() {
  if (!("mediaSession" in navigator)) {
    setTest("media-session", "fail", "navigator.mediaSession is unavailable.");
    return false;
  }
  try {
    updateMediaSession(state.metadata?.player || state.metadata?.oembed || {});
    const handlers = {
      play: () => activeMedia()?.play().catch((error) => log("warn", "media-session", "Play handler failed.", error)),
      pause: () => activeMedia()?.pause(),
      seekbackward: (event) => seekActive(-(event.seekOffset || 15)),
      seekforward: (event) => seekActive(event.seekOffset || 30),
      seekto: (event) => {
        const media = activeMedia();
        if (media && Number.isFinite(event.seekTime)) media.currentTime = event.seekTime;
      },
    };
    const results = {};
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
        results[action] = "registered";
      } catch (error) {
        results[action] = `${error.name}: ${error.message}`;
      }
    }
    log("success", "media-session", "Media Session handlers tested.", results);
    setTest("media-session", "pass", `Available; ${Object.values(results).filter((value) => value === "registered").length}/${Object.keys(results).length} handlers registered.`);
    return true;
  } catch (error) {
    setTest("media-session", "warn", error.message);
    log("warn", "media-session", "Media Session exists but setup was incomplete.", error);
    return false;
  }
}

function updateMediaSession(metadata = {}) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadata.title || "Rumble Capability Test",
      artist: metadata.author || metadata.author_name || "Rumble",
      album: "Rumble Capability Lab",
      artwork: metadata.thumbnail || metadata.thumbnail_url ? [
        { src: metadata.thumbnail || metadata.thumbnail_url, sizes: "512x512" },
      ] : [{ src: "./icon-512.png", sizes: "512x512", type: "image/png" }],
    });
  } catch (error) {
    log("warn", "media-session", "Setting MediaMetadata failed.", error, { verbose: true });
  }
}

function activeMedia() {
  if (!elements.audio.paused && elements.audio.currentSrc) return elements.audio;
  if (!elements.video.paused && elements.video.currentSrc) return elements.video;
  if (elements.audio.currentSrc) return elements.audio;
  if (elements.video.currentSrc) return elements.video;
  return null;
}

function seekActive(delta) {
  const media = activeMedia();
  if (!media) return;
  media.currentTime = Math.max(0, Math.min(Number.isFinite(media.duration) ? media.duration : Infinity, media.currentTime + delta));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !isSecureContext) {
    setTest("sw-observer", "warn", "Service workers require HTTPS or localhost and browser support.");
    updateBadges();
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    setTest("sw-observer", "pass", `Registered with scope ${registration.scope}. Reload once if this is the first visit.`);
    log("success", "service-worker", "Service worker registered.", { scope: registration.scope, controller: Boolean(navigator.serviceWorker.controller) });
    configureSwObserver();
    updateBadges();
    return registration;
  } catch (error) {
    setTest("sw-observer", "fail", error.message);
    log("error", "service-worker", "Registration failed.", error);
    updateBadges();
    return null;
  }
}

function configureSwObserver() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return;
  worker.postMessage({ type: "set-diagnostics", enabled: elements.swObserve.checked });
  log("info", "service-worker", `Network observation ${elements.swObserve.checked ? "enabled" : "disabled"}.`);
}

function attachSwMessages() {
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "sw-fetch-observed") return;
    state.swMessages += 1;
    log("info", "sw-fetch", `${data.destination || data.mode || "resource"} request observed.`, data, { verbose: true });
  });
}

function chooseMediaProbeUrls() {
  const audioCandidate = selectCandidate("audio");
  const hlsCandidate = selectCandidate("hls");
  const deterministic = deterministicHlsUrl();
  return {
    audio: audioCandidate?.url || hlsCandidate?.url || deterministic,
    video: hlsCandidate?.url || deterministic || selectCandidate("mp4")?.url,
    details: { audioCandidate, hlsCandidate, deterministic },
  };
}

function attachMediaLogging(media, name) {
  for (const eventName of MEDIA_EVENT_NAMES) {
    media.addEventListener(eventName, () => {
      const level = eventName === "error" ? "error" : ["waiting", "stalled", "abort"].includes(eventName) ? "warn" : ["playing", "loadedmetadata", "canplay"].includes(eventName) ? "success" : "info";
      log(level, `media-${name}`, eventName, mediaSnapshot(media), { verbose: !["error", "playing", "loadedmetadata", "canplay"].includes(eventName) });
      updateMediaFacts();
      if (eventName === "error") setTest(name === "audio" ? "audio-media" : "video-media", "fail", describeMediaError(media));
      if (["playing", "canplay", "loadedmetadata"].includes(eventName)) setTest(name === "audio" ? "audio-media" : "video-media", "pass", `${eventName}; duration ${formatNumber(media.duration)} seconds.`);
    });
  }
  media.addEventListener("timeupdate", () => {
    const last = state.mediaThrottle.get(media) || 0;
    const now = Date.now();
    if (now - last > 5000) {
      state.mediaThrottle.set(media, now);
      log("info", `media-${name}`, "timeupdate checkpoint", mediaSnapshot(media), { verbose: true });
      updatePositionState(media);
      updateMediaFacts();
    }
  });
}

function describeMediaError(media) {
  const error = media.error;
  if (!error) return "Unknown media error";
  const codes = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
  return `${codes[error.code] || `code ${error.code}`}${error.message ? `: ${error.message}` : ""}`;
}

function timeRanges(range) {
  const output = [];
  if (!range) return output;
  for (let index = 0; index < range.length; index += 1) {
    output.push([Number(range.start(index).toFixed(3)), Number(range.end(index).toFixed(3))]);
  }
  return output;
}

function mediaSnapshot(media) {
  return {
    tag: media.tagName.toLowerCase(),
    src: redactUrl(media.getAttribute("src") || ""),
    currentSrc: redactUrl(media.currentSrc || ""),
    currentTime: formatNumber(media.currentTime),
    duration: formatNumber(media.duration),
    paused: media.paused,
    ended: media.ended,
    seeking: media.seeking,
    readyState: media.readyState,
    networkState: media.networkState,
    playbackRate: media.playbackRate,
    defaultPlaybackRate: media.defaultPlaybackRate,
    volume: media.volume,
    muted: media.muted,
    buffered: timeRanges(media.buffered),
    seekable: timeRanges(media.seekable),
    videoWidth: media.videoWidth || null,
    videoHeight: media.videoHeight || null,
    error: media.error ? { code: media.error.code, message: media.error.message } : null,
  };
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : String(value);
}

function renderFacts(target, snapshot) {
  const pairs = Object.entries(snapshot || {});
  target.innerHTML = pairs.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</dd>`).join("");
}

function updateMediaFacts() {
  renderFacts(elements.audioFacts, mediaSnapshot(elements.audio));
  renderFacts(elements.videoFacts, mediaSnapshot(elements.video));
  $("#audio-status").textContent = elements.audio.currentSrc ? (elements.audio.paused ? "Loaded / paused" : "Playing") : "Idle";
  $("#audio-status").className = `mini-status ${elements.audio.error ? "bad" : elements.audio.currentSrc ? "good" : ""}`;
  $("#video-status").textContent = elements.video.currentSrc ? (elements.video.paused ? "Loaded / paused" : "Playing") : "Idle";
  $("#video-status").className = `mini-status ${elements.video.error ? "bad" : elements.video.currentSrc ? "good" : ""}`;
}

function updatePositionState(media) {
  if (!("mediaSession" in navigator) || !Number.isFinite(media.duration) || media.duration <= 0) return;
  if (typeof navigator.mediaSession.setPositionState !== "function") return;
  try {
    navigator.mediaSession.setPositionState({
      duration: media.duration,
      playbackRate: media.playbackRate,
      position: Math.min(media.duration, Math.max(0, media.currentTime)),
    });
  } catch (error) {
    log("warn", "media-session", "setPositionState failed.", error, { verbose: true });
  }
}

async function loadMedia(media, url, testId, label) {
  if (!url) {
    setTest(testId, "warn", `No ${label} URL was available.`);
    return false;
  }
  setTest(testId, "running", `Loading ${redactUrl(url)}.`);
  media.pause();
  media.removeAttribute("src");
  media.load();
  media.src = url;
  media.load();
  log("info", `media-${label}`, "Assigned media source.", { url: redactUrl(url), snapshot: mediaSnapshot(media) });
  if (elements.autoPlay.checked) {
    try {
      await media.play();
      log("success", `media-${label}`, "play() promise resolved.", mediaSnapshot(media));
      return true;
    } catch (error) {
      log("warn", `media-${label}`, "Automatic play attempt was rejected. Tap the visible media control to continue.", error);
      setTest(testId, "warn", `Loaded; play() was rejected with ${error.name}. Tap Play manually.`);
      return false;
    }
  }
  setTest(testId, "warn", "Source assigned. Tap the visible Play button to test audible playback.");
  return true;
}

async function runMediaProbes() {
  const parsed = state.parsed || parseInput({ silent: true });
  if (!parsed) return;
  if (!parsed.embedId) {
    toast("Run the resolution tests first, then tap media probes again.");
    log("warn", "media", "Media probes require an internal embed ID.");
    return;
  }
  const urls = chooseMediaProbeUrls();
  const deterministic = urls.details.deterministic;
  if (deterministic) {
    setTest("deterministic-hls", "pass", redactUrl(deterministic));
    log("success", "hls", "Constructed deterministic Rumble VOD HLS URL.", { url: deterministic });
  } else {
    setTest("deterministic-hls", "fail", "No embed ID was available to construct an HLS URL.");
  }
  log("info", "media", "Selected probe URLs.", urls);
  await loadMedia(elements.audio, urls.audio, "audio-media", "audio");
  await loadMedia(elements.video, urls.video, "video-media", "video");
  updateMediaFacts();
}

async function runSafeTests({ deep = false } = {}) {
  const parsed = state.parsed || parseInput({ silent: true });
  if (!parsed) return;
  state.runId = crypto.randomUUID?.() || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.runStartedAt = nowIso();
  log("info", "run", `${deep ? "Deep" : "Safe"} diagnostic run started.`, { runId: state.runId, input: parsed });
  await runEnvironmentTests();
  await testStorage();
  testMediaSession();

  if (!state.parsed.embedId) await resolveThroughSlug();
  if (!state.parsed.embedId) await resolveThroughOembed();
  if (state.parsed.embedId) {
    const hls = deterministicHlsUrl();
    setTest("deterministic-hls", "pass", redactUrl(hls));
    log("success", "hls", "Deterministic HLS candidate generated.", { url: hls });
    await probeEmbedJson({ deep });
  } else {
    setTest("embedjs-cors", "warn", "Skipped because no internal embed ID was resolved.");
    setTest("deterministic-hls", "warn", "Skipped because no internal embed ID was resolved.");
  }

  const summary = createBundle();
  state.lastSummary = summary;
  log("success", "run", "Diagnostic run completed.", compactCounts(summary));
  if (elements.saveRuns.checked) await saveCurrentRun({ automatic: true });
  toast("Diagnostic run complete");
}

function compactCounts(bundle) {
  const statuses = {};
  for (const test of Object.values(bundle.tests)) statuses[test.status] = (statuses[test.status] || 0) + 1;
  return { statuses, events: bundle.events.length, embedId: bundle.identity?.embedId || null, candidates: bundle.mediaCandidates.length };
}

function mediaCommand(media, action) {
  try {
    if (action === "play") media.play().catch((error) => log("warn", "media-control", "Manual play failed.", error));
    if (action === "pause") media.pause();
    if (action === "back") media.currentTime = Math.max(0, media.currentTime - 15);
    if (action === "forward") media.currentTime = Math.min(Number.isFinite(media.duration) ? media.duration : Infinity, media.currentTime + 30);
    if (action === "rate") {
      media.playbackRate = media.playbackRate === 1.5 ? 1 : 1.5;
      if ("preservesPitch" in media) media.preservesPitch = true;
    }
    if (action === "clear") {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    log("info", "media-control", `${media.tagName.toLowerCase()} ${action}`, mediaSnapshot(media));
    updateMediaFacts();
  } catch (error) {
    log("error", "media-control", `${action} failed.`, error);
  }
}

function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function launchLab(mode) {
  const id = state.parsed?.embedId;
  if (!id) {
    toast("Resolve an internal embed ID first.");
    log("warn", "player-lab", "Cannot launch without an embed ID.");
    return;
  }
  destroyLabFrame();
  const nonce = createNonce();
  const iframe = document.createElement("iframe");
  iframe.title = `Rumble player laboratory (${mode})`;
  iframe.allow = "autoplay; fullscreen; picture-in-picture";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.src = `./player-lab.html#${encodeURIComponent(nonce)}`;
  if (mode === "sandbox") iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-presentation allow-popups");
  elements.labShell.innerHTML = "";
  elements.labShell.append(iframe);

  const channel = new MessageChannel();
  const lab = { mode, nonce, iframe, port: channel.port1, lastSnapshot: null, discovered: [] };
  state.lab = lab;
  channel.port1.onmessage = (event) => handleLabMessage(event.data);
  channel.port1.start();

  iframe.addEventListener("load", () => {
    iframe.contentWindow.postMessage({ type: "rumble-lab-connect", nonce }, "*", [channel.port2]);
    setTimeout(() => {
      channel.port1.postMessage({
        type: "init",
        nonce,
        embedId: id,
        mode,
        verbose: elements.verbose.checked,
        fullUrls: elements.fullUrls.checked,
      });
    }, 30);
  }, { once: true });

  const testId = mode === "sandbox" ? "lab-sandbox" : "lab-origin";
  setTest(testId, "running", "Lab loaded. Tap “Initialize Rumble player” inside the frame.");
  log("warn", "player-lab", `Launching ${mode} Rumble player lab.`, { embedId: id, sandbox: iframe.getAttribute("sandbox") || null });
}

function handleLabMessage(data) {
  if (!data || data.nonce !== state.lab?.nonce) return;
  if (data.type === "log") {
    log(data.level || "info", `lab:${data.area || "runtime"}`, data.message || "Lab event", data.data, { verbose: data.verbose });
  } else if (data.type === "ready") {
    const testId = state.lab.mode === "sandbox" ? "lab-sandbox" : "lab-origin";
    setTest(testId, "pass", "MessageChannel connected; initialize inside the lab.");
  } else if (data.type === "snapshot") {
    state.lab.lastSnapshot = data.snapshot;
    renderFacts(elements.labFacts, data.snapshot);
    const src = data.snapshot?.media?.currentSrc || data.snapshot?.media?.src || null;
    if (src && !state.lab.discovered.includes(src)) state.lab.discovered.push(src);
    log("success", "player-lab", "Lab inspection snapshot received.", data.snapshot);
  } else if (data.type === "candidate") {
    const url = data.url;
    if (url && !state.lab.discovered.includes(url)) state.lab.discovered.push(url);
    log("success", "player-lab", `Discovered ${data.kind || "resource"} candidate.`, data);
  } else if (data.type === "error") {
    const testId = state.lab.mode === "sandbox" ? "lab-sandbox" : "lab-origin";
    setTest(testId, "fail", data.message || "Player lab error");
    log("error", "player-lab", data.message || "Player lab error", data);
  }
}

function sendLabCommand(command, payload = {}) {
  if (!state.lab?.port) {
    log("warn", "player-lab", `Lab command ${command} ignored because no lab is connected.`);
    return;
  }
  state.lab.port.postMessage({ type: "command", nonce: state.lab.nonce, command, ...payload });
  log("info", "player-lab", `Sent lab command: ${command}.`, payload, { verbose: true });
}

function destroyLabFrame() {
  if (state.lab) {
    try { state.lab.port?.close(); } catch {}
    try { state.lab.iframe?.remove(); } catch {}
  }
  state.lab = null;
  elements.labShell.innerHTML = `<div class="lab-placeholder"><strong>No player lab is running.</strong><span>Resolve an embed ID, then launch a lab.</span></div>`;
  elements.labFacts.innerHTML = "";
}

async function tryNativeHandoff() {
  const candidates = state.lab?.discovered || [];
  const preferred = candidates.find((url) => /\.(aac|m4a|mp3|opus)(?:$|\?)/i.test(url))
    || candidates.find((url) => /\.m3u8(?:$|\?)/i.test(url))
    || state.lab?.lastSnapshot?.media?.currentSrc
    || null;
  if (!preferred || !/^https?:\/\//i.test(preferred)) {
    toast("The lab has not exposed a transferable HTTP media URL yet.");
    log("warn", "handoff", "No transferable media URL was discovered.", { candidates });
    return;
  }
  log("info", "handoff", "Attempting native audio handoff from lab-discovered URL.", { url: preferred });
  await loadMedia(elements.audio, preferred, "audio-media", "handoff-audio");
  toast("Native handoff source assigned; tap Play to verify");
}

function createBundle({ fullUrls = elements.fullUrls.checked } = {}) {
  const tests = {};
  for (const [id, test] of state.tests.entries()) tests[id] = safeJson(test);
  const environment = {
    appVersion: APP_VERSION,
    generatedAt: nowIso(),
    runId: state.runId,
    runStartedAt: state.runStartedAt,
    location: fullUrls ? location.href : redactUrl(location.href),
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayMode: getDisplayMode(),
    online: navigator.onLine,
    secureContext: isSecureContext,
    standaloneIos: Boolean(navigator.standalone),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    swObservedMessages: state.swMessages,
  };
  return {
    schema: "rumble-capability-lab/v1",
    environment,
    identity: sanitizeData(state.parsed, fullUrls),
    metadata: sanitizeData(state.metadata, fullUrls),
    mediaCandidates: sanitizeData(state.candidates, fullUrls),
    deterministicHls: sanitizeData(deterministicHlsUrl(), fullUrls),
    media: {
      audio: sanitizeData(mediaSnapshot(elements.audio), fullUrls),
      video: sanitizeData(mediaSnapshot(elements.video), fullUrls),
      lab: sanitizeData(state.lab?.lastSnapshot || null, fullUrls),
      labDiscovered: sanitizeData(state.lab?.discovered || [], fullUrls),
    },
    tests,
    events: state.events.map((event) => sanitizeData(event, fullUrls)),
  };
}

function compactSummary() {
  const bundle = createBundle();
  const statusLines = TEST_DEFINITIONS.map(([id, title]) => {
    const test = bundle.tests[id];
    return `- ${title}: ${test?.status || "unknown"}${test?.detail ? ` — ${test.detail}` : ""}`;
  });
  const candidateLines = bundle.mediaCandidates.slice(0, 20).map((candidate) => `- ${candidate.kind}: ${candidate.url} (${candidate.path || "unknown path"})`);
  const recentErrors = bundle.events.filter((event) => ["error", "warn"].includes(event.level)).slice(-20)
    .map((event) => `- ${event.ts} [${event.area}] ${event.message}${event.data ? ` — ${JSON.stringify(event.data)}` : ""}`);
  return [
    "# Rumble Capability Lab summary",
    "",
    `- App: ${APP_VERSION}`,
    `- Run: ${bundle.environment.runId}`,
    `- Generated: ${bundle.environment.generatedAt}`,
    `- Browser: ${bundle.environment.userAgent}`,
    `- Display mode: ${bundle.environment.displayMode}`,
    `- Secure context: ${bundle.environment.secureContext}`,
    `- Service worker controlled: ${bundle.environment.serviceWorkerControlled}`,
    `- Input: ${bundle.identity?.raw || "none"}`,
    `- Input type: ${bundle.identity?.type || "unknown"}`,
    `- Embed ID: ${bundle.identity?.embedId || "unresolved"}`,
    `- Resolution source: ${bundle.identity?.resolutionSource || "none"}`,
    `- Deterministic HLS: ${bundle.deterministicHls || "none"}`,
    "",
    "## Capability matrix",
    ...statusLines,
    "",
    "## Media candidates",
    ...(candidateLines.length ? candidateLines : ["- None"]),
    "",
    "## Current media",
    `- Audio: ${JSON.stringify(bundle.media.audio)}`,
    `- Video: ${JSON.stringify(bundle.media.video)}`,
    `- Lab: ${JSON.stringify(bundle.media.lab)}`,
    "",
    "## Recent warnings and errors",
    ...(recentErrors.length ? recentErrors : ["- None"]),
  ].join("\n");
}

function downloadJson() {
  const bundle = createBundle({ fullUrls: elements.fullUrls.checked });
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rumble-capability-${bundle.environment.runId}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  log("success", "export", "Diagnostic JSON exported.", { filename: anchor.download, bytes: blob.size });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUN_STORE)) {
        const store = db.createObjectStore(RUN_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function dbRequest(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(RUN_STORE, mode);
      const store = transaction.objectStore(RUN_STORE);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  } finally {
    db.close();
  }
}

async function saveCurrentRun({ automatic = false } = {}) {
  try {
    const bundle = createBundle();
    const record = {
      id: bundle.environment.runId,
      createdAt: bundle.environment.generatedAt,
      automatic,
      input: bundle.identity?.raw || null,
      embedId: bundle.identity?.embedId || null,
      counts: compactCounts(bundle),
      bundle,
    };
    await dbRequest("readwrite", (store) => store.put(record));
    await trimHistory();
    await renderHistory();
    log("success", "history", `${automatic ? "Automatically saved" : "Saved"} diagnostic snapshot.`, { id: record.id });
    if (!automatic) toast("Snapshot saved locally");
  } catch (error) {
    log("error", "history", "Saving diagnostic run failed.", error);
    if (!automatic) toast("Could not save snapshot");
  }
}

async function listRuns() {
  const records = await dbRequest("readonly", (store) => store.getAll());
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function trimHistory() {
  const records = await listRuns();
  for (const record of records.slice(MAX_SAVED_RUNS)) {
    await dbRequest("readwrite", (store) => store.delete(record.id));
  }
}

async function renderHistory() {
  try {
    const records = await listRuns();
    if (!records.length) {
      elements.history.innerHTML = `<div class="empty-state">No diagnostic runs have been saved on this device.</div>`;
      return;
    }
    elements.history.innerHTML = records.map((record) => `
      <article class="history-item" data-run-id="${escapeHtml(record.id)}">
        <div>
          <strong>${escapeHtml(record.embedId || "Unresolved Rumble item")}</strong>
          <p>${escapeHtml(new Date(record.createdAt).toLocaleString())} · ${record.counts.events} events · ${escapeHtml(record.input || "No input")}</p>
        </div>
        <div class="history-actions">
          <button class="button button-small" data-history-action="copy" type="button">Copy JSON</button>
          <button class="button button-small" data-history-action="load" type="button">Load log</button>
          <button class="button button-small button-danger" data-history-action="delete" type="button">Delete</button>
        </div>
      </article>`).join("");
  } catch (error) {
    elements.history.innerHTML = `<div class="empty-state">History unavailable: ${escapeHtml(error.message)}</div>`;
  }
}

async function handleHistoryAction(button) {
  const item = button.closest("[data-run-id]");
  const id = item?.dataset.runId;
  if (!id) return;
  const record = await dbRequest("readonly", (store) => store.get(id));
  if (!record) return;
  const action = button.dataset.historyAction;
  if (action === "copy") {
    await copyText(JSON.stringify(record.bundle, null, 2));
    setCopyStatus(`Copied saved run ${id}.`);
  } else if (action === "load") {
    state.events = record.bundle.events || [];
    state.sequence = state.events.reduce((max, event) => Math.max(max, event.seq || 0), 0);
    state.parsed = record.bundle.identity || null;
    state.metadata = record.bundle.metadata || null;
    state.candidates = record.bundle.mediaCandidates || [];
    updateIdentity();
    renderLog();
    toast("Saved run loaded into the log viewer");
  } else if (action === "delete") {
    await dbRequest("readwrite", (store) => store.delete(id));
    await renderHistory();
  }
}

async function clearHistory() {
  await dbRequest("readwrite", (store) => store.clear());
  await renderHistory();
  toast("Saved runs deleted");
}

function clearLog() {
  state.events = [];
  state.sequence = 0;
  renderLog();
  setCopyStatus("");
}

function resetTests() {
  initializeTests();
  log("info", "control", "Capability statuses reset.");
}

function updateBadges() {
  const online = $("#badge-online");
  online.textContent = `Network: ${navigator.onLine ? "online" : "offline"}`;
  online.className = `badge ${navigator.onLine ? "good" : "bad"}`;
  const context = $("#badge-context");
  context.textContent = `Context: ${isSecureContext ? "secure" : "not secure"}`;
  context.className = `badge ${isSecureContext ? "good" : "bad"}`;
  const display = $("#badge-display");
  display.textContent = `Display: ${getDisplayMode()}`;
  display.className = "badge";
  const sw = $("#badge-sw");
  sw.textContent = `Service worker: ${navigator.serviceWorker?.controller ? "controlling" : "not controlling"}`;
  sw.className = `badge ${navigator.serviceWorker?.controller ? "good" : "warn"}`;
}


function importFromHash() {
  if (!location.hash || location.hash.length < 2) return false;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    let embedId = params.get("rumble");
    let source = params.get("source");
    const encoded = params.get("import");
    if (encoded && !embedId) {
      let decoded = encoded;
      if (/^%7B/i.test(decoded)) {
        try { decoded = decodeURIComponent(decoded); } catch {}
      }
      try {
        const normalized = decoded.replace(/-/g, "+").replace(/_/g, "/");
        decoded = decodeURIComponent(escape(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))));
      } catch {}
      const payload = JSON.parse(decoded);
      embedId = payload.embedId || payload.videoId || null;
      source = payload.originalUrl || payload.url || source;
    }
    if (!/^v[a-z0-9]+$/i.test(embedId || "")) return false;
    elements.url.value = `https://rumble.com/embed/${embedId}/`;
    const parsed = parseInput({ silent: true });
    if (parsed) {
      parsed.importedSourceUrl = source || null;
      parsed.resolutionSource = "URL-fragment import";
      updateIdentity(parsed);
      log("success", "import", "Imported an embed ID from the URL fragment.", { embedId, source });
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      toast("Rumble item imported from Shortcut");
      return true;
    }
  } catch (error) {
    log("warn", "import", "URL-fragment import failed.", error);
  }
  return false;
}

function installGlobalErrorLogging() {
  addEventListener("error", (event) => {
    log("error", "window", "Uncaught error.", { message: event.message, filename: redactUrl(event.filename), line: event.lineno, column: event.colno, error: event.error });
  });
  addEventListener("unhandledrejection", (event) => {
    log("error", "promise", "Unhandled promise rejection.", event.reason);
  });
  addEventListener("online", () => { updateBadges(); log("success", "network", "Browser reported online."); });
  addEventListener("offline", () => { updateBadges(); log("warn", "network", "Browser reported offline."); });
  document.addEventListener("visibilitychange", () => log("info", "lifecycle", `visibility=${document.visibilityState}`, { hidden: document.hidden }, { verbose: true }));
  addEventListener("pagehide", (event) => log("info", "lifecycle", "pagehide", { persisted: event.persisted }, { verbose: true }));
  addEventListener("pageshow", (event) => log("info", "lifecycle", "pageshow", { persisted: event.persisted }, { verbose: true }));
}

function bindEvents() {
  $("#app-version").textContent = APP_VERSION;
  $("#fill-example").addEventListener("click", () => { elements.url.value = EXAMPLE_EMBED; parseInput(); });
  $("#parse-button").addEventListener("click", () => parseInput());
  elements.url.addEventListener("keydown", (event) => { if (event.key === "Enter") parseInput(); });
  $("#run-safe").addEventListener("click", () => runSafeTests({ deep: false }));
  $("#run-deep").addEventListener("click", () => runSafeTests({ deep: true }));
  $("#run-media").addEventListener("click", runMediaProbes);
  $("#stop-all").addEventListener("click", stopAll);
  $("#reset-tests").addEventListener("click", resetTests);
  $("#inspect-media").addEventListener("click", () => { updateMediaFacts(); log("info", "media", "Manual media inspection.", { audio: mediaSnapshot(elements.audio), video: mediaSnapshot(elements.video) }); });
  elements.filter.addEventListener("input", renderLog);
  elements.swObserve.addEventListener("change", configureSwObserver);
  $("#clear-log").addEventListener("click", clearLog);
  $("#copy-summary").addEventListener("click", async () => {
    try { await copyText(compactSummary()); setCopyStatus("Compact summary copied. Paste it into the chat."); toast("Summary copied"); }
    catch (error) { setCopyStatus(error.message, true); }
  });
  $("#copy-log").addEventListener("click", async () => {
    try { await copyText(JSON.stringify(createBundle(), null, 2)); setCopyStatus("Full diagnostic bundle copied as JSON."); toast("Full log copied"); }
    catch (error) { setCopyStatus(error.message, true); }
  });
  $("#export-json").addEventListener("click", downloadJson);
  $("#save-run").addEventListener("click", () => saveCurrentRun({ automatic: false }));
  $("#clear-history").addEventListener("click", clearHistory);
  elements.history.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-action]");
    if (button) handleHistoryAction(button).catch((error) => log("error", "history", "History action failed.", error));
  });
  $$("[data-media]").forEach((button) => button.addEventListener("click", () => {
    const media = button.dataset.media === "audio" ? elements.audio : elements.video;
    mediaCommand(media, button.dataset.action);
  }));
  $("#launch-sandbox-lab").addEventListener("click", () => launchLab("sandbox"));
  $("#launch-same-origin-lab").addEventListener("click", () => launchLab("same-origin"));
  $("#lab-inspect").addEventListener("click", () => sendLabCommand("inspect"));
  $("#lab-handoff").addEventListener("click", tryNativeHandoff);
  $$("[data-lab-command]").forEach((button) => button.addEventListener("click", () => sendLabCommand(button.dataset.labCommand)));
}

async function bootstrap() {
  initializeTests();
  bindEvents();
  installGlobalErrorLogging();
  attachMediaLogging(elements.audio, "audio");
  attachMediaLogging(elements.video, "video");
  attachSwMessages();
  updateBadges();
  updateMediaFacts();
  log("info", "app", "Rumble Capability Lab started.", { version: APP_VERSION, href: redactUrl(location.href) });
  importFromHash();
  await registerServiceWorker();
  await renderHistory();
  await runEnvironmentTests();
  await testStorage();
  testMediaSession();
}

bootstrap().catch((error) => log("error", "bootstrap", "Application startup failed.", error));
