/**
 * @fileoverview Unit tests for two-phase batch print confirmation.
 *
 * If any file in a batch exceeds the page-count threshold, the whole batch is
 * held and nothing prints — so a skip_confirmation retry can't double-print
 * files that would otherwise have already printed. The side-effecting render /
 * print / page-count functions are mocked; the pure gating helpers
 * (isDuplexEnabled, calculatePhysicalSheets, shouldTriggerConfirmation) stay
 * real and use the default config (confirmIfOverPages = 10).
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("../../src/utils.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils.js")>()
  return {
    ...actual,
    prepareFileForPrinting: vi.fn(async (opts: { filePath: string }) => {
      if (opts.filePath.includes("missing")) {
        throw new Error("File not found")
      }
      return { actualFilePath: opts.filePath, renderedPdf: `${opts.filePath}.rpdf`, renderType: "" }
    }),
    getPdfPageCount: vi.fn(async (p: string) => {
      if (p.endsWith(".txt")) throw new Error("not a pdf") // simulate non-PDF
      return p.includes("big") ? 40 : 3
    }),
    executePrintJob: vi.fn(async () => ({ printerName: "MockPrinter", allOptions: [] })),
    cleanupRenderedPdf: vi.fn(),
  }
})

import { handlePrintBatch } from "../../src/tools/batch-helpers.js"
import { executePrintJob, cleanupRenderedPdf } from "../../src/utils.js"

const execMock = vi.mocked(executePrintJob)
const cleanupMock = vi.mocked(cleanupRenderedPdf)

beforeEach(() => {
  execMock.mockClear()
  cleanupMock.mockClear()
})

describe("handlePrintBatch", () => {
  it("holds the whole batch and prints nothing if any file needs confirmation", async () => {
    const res = await handlePrintBatch([
      { file_path: "/docs/a-small.pdf" },
      { file_path: "/docs/b-big.pdf" },
    ])

    const text = res.content[0].text
    expect(text).toContain("Confirmation required")
    expect(text).toContain("/docs/b-big.pdf")
    expect(text).toContain("40 pages")
    // Nothing printed; both rendered temp files cleaned up.
    expect(execMock).toHaveBeenCalledTimes(0)
    expect(cleanupMock).toHaveBeenCalledTimes(2)
  })

  it("prints every file when none exceed the threshold", async () => {
    const res = await handlePrintBatch([
      { file_path: "/docs/a-small.pdf" },
      { file_path: "/docs/b-small.pdf" },
    ])

    expect(res.content[0].text).toContain("2/2 successful")
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it("prints an oversized file when skip_confirmation is set", async () => {
    const res = await handlePrintBatch([{ file_path: "/docs/b-big.pdf", skip_confirmation: true }])

    expect(res.content[0].text).toContain("1/1 successful")
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it("never gates non-PDF files", async () => {
    const res = await handlePrintBatch([{ file_path: "/docs/notes.txt" }])

    expect(res.content[0].text).toContain("1/1 successful")
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it("reports a preparation failure while still printing the rest", async () => {
    const res = await handlePrintBatch([
      { file_path: "/docs/missing.pdf" },
      { file_path: "/docs/ok-small.pdf" },
    ])

    const text = res.content[0].text
    expect(text).toContain("1/2 successful")
    expect(text).toContain("1 failed")
    expect(execMock).toHaveBeenCalledTimes(1) // only the printable file
  })
})
