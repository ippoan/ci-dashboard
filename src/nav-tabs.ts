// Shared top-of-page tab navigation used by every SSR page (`/`, `/issues`,
// `/releases`). One tab per page; the active tab is highlighted via the
// `tab-active` modifier so the operator always knows which page they are on.
//
// Each SSR page inlines this HTML + CSS into its own `<style>` block to keep
// pages self-contained (no external stylesheet to fetch) and avoid the
// CSS-classname coupling problem if pages grow apart later.

export type TabKey = "dashboard" | "issues" | "releases";

interface TabDef {
  key: TabKey;
  href: string;
  label: string;
}

const TABS: ReadonlyArray<TabDef> = [
  { key: "dashboard", href: "/",         label: "📊 Dashboard" },
  { key: "issues",    href: "/issues",   label: "📋 Open Issues" },
  { key: "releases",  href: "/releases", label: "🏷️ Releases" },
];

export function renderTabs(active: TabKey): string {
  const items = TABS.map((t) => {
    const cls = t.key === active ? "tab tab-active" : "tab";
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
