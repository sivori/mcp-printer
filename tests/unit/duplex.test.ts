/**
 * @fileoverview Unit tests for print-option merging and duplex resolution.
 *
 * isDuplexEnabled is used for sheet-count previews / confirmation. It must agree
 * with what executePrintJob actually sends to CUPS, including last-wins for
 * repeated `sides=` options (e.g. auto-duplex overridden by `sides=one-sided`).
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// vi.mock is hoisted above normal declarations, so the mutable config object it
// references must be created via vi.hoisted to exist when the factory runs.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { autoDuplex: false, defaultOptions: [] as string[] },
}))

vi.mock("../../src/config.js", () => ({
  config: mockConfig,
  MARKDOWN_EXTENSIONS: ["md", "markdown"],
}))

import { buildPrintOptions, isDuplexEnabled } from "../../src/utils.js"

beforeEach(() => {
  mockConfig.autoDuplex = false
  mockConfig.defaultOptions = []
})

describe("buildPrintOptions", () => {
  it("passes user options through when nothing else is configured", () => {
    expect(buildPrintOptions("landscape")).toEqual(["landscape"])
    expect(buildPrintOptions(undefined)).toEqual([])
  })

  it("injects auto-duplex only when the user did not specify sides=", () => {
    mockConfig.autoDuplex = true
    expect(buildPrintOptions(undefined)).toEqual(["sides=two-sided-long-edge"])
    expect(buildPrintOptions("landscape")).toEqual(["sides=two-sided-long-edge", "landscape"])
    expect(buildPrintOptions("sides=one-sided")).toEqual(["sides=one-sided"])
  })

  it("orders defaults before user options so user options win (last-wins)", () => {
    mockConfig.defaultOptions = ["media=A4"]
    expect(buildPrintOptions("landscape")).toEqual(["media=A4", "landscape"])
  })
})

describe("isDuplexEnabled", () => {
  it("is false with no auto-duplex and no options", () => {
    expect(isDuplexEnabled(undefined)).toBe(false)
    expect(isDuplexEnabled("landscape")).toBe(false)
  })

  it("is true when the user requests any two-sided mode", () => {
    expect(isDuplexEnabled("sides=two-sided-long-edge")).toBe(true)
    expect(isDuplexEnabled("sides=two-sided-short-edge")).toBe(true)
  })

  it("is true when auto-duplex is enabled and not overridden", () => {
    mockConfig.autoDuplex = true
    expect(isDuplexEnabled(undefined)).toBe(true)
  })

  it("respects sides=one-sided override even when auto-duplex is on (regression)", () => {
    mockConfig.autoDuplex = true
    expect(isDuplexEnabled("sides=one-sided")).toBe(false)
  })

  it("uses last-wins when default options conflict with user options", () => {
    mockConfig.defaultOptions = ["sides=two-sided-long-edge"]
    expect(isDuplexEnabled("sides=one-sided")).toBe(false)
    expect(isDuplexEnabled(undefined)).toBe(true)
  })
})
