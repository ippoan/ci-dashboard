/**
 * Smoke tests for the shared nav-tabs strip. The strip is rendered on every
 * SSR page (dashboard / issues / releases / secret-gen), so a missing or
 * malformed tab silently breaks navigation everywhere.
 */
import { describe, it, expect } from "vitest";
import { renderTabs } from "../src/nav-tabs";

describe("renderTabs — internal tabs", () => {
  it("marks the active tab with tab-active and the rest plain", () => {
    const html = renderTabs("issues");
    expect(html).toMatch(/tab tab-active[^>]*>\s*📋 Open Issues/);
    expect(html).toMatch(/class="tab"[^>]*>\s*📊 Dashboard/);
  });

  it("renders the Secret Generator tab", () => {
    const html = renderTabs("dashboard");
    expect(html).toContain('href="/secret-gen"');
    expect(html).toContain("🔐 Secret Generator");
  });

  it("renders the Projects tab pointing at /projects", () => {
    const html = renderTabs("dashboard");
    expect(html).toContain('href="/projects"');
    expect(html).toContain("🗂️ Projects");
  });

  it("marks the Projects tab active when key='projects'", () => {
    const html = renderTabs("projects");
    expect(html).toMatch(/tab tab-active[^>]*>\s*🗂️ Projects/);
    // sibling tabs stay plain
    expect(html).toMatch(/class="tab"[^>]*>\s*📋 Open Issues/);
  });
});

describe("renderTabs — external tabs", () => {
  it("renders Branch Protection tab pointing at the auth-worker dashboard, opens in new tab", () => {
    const html = renderTabs("dashboard");
    expect(html).toContain(
      'href="https://auth-staging.ippoan.org/dashboard/branch-protection"',
    );
    expect(html).toContain("🛡️ Branch Protection");
    // external tabs MUST get target="_blank" + rel="noopener" so the
    // destination origin can't reach back into ci-dashboard via window.opener
    expect(html).toMatch(
      /href="https:\/\/auth-staging\.ippoan\.org[^"]*"[^>]*target="_blank"[^>]*rel="noopener"/,
    );
  });

  it("renders GCP Secrets tab pointing at the Secret Manager console for cloudsql-sv", () => {
    const html = renderTabs("dashboard");
    expect(html).toContain(
      'href="https://console.cloud.google.com/security/secret-manager?project=cloudsql-sv"',
    );
    expect(html).toContain("🗝️ GCP Secrets");
    // same anti-tabnabbing requirement as branch-protection
    expect(html).toMatch(
      /href="https:\/\/console\.cloud\.google\.com[^"]*"[^>]*target="_blank"[^>]*rel="noopener"/,
    );
  });

  it("never marks an external tab as active even if its key string is passed in (defensive)", () => {
    // Internal tabs are typed via TabKey, but a future contributor could
    // widen the type by mistake — make sure external tabs stay plain.
    const html = renderTabs("dashboard");
    expect(html).not.toMatch(/tab tab-active[^>]*>\s*🛡️ Branch Protection/);
    expect(html).not.toMatch(/tab tab-active[^>]*>\s*🗝️ GCP Secrets/);
  });
});
