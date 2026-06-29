/**
 * @fileoverview Unit tests for the render-size cap (MCP_PRINTER_MAX_RENDER_BYTES).
 *
 * Rendering reads the whole file and builds an HTML document for Chrome, so an
 * unbounded input is a slow/memory-heavy footgun. assertRenderableSize enforces
 * the configured cap; 0 disables it.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { maxRenderBytes: 0 },
}))

vi.mock("../../src/config.js", () => ({
  config: mockConfig,
  MARKDOWN_EXTENSIONS: ["md", "markdown"],
}))

import { assertRenderableSize } from "../../src/utils.js"

const dir = mkdtempSync(join(tmpdir(), "mcp-printer-size-"))
const file = join(dir, "sample.txt")
writeFileSync(file, "x".repeat(1000)) // 1000 bytes

beforeEach(() => {
  mockConfig.maxRenderBytes = 0
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("assertRenderableSize", () => {
  it("does not throw when the cap is disabled (0)", () => {
    mockConfig.maxRenderBytes = 0
    expect(() => assertRenderableSize(file)).not.toThrow()
  })

  it("does not throw when the file is within the cap", () => {
    mockConfig.maxRenderBytes = 2000
    expect(() => assertRenderableSize(file)).not.toThrow()
  })

  it("throws when the file exceeds the cap", () => {
    mockConfig.maxRenderBytes = 500
    expect(() => assertRenderableSize(file)).toThrow(/too large to render/)
  })
})
