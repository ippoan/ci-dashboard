import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  parseInstallationsMap,
  installationIdForOrg,
  importAppPrivateKey,
  signAppJWT,
  getInstallationToken,
  type GitHubAppEnv,
} from "../src/github-app-auth";

// Generate a fresh PKCS#8 RSA key once per file so signAppJWT has something
// real to sign with. Web Crypto's PKCS#8 export is the exact format the
// production code parses, so this also covers the import path end-to-end.
let TEST_PRIVATE_KEY_PEM = "";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----`;
});

function appEnv(overrides: Partial<GitHubAppEnv> = {}): GitHubAppEnv {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    GITHUB_APP_INSTALLATIONS: JSON.stringify({
      "ippoan": 111,
      "ohishi-exp": 222,
      "yhonda-ohishi": 333,
    }),
    CI_STATUS: env.CI_STATUS,
    ...overrides,
  };
}

describe("parseInstallationsMap()", () => {
  it("parses a valid org→id map", () => {
    const map = parseInstallationsMap('{"ippoan": 111, "ohishi-exp": 222}');
    expect(map).toEqual({ "ippoan": 111, "ohishi-exp": 222 });
  });

  it("throws clearly on invalid JSON", () => {
    expect(() => parseInstallationsMap("not json")).toThrow(/not valid JSON/);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseInstallationsMap("[1, 2]")).toThrow(/must be a JSON object/);
    expect(() => parseInstallationsMap("42")).toThrow(/must be a JSON object/);
    expect(() => parseInstallationsMap("null")).toThrow(/must be a JSON object/);
  });

  it("rejects non-integer or non-positive values (catches a common config typo)", () => {
    expect(() => parseInstallationsMap('{"ippoan": "111"}')).toThrow(/positive integer/);
    expect(() => parseInstallationsMap('{"ippoan": 0}')).toThrow(/positive integer/);
    expect(() => parseInstallationsMap('{"ippoan": -1}')).toThrow(/positive integer/);
    expect(() => parseInstallationsMap('{"ippoan": 1.5}')).toThrow(/positive integer/);
  });
});

describe("installationIdForOrg()", () => {
  it("returns the configured installation id", () => {
    expect(installationIdForOrg(appEnv(), "ippoan")).toBe(111);
    expect(installationIdForOrg(appEnv(), "yhonda-ohishi")).toBe(333);
  });

  it("throws with a helpful message when the org is missing", () => {
    expect(() => installationIdForOrg(appEnv(), "unknown-org"))
      .toThrow(/No GitHub App installation.*unknown-org.*Configured orgs.*ippoan/);
  });
});

describe("importAppPrivateKey()", () => {
  it("imports a valid PKCS#8 PEM", async () => {
    const key = await importAppPrivateKey(TEST_PRIVATE_KEY_PEM);
    expect(key.type).toBe("private");
    expect(key.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
  });

  it("strips legacy `RSA PRIVATE KEY` headers as well", async () => {
    // We just need the body to be valid base64 PKCS#8 — the header text is
    // stripped uniformly. Substituting the header label tests the regex.
    const legacy = TEST_PRIVATE_KEY_PEM
      .replace("BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY")
      .replace("END PRIVATE KEY", "END RSA PRIVATE KEY");
    const key = await importAppPrivateKey(legacy);
    expect(key.type).toBe("private");
  });

  it("throws on empty input", async () => {
    await expect(importAppPrivateKey("")).rejects.toThrow(/empty or missing PEM/);
    await expect(importAppPrivateKey("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"))
      .rejects.toThrow(/empty or missing PEM/);
  });
});

describe("signAppJWT()", () => {
  it("produces a 3-segment RS256 JWT", async () => {
    const jwt = await signAppJWT("123456", TEST_PRIVATE_KEY_PEM, 1_700_000_000);
    const segs = jwt.split(".");
    expect(segs).toHaveLength(3);
    // Decode header — JSON base64url
    const header = JSON.parse(atob(segs[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(atob(segs[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(1_700_000_000 - 60);
    expect(payload.exp).toBe(1_700_000_000 + 600);
  });

  it("backdates iat by 60s (clock-skew guard)", async () => {
    const now = 1_800_000_000;
    const jwt = await signAppJWT("1", TEST_PRIVATE_KEY_PEM, now);
    const payload = JSON.parse(
      atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(payload.iat).toBe(now - 60);
    // 10 min expiry, GitHub's hard max
    expect(payload.exp - payload.iat).toBe(660);
  });
});

describe("getInstallationToken()", () => {
  beforeEach(async () => {
    // Clean the per-installation cache before each test so we observe the
    // intended cache hit / miss behavior.
    for (const id of [111, 222, 333]) {
      await env.CI_STATUS.delete(`gh-app:token:${id}`);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("exchanges the JWT for an installation token and caches it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        token: "ghs_abc123",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );

    const token = await getInstallationToken(appEnv(), "ippoan");
    expect(token).toBe("ghs_abc123");

    // Was hit with the correct installation id and Authorization: Bearer <JWT>.
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://api.github.com/app/installations/111/access_tokens");
    expect(init.method).toBe("POST");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer eyJ/); // RS256 JWT header starts "eyJ"

    // Second call within the cache window must not re-hit the network.
    const token2 = await getInstallationToken(appEnv(), "ippoan");
    expect(token2).toBe("ghs_abc123");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-mints the token when the cached entry is within the 60s refresh window", async () => {
    // Seed a token that's about to expire (45s from now). The threshold is
    // 60s, so getInstallationToken must treat this as expired and re-fetch.
    await env.CI_STATUS.put("gh-app:token:111", JSON.stringify({
      token: "expiring-soon",
      expires_at_ms: Date.now() + 45_000,
    }));
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        token: "ghs_fresh",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );

    const token = await getInstallationToken(appEnv(), "ippoan");
    expect(token).toBe("ghs_fresh");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses the cached token when it has > 60s left", async () => {
    await env.CI_STATUS.put("gh-app:token:111", JSON.stringify({
      token: "still-fresh",
      expires_at_ms: Date.now() + 5 * 60_000,
    }));
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ token: "should-not-be-used", expires_at: new Date().toISOString() }),
    );

    const token = await getInstallationToken(appEnv(), "ippoan");
    expect(token).toBe("still-fresh");
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves per-org: ippoan and ohishi-exp get different tokens from different installations", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      if (url.endsWith("/installations/111/access_tokens")) {
        return Response.json({
          token: "ghs_ippoan",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url.endsWith("/installations/222/access_tokens")) {
        return Response.json({
          token: "ghs_ohishi",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const e = appEnv();
    expect(await getInstallationToken(e, "ippoan")).toBe("ghs_ippoan");
    expect(await getInstallationToken(e, "ohishi-exp")).toBe("ghs_ohishi");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces GitHub error responses verbosely (so 401/403 misconfig is debuggable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"message":"Bad credentials"}', { status: 401 }),
    );
    await expect(getInstallationToken(appEnv(), "ippoan"))
      .rejects.toThrow(/installation token exchange failed \(401\) for installation 111.*Bad credentials/);
  });

  it("throws clearly when the org is not in the installations map", async () => {
    await expect(getInstallationToken(appEnv(), "evil-org"))
      .rejects.toThrow(/No GitHub App installation configured.*evil-org/);
  });
});
