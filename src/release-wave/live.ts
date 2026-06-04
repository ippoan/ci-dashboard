/**
 * `/release-wave` ページの live 更新クライアント (Refs #275)。
 *
 * 同一オリジン WebSocket (`/release-wave/ws`) に接続し、`ReleaseWaveHub` DO の
 * state が変わるたびに送られてくる「変わったよ」シグナルを受けて
 * `location.reload()` する。表示自体は既存 SSR をそのまま再取得するので、
 * DOM 差分更新の JS は持たない (= XSS 面を増やさない)。
 *
 * 配信は外部ファイル 1 個ぶんだけ CSP を `script-src 'self'` に緩めて許可する。
 * インライン JS は引き続き全ブロックされるため injected script は動かない。
 * `connect-src 'self'` で同一オリジン wss のみ許可するため、外部送信も不可。
 */

const LIVE_JS = `(function () {
  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/release-wave/ws");
    ws.onmessage = function () {
      // state が変わった → 既存 SSR を引き直す (一覧/詳細どちらでも現在 URL を再取得)。
      location.reload();
    };
    ws.onclose = function () {
      // 切断時は 3 秒後に再接続を試みる (deploy/hibernate 起因の drop に追従)。
      setTimeout(connect, 3000);
    };
    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
    };
  }
  connect();
})();
`;

export function handleReleaseWaveLiveJs(): Response {
  return new Response(LIVE_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // 小さな静的 asset。短期キャッシュで Worker request を減らしつつ、
      // 変更時の伝播は数分以内に収める。
      "Cache-Control": "public, max-age=300",
    },
  });
}
