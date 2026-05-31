/**
 * NeoProxy - Advanced Web Proxy with URL Rewriting
 * Similar to Ultraviolet but built from scratch
 * Supports: URL encoding, header injection, cookie handling, JS/CSS/HTML rewriting
 */

// ===== ENCODING/DECODING =====
const NeoCodec = {
  // Base64 encode with URL safety
  encode(url) {
    return btoa(encodeURIComponent(url))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  },

  decode(encoded) {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    const padded2 = pad ? padded + '='.repeat(4 - pad) : padded;
    return decodeURIComponent(atob(padded2));
  },

  // XOR obfuscation layer (like UV uses)
  xorEncode(str, key = 'neoproxy') {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return btoa(result).replace(/=/g, '');
  },

  xorDecode(encoded, key = 'neoproxy') {
    const decoded = atob(encoded + '=='.slice((encoded.length * 3) % 4));
    let result = '';
    for (let i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  }
};

// ===== URL REWRITER =====
class NeoURLRewriter {
  constructor(proxyPrefix = '/neo/') {
    this.prefix = proxyPrefix;
  }

  // Convert a real URL to a proxied URL
  rewrite(url, base = '') {
    try {
      const absolute = new URL(url, base).href;
      return this.prefix + NeoCodec.encode(absolute);
    } catch {
      return url;
    }
  }

  // Decode a proxied URL back to the real URL
  unwrap(proxied) {
    const stripped = proxied.startsWith(this.prefix)
      ? proxied.slice(this.prefix.length)
      : proxied;
    try {
      return NeoCodec.decode(stripped);
    } catch {
      return null;
    }
  }

  // Rewrite all URLs in an HTML string
  rewriteHTML(html, baseURL) {
    // Rewrite href attributes
    html = html.replace(
      /(href|src|action|data-src|poster)=["']([^"']+)["']/gi,
      (match, attr, url) => {
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) {
          return match;
        }
        return `${attr}="${this.rewrite(url, baseURL)}"`;
      }
    );

    // Rewrite srcset
    html = html.replace(
      /srcset=["']([^"']+)["']/gi,
      (match, srcset) => {
        const rewritten = srcset.split(',').map(entry => {
          const [url, descriptor] = entry.trim().split(/\s+/);
          return `${this.rewrite(url, baseURL)}${descriptor ? ' ' + descriptor : ''}`;
        }).join(', ');
        return `srcset="${rewritten}"`;
      }
    );

    // Rewrite meta refresh
    html = html.replace(
      /(<meta[^>]+content=["'])(\d+;\s*url=)([^"']+)(["'])/gi,
      (match, pre, refresh, url, post) => `${pre}${refresh}${this.rewrite(url, baseURL)}${post}`
    );

    // Inject proxy runtime script
    html = html.replace(
      '</head>',
      `<script src="${this.prefix}__runtime.js"></script></head>`
    );

    return html;
  }

  // Rewrite URLs in CSS
  rewriteCSS(css, baseURL) {
    return css.replace(
      /url\(['"]?([^'")\s]+)['"]?\)/gi,
      (match, url) => {
        if (url.startsWith('data:') || url.startsWith('blob:')) return match;
        return `url("${this.rewrite(url, baseURL)}")`;
      }
    );
  }

  // Rewrite JS (basic - intercept fetch/XHR/location)
  rewriteJS(js, baseURL) {
    // Replace fetch() calls
    js = js.replace(/\bfetch\s*\(/g, '__neoFetch(');
    // Replace XMLHttpRequest open
    js = js.replace(/\.open\s*\(\s*(['"])(GET|POST|PUT|DELETE|PATCH)\1\s*,\s*/gi,
      `.open($1$2$1, __neoRewrite(`);
    // Replace window.location assignments
    js = js.replace(/window\.location\s*=\s*/g, 'window.__neoLocation = ');
    js = js.replace(/location\.href\s*=\s*/g, '__neoLocationHref = ');
    return js;
  }
}

// ===== RUNTIME (injected into proxied pages) =====
const NeoRuntime = {
  install(prefix, codec) {
    const rewriter = new NeoURLRewriter(prefix);

    // Override fetch
    window.__neoFetch = function(url, options = {}) {
      const rewritten = rewriter.rewrite(url, location.href);
      return fetch(rewritten, options);
    };

    // Override XMLHttpRequest
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class NeoXHR extends OrigXHR {
      open(method, url, ...args) {
        super.open(method, rewriter.rewrite(url, location.href), ...args);
      }
    };

    // Override fetch in service worker context
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(`${prefix}sw.js`);
    }

    // History API override
    const origPushState = history.pushState.bind(history);
    history.pushState = function(state, title, url) {
      origPushState(state, title, rewriter.rewrite(url, location.href));
    };

    // Intercept all link clicks
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      e.preventDefault();
      const target = rewriter.rewrite(href, location.href);
      if (a.target === '_blank') {
        window.open(target, '_blank');
      } else {
        location.href = target;
      }
    }, true);

    // Override form submissions
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (form.action) {
        form.action = rewriter.rewrite(form.action, location.href);
      }
    }, true);

    console.log('[NeoProxy] Runtime installed');
  }
};

// ===== SERVICE WORKER =====
const NeoServiceWorker = `
const PREFIX = '/neo/';

// Encoding helpers
function encode(url) {
  return btoa(encodeURIComponent(url))
    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
function decode(encoded) {
  const p = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = p.length % 4;
  return decodeURIComponent(atob(pad ? p + '='.repeat(4 - pad) : p));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PREFIX)) return;

  const encodedTarget = url.pathname.slice(PREFIX.length);
  if (!encodedTarget || encodedTarget.startsWith('__')) return;

  let targetURL;
  try {
    targetURL = decode(encodedTarget);
  } catch {
    return;
  }

  // Append query string
  if (url.search) targetURL += url.search;

  event.respondWith(handleProxy(event.request, targetURL));
});

async function handleProxy(request, targetURL) {
  const headers = new Headers();

  // Forward safe headers
  const allowHeaders = ['accept', 'accept-language', 'content-type', 'content-length'];
  for (const [key, val] of request.headers.entries()) {
    if (allowHeaders.includes(key.toLowerCase())) {
      headers.set(key, val);
    }
  }

  // Spoof origin/referer for CORS
  const parsed = new URL(targetURL);
  headers.set('Origin', parsed.origin);
  headers.set('Referer', parsed.origin + '/');

  const reqInit = {
    method: request.method,
    headers,
    redirect: 'follow',
    credentials: 'omit',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    reqInit.body = await request.arrayBuffer();
  }

  try {
    const response = await fetch(targetURL, reqInit);
    const contentType = response.headers.get('content-type') || '';
    const resHeaders = new Headers();

    // Copy response headers (strip problematic ones)
    const stripHeaders = ['x-frame-options', 'content-security-policy', 'x-content-type-options'];
    for (const [key, val] of response.headers.entries()) {
      if (!stripHeaders.includes(key.toLowerCase())) {
        resHeaders.set(key, val);
      }
    }

    // Rewrite content based on type
    if (contentType.includes('text/html')) {
      const text = await response.text();
      const rewritten = rewriteHTML(text, targetURL);
      return new Response(rewritten, { status: response.status, headers: resHeaders });
    }

    if (contentType.includes('text/css')) {
      const text = await response.text();
      const rewritten = rewriteCSS(text, targetURL);
      return new Response(rewritten, { status: response.status, headers: resHeaders });
    }

    if (contentType.includes('javascript')) {
      const text = await response.text();
      return new Response(text, { status: response.status, headers: resHeaders });
    }

    return new Response(response.body, { status: response.status, headers: resHeaders });
  } catch (err) {
    return new Response('NeoProxy Error: ' + err.message, { status: 502 });
  }
}

function rewriteHTML(html, base) {
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (m, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) return m;
    try {
      const abs = new URL(url, base).href;
      return attr + '="' + PREFIX + encode(abs) + '"';
    } catch { return m; }
  });
  // Inject runtime
  html = html.replace('</head>', '<script>window.__NEOPROXY=true;<\\/script></head>');
  return html;
}

function rewriteCSS(css, base) {
  return css.replace(/url\\(['"]?([^'"\\)\\s]+)['"]?\\)/gi, (m, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return m;
    try {
      const abs = new URL(url, base).href;
      return 'url("' + PREFIX + encode(abs) + '")';
    } catch { return m; }
  });
}
`;

// ===== MAIN UI (index.html generation) =====
const NeoProxyUI = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NeoProxy</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #12121a;
      --border: #2a2a3a;
      --accent: #7c3aed;
      --accent2: #06b6d4;
      --text: #e8e8f0;
      --muted: #666680;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Syne', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .logo {
      font-size: 3rem;
      font-weight: 800;
      letter-spacing: -2px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .tagline {
      color: var(--muted);
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      letter-spacing: 2px;
      margin-bottom: 40px;
    }
    .search-box {
      display: flex;
      width: 100%;
      max-width: 640px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .search-box:focus-within { border-color: var(--accent); }
    #urlInput {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-family: 'Space Mono', monospace;
      font-size: 0.9rem;
      padding: 16px 20px;
    }
    #urlInput::placeholder { color: var(--muted); }
    #goBtn {
      background: var(--accent);
      border: none;
      color: white;
      padding: 16px 24px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s;
    }
    #goBtn:hover { background: #6d28d9; }
    .shortcuts {
      display: flex;
      gap: 12px;
      margin-top: 24px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .shortcut {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 0.8rem;
      color: var(--muted);
      cursor: pointer;
      transition: all 0.2s;
      font-family: 'Space Mono', monospace;
    }
    .shortcut:hover { border-color: var(--accent2); color: var(--accent2); }
    .status { 
      margin-top: 20px; 
      font-family: 'Space Mono', monospace; 
      font-size: 0.75rem; 
      color: var(--muted);
    }
    .status.ok { color: #10b981; }
    .status.err { color: #f43f5e; }
    iframe#proxyFrame {
      display: none;
      width: 100%;
      height: 80vh;
      max-width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-top: 24px;
      background: white;
    }
  </style>
</head>
<body>
  <div class="logo">NeoProxy</div>
  <div class="tagline">ADVANCED WEB PROXY · URL REWRITING ENGINE</div>
  <div class="search-box">
    <input id="urlInput" type="text" placeholder="https://example.com を入力..." autocomplete="off" spellcheck="false">
    <button id="goBtn" onclick="navigate()">GO</button>
  </div>
  <div class="shortcuts">
    <div class="shortcut" onclick="quick('https://www.google.com')">Google</div>
    <div class="shortcut" onclick="quick('https://www.wikipedia.org')">Wikipedia</div>
    <div class="shortcut" onclick="quick('https://www.reddit.com')">Reddit</div>
    <div class="shortcut" onclick="quick('https://news.ycombinator.com')">HN</div>
    <div class="shortcut" onclick="quick('https://www.github.com')">GitHub</div>
    <div class="shortcut" onclick="quick('https://www.youtube.com')">YouTube</div>
  </div>
  <div id="status" class="status"></div>
  <iframe id="proxyFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>

  <script>
    // NeoCodec (inline)
    const encode = url =>
      btoa(encodeURIComponent(url))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');

    const PREFIX = '/neo/';

    function navigate() {
      let url = document.getElementById('urlInput').value.trim();
      if (!url) return;
      if (!/^https?:\\/\\//.test(url)) url = 'https://' + url;
      const proxied = PREFIX + encode(url);
      const frame = document.getElementById('proxyFrame');
      const status = document.getElementById('status');
      status.textContent = '読み込み中...';
      status.className = 'status';
      frame.style.display = 'block';
      frame.src = proxied;
      frame.onload = () => { status.textContent = '✓ 読み込み完了'; status.className = 'status ok'; };
      frame.onerror = () => { status.textContent = '✗ エラー'; status.className = 'status err'; };
    }

    function quick(url) {
      document.getElementById('urlInput').value = url;
      navigate();
    }

    document.getElementById('urlInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') navigate();
    });

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/neo/sw.js', { scope: '/neo/' })
        .then(() => console.log('[NeoProxy] Service Worker registered'))
        .catch(err => console.warn('[NeoProxy] SW failed:', err));
    }
  </script>
</body>
</html>
`;

// ===== SERVER (Node.js / Express) =====
const NeoServer = `
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const PREFIX = '/neo/';

// Encoding helpers
function encode(url) {
  return Buffer.from(encodeURIComponent(url)).toString('base64url');
}
function decode(encoded) {
  return decodeURIComponent(Buffer.from(encoded, 'base64url').toString('utf8'));
}

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve service worker
app.get(PREFIX + 'sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', PREFIX);
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Proxy route
app.use(PREFIX, async (req, res) => {
  const encodedPath = req.path.replace(/^\\//, '');
  if (!encodedPath) return res.status(400).send('No target URL');

  let targetURL;
  try {
    targetURL = decode(encodedPath);
  } catch (e) {
    return res.status(400).send('Invalid encoded URL');
  }

  if (req.query && Object.keys(req.query).length) {
    const qs = new URLSearchParams(req.query).toString();
    targetURL += '?' + qs;
  }

  try {
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };
    const parsed = new URL(targetURL);
    headers['Origin'] = parsed.origin;
    headers['Referer'] = parsed.origin + '/';

    const response = await fetch(targetURL, {
      method: req.method,
      headers,
      redirect: 'follow',
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Strip problematic headers
    const stripHeaders = [
      'x-frame-options', 'content-security-policy', 
      'x-content-type-options', 'strict-transport-security',
      'access-control-allow-origin'
    ];
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    for (const [key, val] of response.headers.entries()) {
      if (!stripHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    }
    res.status(response.status);

    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = rewriteHTML(html, targetURL);
      return res.send(html);
    }
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = rewriteCSS(css, targetURL);
      return res.send(css);
    }

    response.body.pipe(res);
  } catch (err) {
    res.status(502).send('NeoProxy Error: ' + err.message);
  }
});

function rewriteHTML(html, base) {
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (m, attr, url) => {
    if (/^(data:|blob:|#|javascript:)/i.test(url)) return m;
    try {
      const abs = new URL(url, base).href;
      return attr + '="' + PREFIX + encode(abs) + '"';
    } catch { return m; }
  });
  html = html.replace(/<\\/head>/i, '<script>window.__NEOPROXY=true;<\\/script></head>');
  return html;
}

function rewriteCSS(css, base) {
  return css.replace(/url\\(['"]?([^'"\\)\\s]+)['"]?\\)/gi, (m, url) => {
    if (/^(data:|blob:)/i.test(url)) return m;
    try {
      const abs = new URL(url, base).href;
      return 'url("' + PREFIX + encode(abs) + '")';
    } catch { return m; }
  });
}

app.listen(PORT, () => console.log('NeoProxy running on http://localhost:' + PORT));
`;

// ===== PACKAGE.JSON =====
const NeoPackageJSON = `{
  "name": "neoproxy",
  "version": "1.0.0",
  "description": "Advanced web proxy with URL rewriting (like Ultraviolet)",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^2.7.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}`;

// ===== README =====
const NeoREADME = `# NeoProxy 🌐

Ultravioletのようなロジックを持つ、一から作ったWebプロキシです。

## 機能

- 🔐 URL エンコード（Base64 + URLエンコード）
- 🔄 HTML/CSS/JS の URL 自動書き換え
- 🛡️ X-Frame-Options / CSP ヘッダーのバイパス
- 🌍 CORS ヘッダーの自動付与
- ⚡ Service Worker による透過的なリクエスト傍受
- 📦 srcset / meta refresh / form action 対応
- 🎨 美しいUI付き

## セットアップ

\`\`\`bash
npm install
npm start
\`\`\`

ブラウザで http://localhost:3000 を開く。

## ファイル構成

\`\`\`
neoproxy/
├── server.js        ← Express サーバー（プロキシ処理）
├── public/
│   ├── index.html   ← フロントエンドUI
│   └── sw.js        ← Service Worker
├── proxy.js         ← コアロジック（NeoCodec, URLRewriter, Runtime）
├── package.json
└── README.md
\`\`\`

## 仕組み

1. ユーザーがURLを入力
2. URLをBase64でエンコード → \`/neo/[encoded]\` にリダイレクト
3. Service Worker または Node.js サーバーがリクエストを傍受
4. ターゲットサイトにフェッチ（Origin/Refererスプーフィング）
5. HTMLを受け取り → 全URLを \`/neo/[encoded]\` に書き換え
6. クライアントに返す

## 対応サイト例

- Google, Wikipedia, Reddit, GitHub, Hacker News, YouTube 等

> **注意**: このプロキシは教育目的で作成されました。利用規約を守って使用してください。
`;

module.exports = {
  NeoCodec,
  NeoURLRewriter,
  NeoRuntime,
  NeoServiceWorker,
  NeoProxyUI,
  NeoServer,
  NeoPackageJSON,
  NeoREADME
};
