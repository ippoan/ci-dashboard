import { describe, it, expect } from "vitest";
import { serviceNameFromRevision } from "../../src/release-wave/revision";

describe("serviceNameFromRevision", () => {
  it("strips the -NNNNN-suffix and returns the service name", () => {
    expect(serviceNameFromRevision("rust-alc-api-00042-abc")).toBe("rust-alc-api");
  });

  it("handles a single-token service name", () => {
    expect(serviceNameFromRevision("api-00001-x")).toBe("api");
  });

  it("trims surrounding whitespace", () => {
    expect(serviceNameFromRevision("  svc-00007-q9z  ")).toBe("svc");
  });

  it("returns null when the revision does not match the expected shape", () => {
    expect(serviceNameFromRevision("not-a-revision")).toBeNull();
    expect(serviceNameFromRevision("svc-123-abc")).toBeNull(); // 5桁でない
    expect(serviceNameFromRevision("")).toBeNull();
  });
});
