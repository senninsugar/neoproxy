/**
 * NeoProxy Service Worker (sw.js)
 * 役割: /neo/[encoded] へのリクエストをそのままサーバーに転送するだけ
 * 実際のfetchはNode.jsサーバー側で行う（ブラウザからは直接クロスオリジンfetch不可）
 */

const PREFIX = '/neo/';

self.addEventListener('install', (event) => {
  console.log('[NeoProxy SW] Installed');
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log('[NeoProxy SW] Activated');
  event.waitUntil(self.clients.claim());
});

// SWは何もしない — サーバーにそのまま流す
// （将来的にキャッシュ機能を追加できる場所）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PREFIX)) return;
  // pass through to server — do NOT intercept
});
