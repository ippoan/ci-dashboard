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

  // copy-to-clipboard wiring。inline JS は CSP で禁止なので、外部 self script
  // (= この live.js) から data-copy 属性のボタンに click listener を張る。
  // data-copy="<id>" の指す要素の textContent を clipboard に書き込む。
  function wireCopy() {
    var btns = document.querySelectorAll("[data-copy]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var target = document.getElementById(btn.getAttribute("data-copy"));
          if (!target) return;
          var text = target.textContent || "";
          var label = btn.textContent;
          function done() {
            btn.textContent = "\\u2713 copied";
            setTimeout(function () { btn.textContent = label; }, 1500);
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done);
          } else {
            // 古い環境向け fallback (execCommand)。
            try {
              var ta = document.createElement("textarea");
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              done();
            } catch (e) {}
          }
        });
      })(btns[i]);
    }
  }
  // flip-guard self-test: data-flipguard-repo / -vid を持つボタンを押すと、
  // 実 API (/api/release-wave/traffic-rollback) を **未 tag version** で叩く。
  // ガードが効いていれば 400 UNTAGGED_VERSION_FORBIDDEN が返る (= dispatch されず
  // 実デプロイは起きない)。結果を隣の .flipguard-result に inline 表示する。
  function wireFlipGuard() {
    var btns = document.querySelectorAll("[data-flipguard-repo]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var repo = btn.getAttribute("data-flipguard-repo");
          var vid = btn.getAttribute("data-flipguard-vid");
          var out = btn.parentNode
            ? btn.parentNode.querySelector(".flipguard-result")
            : null;
          function show(msg) { if (out) out.textContent = msg; }
          show(" \\u2026 testing");
          var fd = new FormData();
          fd.append("repo", repo);
          fd.append("version_id", vid);
          fetch("/api/release-wave/traffic-rollback", { method: "POST", body: fd })
            .then(function (r) {
              return r.json().then(
                function (j) { return { s: r.status, j: j }; },
                function () { return { s: r.status, j: {} }; },
              );
            })
            .then(function (res) {
              if (res.s === 400 && res.j && res.j.code === "UNTAGGED_VERSION_FORBIDDEN") {
                show(" \\u2705 PASS: 400 UNTAGGED_VERSION_FORBIDDEN (未tag flip は拒否された)");
              } else {
                show(" \\u26a0\\ufe0f UNEXPECTED: status=" + res.s + " code=" + (res.j && res.j.code));
              }
            })
            .catch(function (e) { show(" \\u26a0\\ufe0f error: " + e); });
        });
      })(btns[i]);
    }
  }

  function wireAll() { wireCopy(); wireFlipGuard(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireAll);
  } else {
    wireAll();
  }
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
