/**
 * NeoProxy - Server (server.js)
 * Node.js + Express
 * Run: npm install && npm start
 */

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const PREFIX = '/neo/';

// ===== URL CODEC =====
function encode(url) {
  return Buffer.from(encodeURIComponent(url)).toString('base64url');
}
function decode(encoded) {
  try {
    return decodeURIComponent(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ===== HTML REWRITER =====
function rewriteHTML(html, base) {
  // Rewrite href/src/action attributes
  html = html.replace(/(href|src|action|data-src|poster)=["']([^"']+)["']/gi, (m, attr, url) => {
    if (/^(data:|blob:|#|javascript:|mailto:|tel:)/i.test(url)) return m;
    try {
      const abs = new URL(url, base).href;
      return `${attr}="${PREFIX}${encode(abs)}"`;
    } catch { return m; }
  });

  // Rewrite srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (m, srcset) => {
    const rewritten = srcset.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts.slice(1).join(' ');
      try {
        const abs = new URL(url, base).href;
        return `${PREFIX}${encode(abs)}${descriptor ? ' ' + descriptor : ''}`;
      } catch { return entry; }
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // Rewrite meta refresh
  html = html.replace(
    /(<meta[^>]+content=["'])(\d+;\s*url=)([^"']+)(["'])/gi,
    (m, pre, refresh, url, post) => {
      try {
        const abs = new URL(url, base).href;
        return `${pre}${refresh}${PREFIX}${encode(abs)}${post}`;
      } catch { return m; }
    }
  );

  // Inject proxy runtime + base tag
  const parsedBase = new URL(base);
  const runtimeScript = `
<script>
  window.__NEOPROXY = true;
  window.__NEOPROXY_BASE = ${JSON.stringify(base)};
  window.__NEOPROXY_PREFIX = ${JSON.stringify(PREFIX)};
  // Override fetch
  const _origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && !url.startsWith('/neo/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try {
        const abs = new URL(url, window.__NEOPROXY_BASE).href;
        url = window.__NEOPROXY_PREFIX + btoa(encodeURIComponent(abs)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      } catch(e) {}
    }
    return _origFetch(url, opts);
  };
  // Override XHR
  const _OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class NeoXHR extends _OrigXHR {
    open(method, url, ...args) {
      if (typeof url === 'string' && !url.startsWith('/neo/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
        try {
          const abs = new URL(url, window.__NEOPROXY_BASE).href;
          url = window.__NEOPROXY_PREFIX + btoa(encodeURIComponent(abs)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
        } catch(e) {}
      }
      super.open(method, url, ...args);
    }
  };
</script>`;

  html = html.replace(/<head([^>]*)>/i, (m, attrs) => `${m}${runtimeScript}`);
  if (!/<head/i.test(html)) {
    html = runtimeScript + html;
  }

  return html;
}

// ===== CSS REWRITER =====
function rewriteCSS(css, base) {
  return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (m, url) => {
    if (/^(data:|blob:)/i.test(url)) return m;
    try {
      const abs = new URL(url, base).href;
      return `url("${PREFIX}${encode(abs)}")`;
    } catch { return m; }
  });
}

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== SERVICE WORKER ROUTE =====
app.get(`${PREFIX}sw.js`, (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', PREFIX);
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ===== MAIN PROXY ROUTE =====
app.use(PREFIX, async (req, res) => {
  const encodedPath = req.path.replace(/^\//, '');
  if (!encodedPath) return res.status(400).send('No target URL');

  const targetURL = decode(encodedPath);
  if (!targetURL) return res.status(400).send('Invalid encoded URL');

  // Append query string from original request
  const fullTarget = req.query && Object.keys(req.query).length
    ? targetURL + '?' + new URLSearchParams(req.query).toString()
    : targetURL;

  let parsedTarget;
  try {
    parsedTarget = new URL(fullTarget);
  } catch {
    return res.status(400).send('Invalid target URL: ' + fullTarget);
  }

  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9,ja;q=0.8',
    'Accept-Encoding': 'identity',
    'Origin': parsedTarget.origin,
    'Referer': parsedTarget.origin + '/',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };

  // Forward cookie header if present
  if (req.headers['cookie']) {
    requestHeaders['Cookie'] = req.headers['cookie'];
  }

  const fetchOptions = {
    method: req.method,
    headers: requestHeaders,
    redirect: 'follow',
  };

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    fetchOptions.body = Buffer.concat(chunks);
    if (req.headers['content-type']) {
      requestHeaders['Content-Type'] = req.headers['content-type'];
    }
  }

  try {
    // Dynamic import for node-fetch v2
    const fetch = require('node-fetch');
    const response = await fetch(fullTarget, fetchOptions);
    const contentType = response.headers.get('content-type') || '';

    // ===== STRIP SECURITY HEADERS =====
    const STRIP_HEADERS = new Set([
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'x-content-type-options',
      'strict-transport-security',
      'cross-origin-embedder-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'permissions-policy',
    ]);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    for (const [key, val] of response.headers.entries()) {
      if (!STRIP_HEADERS.has(key.toLowerCase())) {
        // Rewrite Location header for redirects
        if (key.toLowerCase() === 'location') {
          try {
            const absLocation = new URL(val, fullTarget).href;
            res.setHeader('Location', PREFIX + encode(absLocation));
          } catch {
            res.setHeader(key, val);
          }
        } else {
          res.setHeader(key, val);
        }
      }
    }

    res.status(response.status);

    // ===== REWRITE CONTENT =====
    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = rewriteHTML(html, fullTarget);
      return res.send(html);
    }

    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = rewriteCSS(css, fullTarget);
      res.setHeader('Content-Type', 'text/css');
      return res.send(css);
    }

    // Stream binary content (images, fonts, etc.)
    response.body.pipe(res);

  } catch (err) {
    console.error('[NeoProxy] Error fetching', fullTarget, ':', err.message);
    res.status(502).send(`
      <html><body style="font-family:monospace;padding:40px;background:#0a0a0f;color:#e8e8f0">
        <h2 style="color:#f43f5e">NeoProxy Error</h2>
        <p>${err.message}</p>
        <p><a href="/" style="color:#7c3aed">← Back</a></p>
      </body></html>
    `);
  }
});

// Handle OPTIONS (CORS preflight)
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════╗
║   NeoProxy is running! 🌐        ║
║   http://localhost:${PORT}           ║
╚══════════════════════════════════╝
  `);
});
