/**
 * NeoProxy Service Worker (sw.js)
 * Intercepts all /neo/ requests and proxies them
 * Handles URL rewriting for HTML, CSS responses
 */

const PREFIX = '/neo/';
const CACHE_NAME = 'neoproxy-v1';

// ===== URL CODEC (must be self-contained in SW) =====
function encode(url) {
  try {
    return btoa(encodeURIComponent(url))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch { return ''; }
}

function decode(encoded) {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    const padded2 = pad ? padded + '='.repeat(4 - pad) : padded;
    return decodeURIComponent(atob(padded2));
  } catch { return null; }
}

// ===== INSTALL =====
self.addEventListener('install', (event) => {
  console.log('[NeoProxy SW] Installing...');
  event.waitUntil(self.skipWaiting());
});

// ===== ACTIVATE =====
self.addEventListener('activate', (event) => {
  console.log('[NeoProxy SW] Activating...');
  event.waitUntil(self.clients.claim());
});

// ===== FETCH INTERCEPTOR =====
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle /neo/ routes (but not the SW itself)
  if (!url.pathname.startsWith(PREFIX)) return;
  const encodedPart = url.pathname.slice(PREFIX.length);
  if (!encodedPart || encodedPart === 'sw.js') return;

  // Decode the target URL
  const targetURL = decode(encodedPart);
  if (!targetURL) {
    event.respondWith(new Response('Invalid encoded URL', { status: 400 }));
    return;
  }

  // Re-attach query string
  const fullTarget = url.search ? targetURL + url.search : targetURL;

  event.respondWith(handleProxy(event.request, fullTarget));
});

// ===== PROXY HANDLER =====
async function handleProxy(request, targetURL) {
  let parsedTarget;
  try {
    parsedTarget = new URL(targetURL);
  } catch {
    return errorResponse('Invalid target URL: ' + targetURL);
  }

  // Build request headers
  const headers = new Headers();
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
  headers.set('Accept-Language', 'en-US,en;q=0.9,ja;q=0.8');
  headers.set('Origin', parsedTarget.origin);
  headers.set('Referer', parsedTarget.origin + '/');
  headers.set('Sec-Fetch-Mode', 'navigate');
  headers.set('Sec-Fetch-Site', 'cross-site');
  headers.set('Upgrade-Insecure-Requests', '1');

  // Forward safe request headers
  const forwardHeaders = ['accept', 'accept-language', 'content-type', 'range'];
  for (const [key, val] of request.headers.entries()) {
    if (forwardHeaders.includes(key.toLowerCase())) {
      headers.set(key, val);
    }
  }

  const fetchOptions = {
    method: request.method,
    headers,
    redirect: 'follow',
    credentials: 'omit',
  };

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    fetchOptions.body = await request.arrayBuffer();
  }

  try {
    const response = await fetch(targetURL, fetchOptions);
    return await processResponse(response, targetURL);
  } catch (err) {
    return errorResponse('Fetch failed: ' + err.message);
  }
}

// ===== RESPONSE PROCESSOR =====
async function processResponse(response, targetURL) {
  const contentType = response.headers.get('content-type') || '';
  const resHeaders = buildResponseHeaders(response, targetURL);

  if (contentType.includes('text/html')) {
    const text = await response.text();
    const rewritten = rewriteHTML(text, targetURL);
    resHeaders.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(rewritten, { status: response.status, headers: resHeaders });
  }

  if (contentType.includes('text/css')) {
    const text = await response.text();
    const rewritten = rewriteCSS(text, targetURL);
    resHeaders.set('Content-Type', 'text/css; charset=utf-8');
    return new Response(rewritten, { status: response.status, headers: resHeaders });
  }

  // Pass through all other content types (images, fonts, scripts, etc.)
  return new Response(response.body, { status: response.status, headers: resHeaders });
}

// ===== HEADER BUILDER =====
function buildResponseHeaders(response, targetURL) {
  const headers = new Headers();

  // Strip headers that prevent embedding or reveal info
  const STRIP = new Set([
    'x-frame-options',
    'content-security-policy',
    'content-security-policy-report-only',
    'x-content-type-options',
    'strict-transport-security',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'permissions-policy',
    'report-to',
    'nel',
  ]);

  for (const [key, val] of response.headers.entries()) {
    const lkey = key.toLowerCase();
    if (STRIP.has(lkey)) continue;

    // Rewrite Location header for redirects
    if (lkey === 'location') {
      try {
        const abs = new URL(val, targetURL).href;
        headers.set('Location', PREFIX + encode(abs));
      } catch {
        headers.set(key, val);
      }
      continue;
    }

    // Rewrite Set-Cookie (strip domain/secure for localhost)
    if (lkey === 'set-cookie') {
      const sanitized = val
        .replace(/;\s*domain=[^;]+/gi, '')
        .replace(/;\s*secure/gi, '');
      headers.set(key, sanitized);
      continue;
    }

    headers.set(key, val);
  }

  headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

// ===== HTML REWRITER =====
function rewriteHTML(html, base) {
  // Rewrite common URL attributes
  html = html.replace(/(href|src|action|data-src|poster|data-href|data-url)=["']([^"'\s>]+)["']/gi,
    (m, attr, url) => {
      if (/^(data:|blob:|#|javascript:|mailto:|tel:|about:)/i.test(url)) return m;
      try {
        const abs = new URL(url, base).href;
        return `${attr}="${PREFIX}${encode(abs)}"`;
      } catch { return m; }
    }
  );

  // Rewrite srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (m, srcset) => {
    const rewritten = srcset.split(',').map(entry => {
      const trimmed = entry.trim();
      const spaceIdx = trimmed.search(/\s/);
      const url = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
      const descriptor = spaceIdx > -1 ? trimmed.slice(spaceIdx) : '';
      try {
        const abs = new URL(url, base).href;
        return `${PREFIX}${encode(abs)}${descriptor}`;
      } catch { return entry; }
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // Rewrite inline style URLs
  html = html.replace(/style="([^"]+)"/gi, (m, style) => {
    const rewritten = rewriteCSS(style, base);
    return `style="${rewritten}"`;
  });

  // Rewrite meta refresh
  html = html.replace(
    /(<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'])([^"']+)(["'])/gi,
    (m, pre, content, post) => {
      const rewrittenContent = content.replace(/(url=)(.+)/i, (_, prefix, url) => {
        try {
          const abs = new URL(url.trim(), base).href;
          return `${prefix}${PREFIX}${encode(abs)}`;
        } catch { return _; }
      });
      return `${pre}${rewrittenContent}${post}`;
    }
  );

  // Inject runtime script at the beginning of <head>
  const runtime = buildRuntime(base);
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, (m) => m + runtime);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, (m) => m + '<head>' + runtime + '</head>');
  } else {
    html = runtime + html;
  }

  return html;
}

// ===== CSS REWRITER =====
function rewriteCSS(css, base) {
  return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (m, url) => {
    if (/^(data:|blob:|#)/i.test(url)) return m;
    try {
      const abs = new URL(url, base).href;
      return `url("${PREFIX}${encode(abs)}")`;
    } catch { return m; }
  });
}

// ===== RUNTIME SCRIPT BUILDER =====
function buildRuntime(baseURL) {
  return `<script>
(function() {
  if (window.__NEOPROXY_INSTALLED) return;
  window.__NEOPROXY_INSTALLED = true;
  window.__NEOPROXY_BASE = ${JSON.stringify(baseURL)};
  const PREFIX = ${JSON.stringify(PREFIX)};

  function enc(url) {
    try {
      return btoa(encodeURIComponent(new URL(url, window.__NEOPROXY_BASE).href))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    } catch(e) { return null; }
  }

  function proxify(url) {
    if (!url || /^(data:|blob:|#|javascript:|mailto:|tel:|about:|\/neo\/)/i.test(url)) return url;
    const e = enc(url);
    return e ? PREFIX + e : url;
  }

  // Override fetch
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string') url = proxify(url);
    return _fetch.call(this, url, opts);
  };

  // Override XMLHttpRequest
  const _XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends _XHR {
    open(method, url, ...args) {
      if (typeof url === 'string') url = proxify(url);
      return super.open(method, url, ...args);
    }
  };

  // Override WebSocket
  try {
    const _WS = window.WebSocket;
    window.WebSocket = function(url, ...args) {
      return new _WS(url, ...args); // pass through for now
    };
  } catch(e) {}

  // Intercept dynamic script/link creation
  const _createElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    const el = _createElement(tag);
    const t = tag.toLowerCase();
    if (t === 'script' || t === 'link' || t === 'img' || t === 'iframe') {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src') ||
                   Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'href');
      const srcAttr = t === 'link' ? 'href' : 'src';
      const original = Object.getOwnPropertyDescriptor(el.__proto__, srcAttr);
      if (original && original.set) {
        Object.defineProperty(el, srcAttr, {
          set(v) { original.set.call(this, proxify(v) || v); },
          get() { return original.get.call(this); },
          configurable: true,
        });
      }
    }
    return el;
  };

  console.log('[NeoProxy] Runtime v1 installed on', window.__NEOPROXY_BASE);
})();
<\/script>`;
}

// ===== ERROR RESPONSE =====
function errorResponse(message) {
  return new Response(
    `<html><body style="font-family:monospace;padding:40px;background:#0a0a0f;color:#e8e8f0">
      <h2 style="color:#f43f5e">NeoProxy SW Error</h2>
      <p>${message}</p>
      <a href="/" style="color:#7c3aed">← Back</a>
    </body></html>`,
    { status: 502, headers: { 'Content-Type': 'text/html' } }
  );
}
