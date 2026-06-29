/**
 * @fileoverview Unit tests for configuration parsing
 */

import { describe, it, expect, vi } from "vitest"
import { homedir } from "os"
import { join } from "path"
import { config, MARKDOWN_EXTENSIONS, parseIntConfig } from "../../src/config.js"

describe("config", () => {
  it("should have markdown extensions defined", () => {
    expect(MARKDOWN_EXTENSIONS).toEqual(["md", "markdown"])
  })

  it("should have string configs loaded", () => {
    // Test that config has the expected string properties
    expect(typeof config.defaultPrinter).toBe("string")
    expect(typeof config.chromePath).toBe("string")
  })

  it("should have boolean configs", () => {
    // Test that config has boolean properties with valid values
    expect(typeof config.autoDuplex).toBe("boolean")
    expect(typeof config.enableManagement).toBe("boolean")
    expect(typeof config.enablePrompts).toBe("boolean")
    expect(typeof config.fallbackOnRenderError).toBe("boolean")
    expect(typeof config.autoRenderMarkdown).toBe("boolean")
    expect(typeof config.autoRenderCode).toBe("boolean")
  })

  it("should have array configs", () => {
    // Test that array configs are actually arrays
    expect(Array.isArray(config.defaultOptions)).toBe(true)
    expect(Array.isArray(config.allowedPaths)).toBe(true)
    expect(Array.isArray(config.deniedPaths)).toBe(true)
    expect(Array.isArray(config.code.excludeExtensions)).toBe(true)
  })

  it("should include default allowed directories in allowedPaths by default", () => {
    // If user hasn't set custom paths, should contain default directories
    const homeDir = homedir()
    const defaultDirs = [
      join(homeDir, "Documents"),
      join(homeDir, "Downloads"),
      join(homeDir, "Desktop"),
    ]

    // Check if any default directory is in allowedPaths (depends on whether user set custom paths)
    // If MCP_PRINTER_ALLOWED_PATHS is not set, defaults should be present
    if (!process.env.MCP_PRINTER_ALLOWED_PATHS) {
      expect(defaultDirs.some((dir) => config.allowedPaths.includes(dir))).toBe(true)
    }
  })

  it("should include default denied paths", () => {
    const homeDir = homedir()
    // Default denied paths should always be present (merged with user paths)
    const sshPath = join(homeDir, ".ssh")
    expect(config.deniedPaths.includes(sshPath) || config.deniedPaths.includes("/etc")).toBe(true)
  })

  it("should have numeric maxCopies config", () => {
    expect(typeof config.maxCopies).toBe("number")
    expect(config.maxCopies).toBeGreaterThanOrEqual(0)
  })

  it("should have numeric confirmIfOverPages config", () => {
    expect(typeof config.confirmIfOverPages).toBe("number")
    expect(config.confirmIfOverPages).toBeGreaterThanOrEqual(0)
  })

  it("should have code rendering configs", () => {
    expect(typeof config.code.colorScheme).toBe("string")
    expect(typeof config.code.autoLineNumbers).toBe("boolean")
    expect(typeof config.code.fontSize).toBe("string")
    expect(typeof config.code.lineSpacing).toBe("string")
  })

  it("should have valid code color scheme", () => {
    // Should be a non-empty string
    expect(config.code.colorScheme.length).toBeGreaterThan(0)
  })

  it("should have valid code font size format", () => {
    // Should end with 'pt' or be a valid CSS font size
    expect(config.code.fontSize).toMatch(/^\d+(\.\d+)?(pt|px|em|rem)$/)
  })

  it("should have valid code line spacing format", () => {
    // Should be a number (possibly with decimal)
    expect(config.code.lineSpacing).toMatch(/^\d+(\.\d+)?$/)
  })

  it("should not include entire home directory in allowedPaths by default", () => {
    const homeDir = homedir()
    // Should NOT contain the home directory itself (only subdirectories)
    if (!process.env.MCP_PRINTER_ALLOWED_PATHS) {
      expect(config.allowedPaths).not.toContain(homeDir)
    }
  })
})

describe("parseIntConfig", () => {
  it("returns the default when the value is undefined", () => {
    expect(parseIntConfig(undefined, 10, "X")).toBe(10)
  })

  it("returns the default when the value is empty or whitespace", () => {
    expect(parseIntConfig("", 10, "X")).toBe(10)
    expect(parseIntConfig("   ", 10, "X")).toBe(10)
  })

  it("parses a valid integer", () => {
    expect(parseIntConfig("25", 10, "X")).toBe(25)
  })

  it("preserves 0 and negative values (sentinels for unlimited/disabled)", () => {
    expect(parseIntConfig("0", 10, "X")).toBe(0)
    expect(parseIntConfig("-1", 10, "X")).toBe(-1)
  })

  it("falls back to the default and warns on a non-numeric value", () => {
    // Without this guard, a typo like "ten" → NaN, and since every downstream
    // limit check is `value > 0`, the limit would silently disable itself.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(parseIntConfig("ten", 10, "MCP_PRINTER_MAX_COPIES")).toBe(10)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
