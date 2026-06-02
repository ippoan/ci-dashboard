/**
 * `/cc` is the stateless launch-redirect for the open-multirepo skill. It
 * reconstructs the long `claude.ai/code` URL from a compact `?i=<issue>` query
 * and 302s to it (no storage, no third-party shortener). These specs assert
 * the redirect target, the default repo preset, explicit/invalid `r=` handling
 * and the prompt template / override — and that it only ever builds a
 * claude.ai/code URL (no open redirect).
 */
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

// `/cc` never touches the env binding, so an empty cast is sufficient.
const ENV = {} as unknown as Env;

async function launch(qs: string): Promise<Response> {
  return worker.fetch(
    new Request("https://ci-dashboard.ippoan.org/cc" + qs),
    ENV,
    {} as ExecutionContext,
  );
}

function location(res: Response): string {
  const loc = res.headers.get("Location");
  expect(loc).not.toBeNull();
  return loc as string;
}

describe("GET /cc (open-multirepo launch redirect)", () => {
  it("400 when i is missing", async () => {
    const res = await launch("");
    expect(res.status).toBe(400);
  });

  it("302 to claude.ai/code with the default repo preset + template prompt", async () => {
    const res = await launch("?i=" + encodeURIComponent("ippoan/claude-hooks#8"));
    expect(res.status).toBe(302);
    const loc = location(res);
    expect(loc.startsWith("https://claude.ai/code?repositories=")).toBe(true);
    const u = new URL(loc);
    const repos = u.searchParams.get("repositories") ?? "";
    expect(repos).toContain("ippoan/ci-dashboard");
    expect(repos).toContain("ippoan/ippoan-drift");
    const prompt = u.searchParams.get("prompt") ?? "";
    expect(prompt).toContain("ippoan/claude-hooks#8");
    expect(prompt).toContain("default branch");
  });

  it("treats an r= keyword without a slash (all) as the default preset", async () => {
    const res = await launch("?i=x/y%231&r=all");
    expect(res.status).toBe(302);
    expect(location(res)).toContain("ippoan/ippoan-drift");
  });

  it("narrows to an explicit owner/repo list", async () => {
    const res = await launch(
      "?i=x/y%231&r=" + encodeURIComponent("ippoan/a,ippoan/b"),
    );
    const repos = new URL(location(res)).searchParams.get("repositories");
    expect(repos).toBe("ippoan/a,ippoan/b");
  });

  it("filters invalid tokens out of an explicit r= list", async () => {
    const res = await launch(
      "?i=x/y%231&r=" + encodeURIComponent("ippoan/a, bad token ,ippoan/b"),
    );
    const repos = new URL(location(res)).searchParams.get("repositories");
    expect(repos).toBe("ippoan/a,ippoan/b");
  });

  it("400 when an explicit r= list has no valid entries", async () => {
    const res = await launch("?i=x/y%231&r=" + encodeURIComponent("a/b/c"));
    expect(res.status).toBe(400);
  });

  it("rejects repo tokens containing query metacharacters (no param injection)", async () => {
    // `x&prompt=evil/y` would, under a loose regex + raw join, inject a second
    // `prompt=` into the claude.ai/code URL. The strict REPO_RE drops it.
    const res = await launch(
      "?i=x/y%231&r=" + encodeURIComponent("x&prompt=evil/y"),
    );
    expect(res.status).toBe(400);
  });

  it("does not let a valid-looking token alter other query params", async () => {
    // A token that passes the owner/repo shape but pairs with a benign one must
    // never widen the param set beyond `repositories` + `prompt`.
    const res = await launch(
      "?i=x/y%231&r=" + encodeURIComponent("ippoan/a,ippoan/b"),
    );
    const u = new URL(location(res));
    expect([...u.searchParams.keys()].sort()).toEqual(["prompt", "repositories"]);
  });

  it("p= overrides the prompt verbatim", async () => {
    const res = await launch(
      "?i=x/y%231&p=" + encodeURIComponent("custom prompt 日本語"),
    );
    const prompt = new URL(location(res)).searchParams.get("prompt");
    expect(prompt).toBe("custom prompt 日本語");
  });
});
