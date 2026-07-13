/**
 * `/release-wave` ページの live 更新クライアント (Refs #275 / #479)。
 *
 * 同一オリジン WebSocket (`/release-wave/ws`) に接続し、`ReleaseWaveHub` DO の
 * state 変化 (`saveWave`) や webhook report (traffic / pending-release /
 * backend-deploy / frontend-test / backend-traffic) の受信で送られてくる
 * 「変わったよ」シグナルを受けて **部分更新** する。
 *
 * 部分更新は「現在 URL を再取得 → 返ってきた HTML の `#rw-live` の中身だけを
 * 差し替える」方式 (Refs #479)。表示ロジックは既存 SSR をそのまま単一ソースとして
 * 再利用するため、DOM 差分の描画 JS は持たない (= XSS 面を増やさない)。全リロード
 * と違い scroll 位置が保たれ、asset 再取得やページ全体の再描画フラッシュが無い。
 * `#rw-live` を持たないページ (wave 詳細ページ等) は従来どおり `location.reload()`
 * に fallback する。
 *
 * 配信は外部ファイル 1 個ぶんだけ CSP を `script-src 'self'` に緩めて許可する。
 * インライン JS は引き続き全ブロックされるため injected script は動かない。
 * `connect-src 'self'` で同一オリジン wss / fetch のみ許可するため、外部送信も不可。
 */

const LIVE_JS = `(function () {
  // webhook のバースト (deploy 時に traffic/pending 等が連続して届く) を 1 回の
  // 再取得にまとめるための debounce。連投シグナルで fetch を何度も走らせない。
  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      refresh();
    }, 250);
  }

  // 現在 URL を引き直し、#rw-live の中身だけを差し替える (部分更新)。対象が無い
  // ページ (詳細ページ等) や取得失敗のフォールバックは全リロード。
  function refresh() {
    var live = document.getElementById("rw-live");
    if (!live) {
      location.reload();
      return;
    }
    fetch(location.href, { headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var next = doc.getElementById("rw-live");
        if (!next) {
          // レイアウトが想定外 → 安全側で全リロード。
          location.reload();
          return;
        }
        // 同一オリジンの admin-trusted SSR を差し込むだけ (script は innerHTML では
        // 実行されない)。差し替え後は新 DOM に copy / flip-guard を張り直す。
        live.innerHTML = next.innerHTML;
        wireAll();
      })
      .catch(function () {
        // 一時的な取得失敗は無視 (次のシグナルで再試行する)。
      });
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/release-wave/ws");
    ws.onmessage = function () {
      // state / report が変わった → 現在 URL を引き直して #rw-live を部分更新。
      scheduleRefresh();
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
                show(" \\u2705 PASS: 400 UNTAGGED_VERSION_FORBIDDEN (release tag 未紐付け version の flip は拒否された)");
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
