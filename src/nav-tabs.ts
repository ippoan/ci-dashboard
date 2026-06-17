// Shared top-of-page tab navigation used by every SSR page (`/`, `/issues`,
// `/releases`). One tab per page; the active tab is highlighted via the
// `tab-active` modifier so the operator always knows which page they are on.
//
// Each SSR page inlines this HTML + CSS into its own `<style>` block to keep
// pages self-contained (no external stylesheet to fetch) and avoid the
// CSS-classname coupling problem if pages grow apart later.

export type TabKey =
  | "dashboard"
  | "issues"
  | "projects"
  | "releases"
  | "release-wave"
  | "secret-gen"
  | "cap-catalog";

interface TabDef {
  key: TabKey | "branch-protection" | "gcp-secrets" | "security-inventory" | "repo-maps";
  href: string;
  label: string;
  // External tabs live on a different origin, so they open in a new tab and
  // are never marked active here. The destination handler does its own auth
  // gating — `branch-protection` bounces non-elevated browsers into
  // `/mcp/elevate`; `gcp-secrets` requires Google IAM (the operator already
  // has accessor permissions on the project).
  external?: boolean;
}

// secrets-inventory (ippoan/secrets-inventory) で source of truth として扱う
// GCP project。値取得 1-click の入口として GCP Secret Manager コンソールに
// 直接飛ばす。project を変える場合はここを差し替える。
const SECRETS_GCP_PROJECT = "cloudsql-sv";

const TABS: ReadonlyArray<TabDef> = [
  { key: "dashboard",  href: "/",           label: "📊 Dashboard" },
  { key: "issues",     href: "/issues",     label: "📋 Open Issues" },
  { key: "projects",   href: "/projects",   label: "🗂️ Projects" },
  { key: "releases",   href: "/releases",   label: "🏷️ Releases" },
  { key: "release-wave", href: "/release-wave", label: "🌊 Release Waves" },
  { key: "secret-gen", href: "/secret-gen", label: "🔐 Secret Generator" },
  { key: "cap-catalog", href: "/cap-catalog", label: "🗂️ Cap Catalog" },
  {
    key: "branch-protection",
    href: "https://auth-staging.ippoan.org/dashboard/branch-protection",
    label: "🛡️ Branch Protection",
    external: true,
  },
  {
    key: "gcp-secrets",
    href: `https://console.cloud.google.com/security/secret-manager?project=${encodeURIComponent(SECRETS_GCP_PROJECT)}`,
    label: "🗝️ GCP Secrets",
    external: true,
  },
  {
    key: "security-inventory",
    href: "https://security-inventory.ippoan.org/",
    label: "🔍 Security Inventory",
    external: true,
  },
  // ippoan/claude-skills の <repo>-map スキルを MkDocs で整形した閲覧サイト
  // (GitHub Pages、認証不要)。各 repo のどこに何があるかの構造ナビゲーション。
  {
    key: "repo-maps",
    href: "https://ippoan.github.io/claude-skills/",
    label: "🗺️ Repo Maps",
    external: true,
  },
];

export function renderTabs(active: TabKey): string {
  const items = TABS.map((t) => {
    const cls = t.key === active ? "tab tab-active" : "tab";
    if (t.external) {
      return `<a href="${t.href}" class="${cls}" target="_blank" rel="noopener">${t.label}</a>`;
    }
    return `<a href="${t.href}" class="${cls}">${t.label}</a>`;
  }).join("");
  return `<nav class="tabs">${items}</nav>`;
}

// Inline this into each page's `<style>` block.
//
// Layout: flex strip with a 1px bottom border; each tab paints a 2px coloured
// underline only when active, sitting on top of the strip border via a -1px
// negative margin so the active tab "owns" that pixel column.
export const TAB_STYLES = `
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid #30363d;
  }
  .tab {
    padding: 8px 14px;
    font-size: 13px;
    color: #8b949e;
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    white-space: nowrap;
  }
  .tab:hover { color: #c9d1d9; }
  .tab-active {
    color: #58a6ff;
    border-bottom-color: #58a6ff;
    font-weight: 600;
  }
`;
