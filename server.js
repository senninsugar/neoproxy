/**
 * NeoProxy - Server
 * Node.js + Express
 * Run: npm install && npm start
 */

const express = require('express');
const path    = require('path');
const fetch   = require('node-fetch');
const https   = require('https');
const http    = require('http');

const app    = express();
const PORT   = process.env.PORT || 3000;
const PREFIX = '/neo/';

// ===== URL CODEC =====
// Matches frontend: btoa(encodeURIComponent(url)).replace(+→- /→_ =→'')
function encode(url) {
  return Buffer.from(encodeURIComponent(url))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function decode(encoded) {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
    return decodeURIComponent(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ===== HTML REWRITER =====
function rewriteHTML(html, base) {
  // href / src / action / data-src / poster
  html = html.replace(/(href|src|action|data-src|poster)=(["'])([^"'\s>]+)\2/gi,
    (m, attr, q, url) => {
      if (/^(data:|blob:|#|javascript:|mailto:|tel:|about:)/i.test(url)) return m;
      try {
        const abs = new URL(url, base).href;
        return `${attr}=${q}${PREFIX}${encode(abs)}${q}`;
      } catch { return m; }
    }
  );

  // srcset
  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (m, q, srcset) => {
    const rw = srcset.split(',').map(entry => {
      const [url, ...rest] = entry.trim().split(/\s+/);
      try {
        const abs = new URL(url, base).href;
        return `${PREFIX}${encode(abs)}${rest.length ? ' ' + rest.join(' ') : ''}`;
      } catch { return entry; }
    }).join(', ');
    return `srcset=${q}${rw}${q}`;
  });

  // Inject runtime before </head>
  const runtime = buildRuntime(base);
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, runtime + '</head>');
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

// ===== RUNTIME SCRIPT =====
function buildRuntime(baseURL) {
  return `<script>
(function(){
  if(window.__NP) return; window.__NP=true;
  var BASE=${JSON.stringify(baseURL)};
  var PFX=${JSON.stringify(PREFIX)};
  function enc(url){
    try{
      var abs=new URL(url,BASE).href;
      return PFX+btoa(encodeURIComponent(abs)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    }catch(e){return url;}
  }
  function safe(url){
    return(!url||/^(data:|blob:|#|javascript:|mailto:|tel:|about:|\/neo\/)/i.test(url));
  }
  // fetch
  var _f=window.fetch;
  window.fetch=function(u,o){return _f.call(this,safe(u)?u:enc(u),o);};
  // XHR
  var _X=window.XMLHttpRequest;
  window.XMLHttpRequest=class extends _X{
    open(m,u,...a){super.open(m,safe(u)?u:enc(u),...a);}
  };
  // form submit
  document.addEventListener('submit',function(e){
    var f=e.target;
    if(f.action&&!safe(f.action)) f.action=enc(f.action);
  },true);
})();
<\/script>`;
}

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== SERVICE WORKER =====
app.get(`${PREFIX}sw.js`, (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', PREFIX);
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ===== PROXY ROUTE =====
app.use(PREFIX, async (req, res) => {
  // Decode path
  const encodedPath = req.path.replace(/^\//, '');
  if (!encodedPath) return res.status(400).send('No target URL');

  const targetURL = decode(encodedPath);
  if (!targetURL) return res.status(400).send('Could not decode URL: ' + encodedPath);

  // Append query string
  const fullTarget = Object.keys(req.query).length
    ? targetURL + '?' + new URLSearchParams(req.query).toString()
    : targetURL;

  let parsedTarget;
  try { parsedTarget = new URL(fullTarget); }
  catch { return res.status(400).send('Invalid target URL: ' + fullTarget); }

  // Build request headers
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    'Accept-Encoding': 'identity',
    'Origin': parsedTarget.origin,
    'Referer': parsedTarget.origin + '/',
    'Upgrade-Insecure-Requests': '1',
  };
  if (req.headers['cookie']) reqHeaders['Cookie'] = req.headers['cookie'];
  if (req.headers['content-type']) reqHeaders['Content-Type'] = req.headers['content-type'];

  // Build fetch options
  const fetchOpts = { method: req.method, headers: reqHeaders, redirect: 'follow' };
  if (!['GET','HEAD'].includes(req.method.toUpperCase())) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    fetchOpts.body = Buffer.concat(chunks);
  }

  try {
    const response = await fetch(fullTarget, fetchOpts);
    const contentType = response.headers.get('content-type') || '';

    // Strip blocking headers
    const STRIP = new Set([
      'x-frame-options','content-security-policy','content-security-policy-report-only',
      'x-content-type-options','strict-transport-security',
      'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
      'permissions-policy','report-to','nel',
    ]);

    res.setHeader('Access-Control-Allow-Origin', '*');
    for (const [k, v] of response.headers.entries()) {
      if (STRIP.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'location') {
        try {
          const abs = new URL(v, fullTarget).href;
          res.setHeader('Location', PREFIX + encode(abs));
        } catch { res.setHeader(k, v); }
        continue;
      }
      if (k.toLowerCase() === 'set-cookie') {
        res.setHeader(k, v.replace(/;\s*domain=[^;]+/gi,'').replace(/;\s*secure/gi,''));
        continue;
      }
      try { res.setHeader(k, v); } catch {}
    }
    res.status(response.status);

    if (contentType.includes('text/html')) {
      const html = await response.text();
      return res.send(rewriteHTML(html, fullTarget));
    }
    if (contentType.includes('text/css')) {
      const css = await response.text();
      res.setHeader('Content-Type','text/css; charset=utf-8');
      return res.send(rewriteCSS(css, fullTarget));
    }

    response.body.pipe(res);

  } catch (err) {
    console.error('[NeoProxy] Error:', fullTarget, err.message);
    res.status(502).send(`
      <html><body style="font-family:monospace;padding:40px;background:#0a0a0f;color:#e8e8f0">
        <h2 style="color:#f43f5e">NeoProxy Error</h2>
        <p><b>Target:</b> ${fullTarget}</p>
        <p><b>Error:</b> ${err.message}</p>
        <p><a href="/" style="color:#7c3aed">← Back</a></p>
      </body></html>
    `);
  }
});

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════╗
║   NeoProxy running 🌐            ║
║   http://localhost:${PORT}           ║
╚══════════════════════════════════╝`);
});
