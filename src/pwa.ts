// PWA (Progressive Web App) assets for the ci-dashboard SSR pages.
//
// Exposes:
// - PWA_HEAD_TAGS: <link>/<meta> tags to inject into each page <head>.
// - PWA_REGISTER_SCRIPT: <script> snippet to register the service worker.
// - handlePwaManifest / handlePwaServiceWorker / handlePwaIcon: route handlers
//   served from src/index.ts.
//
// The service worker uses a network-first strategy for navigations (so live
// CI status is always fresh when online) and falls back to a cached shell
// when offline. Static assets (manifest, icons, SW itself) are cache-first.

const APP_NAME = "CI Dashboard";
const APP_SHORT_NAME = "CI Dash";
const THEME_COLOR = "#0d1117";
const BACKGROUND_COLOR = "#0d1117";

// Bump CACHE_VERSION whenever PWA assets change so old SWs evict caches.
const CACHE_VERSION = "v1";

export const PWA_HEAD_TAGS = `
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="${THEME_COLOR}">
  <meta name="application-name" content="${APP_NAME}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="${APP_SHORT_NAME}">
  <link rel="icon" type="image/svg+xml" href="/icons/icon.svg">
  <link rel="apple-touch-icon" href="/icons/icon-192.png.svg">`;

export const PWA_REGISTER_SCRIPT = `
  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      });
    }
  </script>`;

const MANIFEST = {
  name: APP_NAME,
  short_name: APP_SHORT_NAME,
  description: "GitHub Actions CI monitoring dashboard.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: BACKGROUND_COLOR,
  theme_color: THEME_COLOR,
  categories: ["developer", "productivity"],
  icons: [
    {
      src: "/icons/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/icons/icon-192.png.svg",
      sizes: "192x192",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png.svg",
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/icons/icon-maskable.svg",
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "maskable",
    },
  ],
  shortcuts: [
    {
      name: "Open Issues",
      short_name: "Issues",
      url: "/issues",
    },
    {
      name: "Releases",
      short_name: "Releases",
      url: "/releases",
    },
  ],
};

const SERVICE_WORKER_JS = `// CI Dashboard service worker (${CACHE_VERSION})
const CACHE_NAME = "ci-dashboard-${CACHE_VERSION}";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png.svg",
  "/icons/icon-512.png.svg",
  "/icons/icon-maskable.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept WebSocket / SSE / API / webhook / MCP traffic.
  if (
    url.pathname === "/ws" ||
    url.pathname === "/mcp" ||
    url.pathname === "/webhook" ||
    url.pathname === "/status" ||
    url.pathname === "/release-alerts" ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Navigations: network-first, fall back to cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/")),
        ),
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});
`;

// SVG icon: a stylized "CI" mark on the dashboard's dark background, with
// the same accent blue used in the dashboard header.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0d1117"/>
  <circle cx="256" cy="256" r="180" fill="none" stroke="#1f6feb" stroke-width="20"/>
  <circle cx="256" cy="92" r="22" fill="#3fb950"/>
  <text x="256" y="300" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="170" font-weight="700" fill="#58a6ff" text-anchor="middle">CI</text>
</svg>`;

// Maskable variant: same artwork inside the safe zone (centered 80%).
const ICON_MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0d1117"/>
  <g transform="translate(51 51) scale(0.8)">
    <rect width="512" height="512" rx="96" fill="#0d1117"/>
    <circle cx="256" cy="256" r="180" fill="none" stroke="#1f6feb" stroke-width="20"/>
    <circle cx="256" cy="92" r="22" fill="#3fb950"/>
    <text x="256" y="300" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="170" font-weight="700" fill="#58a6ff" text-anchor="middle">CI</text>
  </g>
</svg>`;

export function handlePwaManifest(): Response {
  return new Response(JSON.stringify(MANIFEST, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export function handlePwaServiceWorker(): Response {
  return new Response(SERVICE_WORKER_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // SWs should not be cached aggressively — browsers re-check on
      // every navigation so updates roll out promptly.
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}

export function handlePwaIcon(path: string): Response {
  const svg =
    path === "/icons/icon-maskable.svg" ? ICON_MASKABLE_SVG : ICON_SVG;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
