import { describe, it, expect } from "vitest";
import { parseTaglessRepos } from "../src/tagless-repos";

describe("parseTaglessRepos", () => {
  it("returns an empty set when input is undefined", () => {
    expect(parseTaglessRepos(undefined).size).toBe(0);
  });

  it("returns an empty set for an empty / whitespace-only string", () => {
    expect(parseTaglessRepos("").size).toBe(0);
    expect(parseTaglessRepos("   ").size).toBe(0);
    expect(parseTaglessRepos(",  ,").size).toBe(0);
  });

  it("parses comma-separated repos and trims whitespace", () => {
    const set = parseTaglessRepos("ippoan/foo, ippoan/bar ,ohishi-exp/baz");
    expect(set.has("ippoan/foo")).toBe(true);
    expect(set.has("ippoan/bar")).toBe(true);
    expect(set.has("ohishi-exp/baz")).toBe(true);
    expect(set.size).toBe(3);
  });

  it("dedupes repeated repos", () => {
    const set = parseTaglessRepos("ippoan/foo,ippoan/foo,ippoan/foo");
    expect(set.size).toBe(1);
  });
});
