import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deltaE, findColors, isNeutral, normalizeHex } from "./color.js";
import { extractFromSource } from "./source-extractor.js";

describe("color normalization", () => {
  it("canonicalizes short hex, long hex, and alpha forms", () => {
    expect(normalizeHex("#FFF")).toEqual({ hex: "#ffffff", alpha: 1 });
    expect(normalizeHex("#6609BE")).toEqual({ hex: "#6609be", alpha: 1 });
    expect(normalizeHex("#6609be80")?.alpha).toBeCloseTo(0.5, 1);
  });

  it("parses rgb() and hsl() into canonical hex", () => {
    const hits = findColors("color: rgb(102, 9, 190); border: hsl(270, 91%, 39%)");
    expect(hits[0]?.color.hex).toBe("#6609be");
    // hsl(270,91%,39%) ≈ #6009be-ish; must land within a tight perceptual distance
    expect(deltaE(hits[1]?.color.hex ?? "#000000", "#6609be")).toBeLessThan(5);
  });

  it("ignores nonsense like #gggggg and out-of-range rgb", () => {
    expect(findColors("rgb(300,0,0) #zzz").length).toBe(0);
  });

  it("perceptual distance: navy vs purple are far; two near-identical purples are close", () => {
    expect(deltaE("#010043", "#6609be")).toBeGreaterThan(20);
    expect(deltaE("#6609be", "#6a0bc1")).toBeLessThan(5);
  });

  it("neutral detection exempts greys, keeps brand colors", () => {
    expect(isNeutral("#f5f5f5")).toBe(true);
    expect(isNeutral("#333333")).toBe(true);
    expect(isNeutral("#6609be")).toBe(false);
    expect(isNeutral("#c8a05c")).toBe(false);
  });
});

describe("source extractor (fixture repo)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "signet-learner-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "public"), { recursive: true });
    await mkdir(join(root, "node_modules", "junk"), { recursive: true });

    await writeFile(
      join(root, "src", "globals.css"),
      `:root {
  --brand: #6609be;
  --grey-500: #6b7280;
  --spacing-lg: 24px;
}
.button { background: var(--brand); }
.legacy { color: #010043; border-color: #c8a05c; }
`,
    );
    await writeFile(
      join(root, "src", "Card.tsx"),
      `export const Card = () => <div style={{ background: "#6609be", boxShadow: "0 0 4px rgba(1, 0, 67, 0.5)" }} />;\n`,
    );
    await writeFile(
      join(root, "public", "logo.svg"),
      `<svg><path fill="#010043"/><path fill="#C8A05C"/></svg>`,
    );
    await writeFile(join(root, "public", "logo-new.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(
      join(root, "src", "Header.tsx"),
      `import Image from "next/image";\nexport const H = () => <Image src="/logo-new.png" alt="logo" />;\n`,
    );
    // junk that must be ignored
    await writeFile(join(root, "node_modules", "junk", "x.css"), `.x { color: #123456; }`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("extracts colors with file:line evidence, skipping node_modules", async () => {
    const ex = await extractFromSource(root);
    const hexes = ex.colors.map((c) => c.hex);
    expect(hexes).toContain("#6609be");
    expect(hexes).toContain("#010043");
    expect(hexes).toContain("#c8a05c");
    expect(hexes).not.toContain("#123456"); // node_modules excluded
    const legacy = ex.colors.find((c) => c.hex === "#010043" && c.context === "css");
    expect(legacy?.file).toBe("src/globals.css");
    expect(legacy?.line).toBe(7);
  });

  it("captures declared custom-property tokens with resolved hex", async () => {
    const ex = await extractFromSource(root);
    const brand = ex.declaredTokens.find((t) => t.name === "--brand");
    expect(brand?.resolvedHex).toBe("#6609be");
    const spacing = ex.declaredTokens.find((t) => t.name === "--spacing-lg");
    expect(spacing?.value).toBe("24px");
    expect(spacing?.resolvedHex).toBeNull();
  });

  it("inventories assets with reference counts and svg palettes", async () => {
    const ex = await extractFromSource(root);
    const logoSvg = ex.assets.find((a) => a.file === "public/logo.svg");
    const logoNew = ex.assets.find((a) => a.file === "public/logo-new.png");
    expect(logoSvg?.paletteHexes.sort()).toEqual(["#010043", "#c8a05c"]);
    expect(logoSvg?.references).toBe(0); // orphaned — nothing imports it
    expect(logoNew?.references).toBeGreaterThan(0); // Header uses it
  });

  it("rgba inside code is captured with its alpha", async () => {
    const ex = await extractFromSource(root);
    const shadow = ex.colors.find((c) => c.hex === "#010043" && c.context === "code");
    expect(shadow?.alpha).toBeCloseTo(0.5, 1);
  });
});
