/* 町内会 会計簿 — Service Worker
   アプリとしてインストールするために必要な最小構成。
   画面やデータはキャッシュせず常に最新を読み込む（古い版が残らないように）。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;          // 画面の読み込みだけ扱う
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:40px 20px;text-align:center;color:#3A322A;background:#FBF6EC"><h2>通信できません</h2><p>電波の良い場所で、もう一度開いてください。</p></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
