import { describe, expect, it } from "vitest";
import { checkScope } from "./scope-checker.js";

describe("scope checker", () => {
  it("exact paths match themselves only", () => {
    expect(checkScope(["src/a.ts"], ["src/a.ts"]).inScope).toBe(true);
    expect(checkScope(["src/b.ts"], ["src/a.ts"]).outside).toEqual(["src/b.ts"]);
  });

  it("* stays within a segment", () => {
    expect(checkScope(["src/user.service.ts"], ["src/*.service.ts"]).inScope).toBe(true);
    expect(checkScope(["src/deep/user.service.ts"], ["src/*.service.ts"]).inScope).toBe(false);
  });

  it("** spans segments, including zero", () => {
    const surface = ["src/features/auth/**"];
    expect(checkScope(["src/features/auth/login.ts"], surface).inScope).toBe(true);
    expect(checkScope(["src/features/auth/deep/nested/x.ts"], surface).inScope).toBe(true);
    expect(checkScope(["src/features/billing/x.ts"], surface).inScope).toBe(false);
  });

  it("'a/**/b' matches both 'a/b' and 'a/x/b'", () => {
    expect(checkScope(["a/b"], ["a/**/b"]).inScope).toBe(true);
    expect(checkScope(["a/x/y/b"], ["a/**/b"]).inScope).toBe(true);
  });

  it("dotfiles and regex metacharacters are literal", () => {
    expect(checkScope([".env.example"], [".env.example"]).inScope).toBe(true);
    expect(checkScope([".envXexample"], [".env.example"]).inScope).toBe(false);
  });

  it("path normalization: ./ prefixes and backslashes", () => {
    expect(checkScope(["./src/a.ts"], ["src/a.ts"]).inScope).toBe(true);
    expect(checkScope(["src\\a.ts"], ["src/a.ts"]).inScope).toBe(true);
  });

  it("the security case: secrets are outside any src surface", () => {
    const v = checkScope(["src/ok.ts", ".env", "secrets/prod.pem"], ["src/**"]);
    expect(v.inScope).toBe(false);
    expect(v.outside).toEqual([".env", "secrets/prod.pem"]);
  });
});
