/*
  Paste this entire file into the iOS Shortcuts action:
  "Run JavaScript on Web Page".

  It intentionally performs no network request. It examines only the Rumble
  page that Safari has already loaded, then returns a JSON-compatible object.
*/

(function () {
  const result = {
    schema: "rumble-shortcut-extractor/v1",
    originalUrl: location.href,
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href,
    title: document.querySelector('meta[property="og:title"]')?.content || document.title || null,
    thumbnail: document.querySelector('meta[property="og:image"]')?.content || null,
    author: null,
    embedId: null,
    evidence: [],
    fragment: null,
    error: null,
  };

  function accept(value, evidence) {
    if (!value || result.embedId) return;
    const match = String(value).match(/(?:^|[/.])(v[a-z0-9]+)(?:[/?#.'"-]|$)/i);
    if (match) {
      result.embedId = match[1];
      result.evidence.push(evidence);
    }
  }

  try {
    const jsonLdNodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const node of jsonLdNodes) {
      try {
        const data = JSON.parse(node.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          accept(item?.embedUrl, "JSON-LD embedUrl");
          if (!result.author) result.author = item?.author?.name || item?.creator?.name || null;
          if (!result.thumbnail) result.thumbnail = Array.isArray(item?.thumbnailUrl) ? item.thumbnailUrl[0] : item?.thumbnailUrl || null;
        }
      } catch {}
    }

    for (const selector of [
      'link[type="application/json+oembed"]',
      'link[type="text/json+oembed"]',
      'iframe[src*="rumble.com/embed/"]',
      'a[href*="rumble.com/embed/"]',
      '[id^="vid_v"]',
      '[data-video]',
    ]) {
      for (const element of document.querySelectorAll(selector)) {
        accept(element.href || element.src || element.id?.replace(/^vid_/, "") || element.dataset.video, `DOM selector ${selector}`);
      }
    }

    if (!result.embedId) {
      const html = document.documentElement.innerHTML;
      const patterns = [
        /["']embedUrl["']\s*:\s*["'][^"']*?\/embed\/(?:[a-z0-9]+\.)?(v[a-z0-9]+)/i,
        /Rumble\s*\(\s*["']play["']\s*,\s*\{[\s\S]{0,500}?["']?video["']?\s*:\s*["'](v[a-z0-9]+)/i,
        /data-video=["'](v[a-z0-9]+)["']/i,
        /id=["']vid_(v[a-z0-9]+)["']/i,
        /rumble\.com\/embed\/(?:[a-z0-9]+\.)?(v[a-z0-9]+)/i,
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          result.embedId = match[1];
          result.evidence.push(`HTML regex ${pattern}`);
          break;
        }
      }
    }

    if (result.embedId) {
      result.embedUrl = `https://rumble.com/embed/${result.embedId}/`;
      result.fragment = `#rumble=${encodeURIComponent(result.embedId)}&source=${encodeURIComponent(result.canonicalUrl)}`;
    } else {
      result.error = "No internal Rumble embed ID was recognized on this page.";
    }
  } catch (error) {
    result.error = `${error.name}: ${error.message}`;
  }

  completion(result);
})();
