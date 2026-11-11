/**
 * Release Wave の MCP App ビュー (Refs ippoan/ci-dashboard#525)。
 *
 * `release_wave_pending_state` / `release_wave_status` の結果を、Claude などの
 * MCP Apps 対応ホストの会話内に表として出し、Flip / Flip all / approve /
 * rollback / abort / fail をボタンから呼べるようにする。
 *
 * - ビューは sandbox の iframe で動く。ext-apps の App (依存込み 1 ファイル) は
 *   jsDelivr から版固定で読む (Worker からは node_modules を文字列で読めないため)。
 *   CSP の resourceDomains に jsDelivr だけを宣言する。
 * - ボタンはビューから既存の MCP tool を `tools/call` で呼ぶだけ。scope gate
 *   (`createScopedRegisterTool`) とホスト側の承認はそのまま効く。
 * - 操作の結果は `ui/update-model-context` で会話側にも知らせる。
 *
 * ビューの JS はこの TS の template literal に入るので、バッククォートと
 * `${` を使わない (文字列連結で書く)。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const RELEASE_WAVE_VIEW_URI = "ui://ci-dashboard/release-wave.html";
/** MCP Apps の HTML リソースの mimeType (ext-apps の RESOURCE_MIME_TYPE と同値)。 */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** ビューが読む ext-apps の版。ホスト側の wire protocol は 1.x / 2.x で共通。 */
export const EXT_APPS_VERSION = "1.7.5";

/** tool の `_meta` に付ける UI 参照。 */
export const RELEASE_WAVE_VIEW_META = {
  ui: { resourceUri: RELEASE_WAVE_VIEW_URI },
} as const;

export function registerReleaseWaveView(server: McpServer): void {
  server.registerResource(
    "Release Wave view",
    RELEASE_WAVE_VIEW_URI,
    {
      description: "Release Wave の Pending releases / wave 状態の表示と操作",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: RELEASE_WAVE_VIEW_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: releaseWaveViewHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { resourceDomains: ["https://cdn.jsdelivr.net"] },
            },
          },
        },
      ],
    }),
  );
}

export function releaseWaveViewHtml(): string {
  return VIEW_HTML.replace(
    "__EXT_APPS_URL__",
    `https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@${EXT_APPS_VERSION}/dist/src/app-with-deps.js`,
  );
}

const VIEW_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release Wave</title>
<style>
:root{
  --bg:var(--color-background-primary,#fff); --bg2:var(--color-background-secondary,#f5f6f7);
  --ink:var(--color-text-primary,#1c2328); --muted:var(--color-text-secondary,#5d6b75);
  --line:var(--color-border-primary,#d9dee2); --accent:#1f6feb; --ok:#1f7a4d; --warn:#9a6700; --bad:#b3261e;
  --sans:var(--font-sans,system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif);
  --mono:var(--font-mono,ui-monospace,Menlo,monospace);
}
:root[data-theme="dark"]{
  --bg:var(--color-background-primary,#1a1d21); --bg2:var(--color-background-secondary,#23272c);
  --ink:var(--color-text-primary,#e6e9ec); --muted:var(--color-text-secondary,#98a3ad);
  --line:var(--color-border-primary,#353b42); --accent:#4c8dff; --ok:#4cc28a; --warn:#d6a33a; --bad:#ff7a6e;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 var(--sans)}
.wrap{padding:12px 14px 14px;display:grid;gap:10px}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
h1{font-size:15px;margin:0;font-weight:600}
.sub{color:var(--muted);font-size:12px}
.sp{flex:1}
input.who{font:12px var(--sans);padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);width:190px}
button{font:500 12px var(--sans);border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap}
button:hover:not(:disabled){border-color:var(--accent)}
button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}
button.armed{background:var(--bad);border-color:var(--bad);color:#fff}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:500;color:var(--muted);font-size:11px;letter-spacing:.04em}
td.mono,.mono{font-family:var(--mono);font-size:12px}
.card{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.card>.hd{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg2);border-bottom:1px solid var(--line)}
.card>.hd b{font-weight:600}
.empty{padding:14px 10px;color:var(--muted)}
.badge{display:inline-block;font:500 11px var(--sans);padding:1px 7px;border-radius:999px;border:1px solid currentColor}
.s-ok{color:var(--ok)} .s-warn{color:var(--warn)} .s-bad{color:var(--bad)} .s-mut{color:var(--muted)}
.msg{padding:7px 10px;border-radius:6px;background:var(--bg2);border:1px solid var(--line);font-size:12px;white-space:pre-wrap}
.msg.err{border-color:var(--bad);color:var(--bad)}
details summary{cursor:pointer;color:var(--muted);font-size:12px;padding:6px 10px}
pre{margin:0;padding:8px 10px;font:11px/1.4 var(--mono);overflow:auto;max-height:260px}
.acts{display:flex;gap:6px;flex-wrap:wrap}
a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">Release Wave</h1>
    <span class="sub" id="sub">読み込み中…</span>
    <span class="sp"></span>
    <input class="who" id="who" placeholder="実行者(audit に記録)" autocomplete="off">
    <button id="refresh" type="button">更新</button>
  </header>
  <div id="msg" hidden class="msg"></div>
  <div id="body"></div>
</div>
<script type="module">
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "__EXT_APPS_URL__";

const app = new App({ name: "ci-dashboard-release-wave", version: "1.0.0" }, {}, { autoResize: true });
const $ = function (id) { return document.getElementById(id); };
const h = function (tag, attrs, kids) {
  const el = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(kids == null ? [] : kids)) el.append(c instanceof Node ? c : String(c));
  return el;
};

let view = null;     // { kind: "pending", repo } | { kind: "wave", wave_id }
let busy = false;

// --- 実行者 (*_by に入る)。sandbox では storage が投げることがある -------------
try { $("who").value = localStorage.getItem("rw.who") || ""; } catch (e) {}
$("who").addEventListener("change", function () {
  try { localStorage.setItem("rw.who", $("who").value.trim()); } catch (e) {}
});
const who = function () {
  const v = $("who").value.trim();
  if (!v) { $("who").focus(); throw new Error("実行者を入れてください(audit に記録されます)"); }
  return v;
};

function showMsg(text, err) {
  const m = $("msg");
  m.hidden = !text;
  m.textContent = text || "";
  m.className = "msg" + (err ? " err" : "");
}

function short(v) { return v ? String(v).slice(0, 8) : "—"; }
function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 2 段階クリック: 1 回目で「確定?」に変わり、4 秒以内の 2 回目で実行。 */
function armed(label, run, opts) {
  const o = opts || {};
  let timer = null;
  const b = h("button", { type: "button", class: o.danger ? "danger" : (o.primary ? "primary" : ""), disabled: o.disabled }, label);
  b.addEventListener("click", function () {
    if (busy) return;
    if (!b.classList.contains("armed")) {
      b.classList.add("armed"); b.textContent = label + " — 確定?";
      timer = setTimeout(function () { b.classList.remove("armed"); b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer); b.classList.remove("armed"); b.textContent = label;
    run();
  });
  return b;
}

function parse(result) {
  if (result && result.structuredContent) return result.structuredContent;
  const t = result && result.content && result.content[0] && result.content[0].text;
  try { return t ? JSON.parse(t) : null; } catch (e) { return { error: t }; }
}

async function call(name, args) {
  const r = await app.callServerTool({ name: name, arguments: args });
  const data = parse(r);
  if (r.isError) {
    const e = new Error((data && (data.code ? data.code + ": " : "") + (data.error || "")) || name + " failed");
    e.data = data;
    throw e;
  }
  return data;
}

/** 操作 → 結果を表示し、会話側にも知らせて、表を取り直す。 */
async function act(label, name, args) {
  if (busy) return;
  busy = true; showMsg(label + " を送信中…");
  try {
    const data = await call(name, args);
    let line = label + ": ok";
    if (data && data.state) line += " → " + data.state;
    if (data && Array.isArray(data.flipped)) line += " → " + data.flipped.length + " 件 flip を送信";
    if (data && data.tag && data.repo) line += " → " + data.repo + " " + data.tag + "(結果は GitHub Actions の run で確認)";
    showMsg(line);
    app.updateModelContext({ content: [{ type: "text", text: "[Release Wave ビューで実行] " + label + " → ok\\n" + JSON.stringify(data).slice(0, 2000) }] }).catch(function () {});
  } catch (e) {
    showMsg(label + ": " + e.message, true);
    app.updateModelContext({ content: [{ type: "text", text: "[Release Wave ビューで実行] " + label + " → 失敗: " + e.message }] }).catch(function () {});
  } finally {
    busy = false;
    await refresh(true);
  }
}

// --- Pending releases ---------------------------------------------------------
function renderPending(d) {
  const unified = d.unified || [];
  const flippable = unified.filter(function (u) { return !!u.tag; });
  $("title").textContent = "Release Wave — Pending releases";
  $("sub").textContent = unified.length + " 件(flip 可 " + flippable.length + ")" + (view.repo ? " · filter: " + view.repo : "");
  const rows = unified.map(function (u) {
    const label = u.repo + (u.worker_name ? " / " + u.worker_name : "");
    return h("tr", {}, [
      h("td", {}, [h("div", {}, u.repo), u.worker_name ? h("div", { class: "sub mono" }, u.worker_name) : ""]),
      h("td", { class: "mono" }, u.tag ? u.tag : h("span", { class: "s-warn" }, "未tag")),
      h("td", { class: "mono", title: u.version_id }, short(u.version_id)),
      h("td", { class: "mono", title: u.rollback_to || "" }, u.rollback_tag || short(u.rollback_to)),
      h("td", {}, [h("span", { class: "badge s-mut" }, u.source), " ", h("span", { class: "sub" }, when(u.uploaded_at))]),
      h("td", {}, h("div", { class: "acts" }, [
        u.preview_url ? h("button", { type: "button", onclick: function () { app.openLink({ url: u.preview_url }); } }, "preview") : "",
        armed("Flip", function () {
          act("Flip " + label + " " + (u.tag || ""), "release_wave_pending_flip", { repo: u.repo, worker_name: u.worker_name || undefined });
        }, { primary: true, disabled: !u.tag }),
      ])),
    ]);
  });
  const card = h("div", { class: "card" }, [
    h("div", { class: "hd" }, [
      h("b", {}, "Pending releases"), h("span", { class: "sp" }),
      armed("Flip all (" + flippable.length + ")", function () {
        let by; try { by = who(); } catch (e) { showMsg(e.message, true); return; }
        act("Flip all", "release_wave_pending_flip_all", { flipped_by: by });
      }, { primary: true, disabled: flippable.length === 0 }),
    ]),
    unified.length
      ? h("table", {}, [h("thead", {}, h("tr", {}, ["repo", "tag", "version", "戻し先", "source", ""].map(function (t) { return h("th", {}, t); }))), h("tbody", {}, rows)])
      : h("div", { class: "empty" }, "flip 待ちの release はありません"),
  ]);
  const traffic = h("details", { class: "card" }, [
    h("summary", {}, "traffic(per worker の active / 0% version)"),
    h("pre", {}, JSON.stringify(d.traffic || [], null, 2)),
  ]);
  $("body").replaceChildren(card, traffic);
}

// --- Wave ----------------------------------------------------------------------
const STATE_CLASS = { "pending-approval": "s-warn", flipping: "s-warn", flipped: "s-ok", "rolled-back": "s-mut", failed: "s-bad", aborted: "s-mut", staging: "s-mut" };

// sandbox の iframe では window.prompt が使えないので、理由は入力欄から取る
function reasonPrompt(label) {
  const el = $("reason");
  const r = el ? el.value.trim() : "";
  if (!r) { if (el) el.focus(); throw new Error(label + " の理由を入れてください(audit に記録されます)"); }
  return r;
}

function renderWave(w) {
  $("title").textContent = "Release Wave — " + w.wave_id;
  $("sub").textContent = w.flip_policy + " · 開始 " + when(w.started_at) + (w.note ? " · " + w.note : "");
  const st = h("span", { class: "badge " + (STATE_CLASS[w.state] || "s-mut") }, w.state);
  const rb = w.rollback || {};
  const guard = function (fn) { return function () { try { fn(); } catch (e) { showMsg(e.message, true); } }; };
  const acts = [];
  if (w.state === "pending-approval") {
    acts.push(armed("approve", guard(function () { act("approve " + w.wave_id, "release_wave_approve", { wave_id: w.wave_id, approved_by: who() }); }), { primary: true }));
    acts.push(armed("abort", guard(function () { act("abort " + w.wave_id, "release_wave_abort", { wave_id: w.wave_id, aborted_by: who(), reason: reasonPrompt("abort") }); }), { danger: true }));
  }
  if (w.state === "pending-approval" || w.state === "flipping" || w.state === "staging") {
    acts.push(armed("fail(強制終了)", guard(function () { act("fail " + w.wave_id, "release_wave_fail", { wave_id: w.wave_id, reason: reasonPrompt("fail") }); }), { danger: true }));
  }
  if (w.state === "flipped") {
    acts.push(armed(rb.safe === false ? "rollback(force)" : "rollback", guard(function () {
      act("rollback " + w.wave_id, "release_wave_rollback", { wave_id: w.wave_id, rolled_back_by: who(), force: rb.safe === false ? true : undefined });
    }), { danger: true }));
  }
  const needsReason = w.state === "pending-approval" || w.state === "flipping" || w.state === "staging";
  const head = h("div", { class: "card" }, [
    h("div", { class: "hd" }, [st, h("span", { class: "sub" }, rb.safe === false ? "rollback unsafe: " + (rb.unsafe_by_migration || rb.unsafe_reason || "") : "rollback safe"), h("span", { class: "sp" }),
      needsReason ? h("input", { class: "who", id: "reason", placeholder: "abort / fail の理由", autocomplete: "off" }) : "",
      h("div", { class: "acts" }, acts)]),
    h("table", {}, [
      h("thead", {}, h("tr", {}, ["repo", "target", "flip", "deployed", "戻し先"].map(function (t) { return h("th", {}, t); }))),
      h("tbody", {}, (w.repos || []).map(function (r) {
        const cls = r.flip_status === "done" ? "s-ok" : r.flip_status === "failed" ? "s-bad" : "s-mut";
        return h("tr", {}, [
          h("td", {}, [r.repo, r.require_compatibility ? h("span", { class: "sub" }, " · compat gate") : ""]),
          h("td", { class: "mono" }, r.target_tag),
          h("td", {}, [h("span", { class: "badge " + cls }, r.flip_status), r.flip_error ? h("div", { class: "s-bad sub" }, r.flip_error) : ""]),
          h("td", { class: "mono", title: r.deployed_version || "" }, short(r.deployed_version)),
          h("td", { class: "mono", title: r.rolled_back_to_revision || r.flip_from_revision || "" }, short(r.rolled_back_to_revision || r.flip_from_revision)),
        ]);
      })),
    ]),
  ]);
  const events = (w.events || []).slice(-12).reverse();
  const log = h("details", { class: "card", open: events.length <= 5 }, [
    h("summary", {}, "events(新しい順 " + events.length + ")"),
    h("table", {}, h("tbody", {}, events.map(function (e) {
      return h("tr", {}, [h("td", { class: "sub" }, when(e.at)), h("td", { class: "mono" }, e.kind), h("td", {}, e.summary)]);
    }))),
  ]);
  const kids = [head, log];
  if (w.compatibility) kids.push(h("details", { class: "card" }, [h("summary", {}, "compatibility"), h("pre", {}, JSON.stringify(w.compatibility, null, 2))]));
  $("body").replaceChildren.apply($("body"), kids);
}

// --- 振り分け --------------------------------------------------------------------
function render(data) {
  if (!data) return;
  if (data.code && data.error) { showMsg(data.code + ": " + data.error, true); return; }
  if (Array.isArray(data.unified)) { view = view && view.kind === "pending" ? view : { kind: "pending", repo: "" }; renderPending(data); }
  else if (data.wave_id) { view = { kind: "wave", wave_id: data.wave_id }; renderWave(data); }
}

async function refresh(quiet) {
  if (!view) return;
  if (!quiet) showMsg("");
  try {
    const data = view.kind === "wave"
      ? await call("release_wave_status", { wave_id: view.wave_id })
      : await call("release_wave_pending_state", view.repo ? { repo: view.repo } : {});
    render(data);
  } catch (e) {
    showMsg(e.message, true);
  }
}
$("refresh").addEventListener("click", function () { refresh(false); });

function applyHost(ctx) {
  if (!ctx) return;
  if (ctx.theme) { applyDocumentTheme(ctx.theme); document.documentElement.dataset.theme = ctx.theme; }
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.ontoolinput = function (p) {
  const a = (p && p.arguments) || {};
  if (a.wave_id) view = { kind: "wave", wave_id: a.wave_id };
  else view = { kind: "pending", repo: a.repo || "" };
};
app.ontoolresult = function (r) {
  if (r.isError) { const d = parse(r); showMsg((d && (d.code || "") + " " + (d.error || "")) || "error", true); return; }
  render(parse(r));
};
app.onhostcontextchanged = applyHost;

await app.connect();
applyHost(app.getHostContext());
</script>
</body>
</html>
`;
