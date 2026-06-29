/**
 * @fileoverview Unit tests for temp-directory cleanup.
 *
 * Renderers create a dedicated `mkdtemp()` directory and write their PDF inside
 * it. Earlier versions only unlinked the PDF file and leaked the directory on
 * every render; these tests lock in that the whole directory is removed, and
 * that the safety guard refuses to delete anything that isn't one of our temp
 * directories.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { cleanupRenderedPdf, cleanupTempDir } from "../../src/utils.js"

const testsTmp = join(dirname(fileURLToPath(import.meta.url)), "../tmp")

describe("cleanupRenderedPdf", () => {
  it("removes the temp directory that contains the rendered PDF", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-printer-test-"))
    const pdf = join(dir, "output.pdf")
    writeFileSync(pdf, "%PDF-1.4")
    expect(existsSync(dir)).toBe(true)

    cleanupRenderedPdf(pdf)

    expect(existsSync(dir)).toBe(false)
  })

  it("is a no-op when passed null", () => {
    expect(() => cleanupRenderedPdf(null)).not.toThrow()
  })
})

describe("cleanupTempDir", () => {
  it("removes a directory with the mcp-printer- prefix inside the OS temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-printer-code-"))
    expect(existsSync(dir)).toBe(true)

    cleanupTempDir(dir)

    expect(existsSync(dir)).toBe(false)
  })

  it("refuses directories without the mcp-printer- prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "unrelated-prefix-"))
    try {
      cleanupTempDir(dir)
      expect(existsSync(dir)).toBe(true) // left untouched
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses directories outside the OS temp dir even with our prefix", () => {
    mkdirSync(testsTmp, { recursive: true })
    const outside = join(testsTmp, "mcp-printer-not-in-tmp")
    mkdirSync(outside, { recursive: true })
    try {
      cleanupTempDir(outside)
      expect(existsSync(outside)).toBe(true) // refused: not under tmpdir()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
