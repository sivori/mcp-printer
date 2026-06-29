/**
 * @fileoverview Unit tests for highlight.js color-scheme loading.
 *
 * Covers two fixes:
 *  - Styles are located via require.resolve so they work regardless of install
 *    layout (npm hoist, pnpm symlink store, monorepo).
 *  - The user-supplied scheme name cannot escape the styles directory via "../"
 *    path traversal, while legitimate subdirectory themes (base16/*) still work.
 */

import { describe, it, expect } from "vitest"
import { createRequire } from "module"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { dirname, join, relative } from "path"
import { fileURLToPath } from "url"
import { loadColorSchemeCSS } from "../../src/renderers/code.js"

const require = createRequire(import.meta.url)
const stylesDir = join(dirname(require.resolve("highlight.js/package.json")), "styles")
const testsTmp = join(dirname(fileURLToPath(import.meta.url)), "../tmp")

describe("loadColorSchemeCSS", () => {
  it("loads a real highlight.js theme (resolves the styles dir by package)", () => {
    const css = loadColorSchemeCSS("atom-one-light")
    expect(css).toContain(".hljs")
  })

  it("supports subdirectory themes like base16/*", () => {
    const css = loadColorSchemeCSS("base16/apathy")
    expect(css).toContain(".hljs")
  })

  it("falls back to a valid theme for an unknown scheme name", () => {
    const css = loadColorSchemeCSS("__definitely_not_a_theme__")
    expect(css).toContain(".hljs")
  })

  it("blocks path traversal to a .css file outside the styles directory", () => {
    mkdirSync(testsTmp, { recursive: true })
    const sentinel = join(testsTmp, "pwned.css")
    writeFileSync(sentinel, ".PWNED_SENTINEL { color: red }")
    try {
      // Relative path that, without the containment guard, would resolve to
      // tests/tmp/pwned.css and leak its contents into the rendered output.
      const traversal = relative(stylesDir, join(testsTmp, "pwned"))
      const css = loadColorSchemeCSS(traversal)
      expect(css).not.toContain("PWNED_SENTINEL")
      expect(css).toContain(".hljs") // fell back to the default theme
    } finally {
      rmSync(sentinel, { force: true })
    }
  })
})
