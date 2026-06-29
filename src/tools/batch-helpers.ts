/**
 * @fileoverview Batch operation helpers for print, page metadata, and job cancellation operations.
 * Provides interfaces, processing functions, and result formatting for batch tool operations.
 */

import { execa } from "execa"
import {
  executePrintJob,
  getPdfPageCount,
  calculatePhysicalSheets,
  shouldTriggerConfirmation,
  prepareFileForPrinting,
  isDuplexEnabled,
  cleanupRenderedPdf,
  type RenderResult,
} from "../utils.js"
import { config } from "../config.js"

/**
 * Error codes used in batch operations.
 */
export const ERROR_CODES = {
  PAGE_COUNT_CONFIRMATION_REQUIRED: "PAGE_COUNT_CONFIRMATION_REQUIRED",
} as const

/**
 * Recommended maximum batch size for operations.
 * Operations exceeding this size will trigger a user confirmation prompt.
 */
export const RECOMMENDED_BATCH_SIZE = 50

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

/**
 * Format duplex information for display.
 * @param isDuplex - Whether duplex printing is enabled
 * @returns Formatted duplex string or empty string
 */
const formatDuplexInfo = (isDuplex?: boolean) => (isDuplex ? ", duplex" : "")

/**
 * Format render type information for successful operations.
 * @param renderType - The type of rendering performed (e.g., "markdown", "code")
 * @returns Formatted render info string or empty string
 */
const formatRenderInfo = (renderType?: string) => (renderType ? ` (rendered: ${renderType})` : "")

/**
 * Format render type information for failed operations that would have rendered.
 * @param renderType - The type of rendering that would have been performed
 * @returns Formatted render info string or empty string
 */
const formatWouldRenderInfo = (renderType?: string) =>
  renderType ? ` (would render: ${renderType})` : ""

// ============================================================================
// PRINT FILE BATCH OPERATIONS
// ============================================================================

/**
 * Specification for a single file print operation in a batch.
 */
export interface FilePrintSpec {
  file_path: string
  printer?: string
  copies?: number
  options?: string
  skip_confirmation?: boolean
  line_numbers?: boolean
  color_scheme?: string
  font_size?: string
  line_spacing?: string
  force_markdown_render?: boolean
  force_code_render?: boolean
}

/**
 * Result of a print operation.
 */
export interface PrintResult {
  success: boolean
  file_path: string
  message: string
  error?: string
  renderType?: string
}

/**
 * A file that has been prepared (rendered if needed) and measured, ready either
 * to print or to be reported as needing confirmation.
 */
interface PreparedPrintJob {
  spec: FilePrintSpec
  renderResult: RenderResult
  /** True if the file's page count exceeds the confirmation threshold */
  needsConfirmation: boolean
  pdfPages?: number
  physicalSheets?: number
  isDuplex?: boolean
  /** Set if preparation (validation/rendering) failed */
  prepareError?: string
}

/**
 * Phase 1 of a batch print: render (if needed) and measure a single file WITHOUT
 * printing. A rendered PDF, if produced, is kept for the print phase and must be
 * cleaned up by the caller.
 *
 * @param spec - File print specification
 * @returns Prepared job describing render result, page metadata, and gating
 * @throws Never throws - preparation failures are captured in prepareError
 */
async function preparePrintJob(spec: FilePrintSpec): Promise<PreparedPrintJob> {
  try {
    const renderResult = await prepareFileForPrinting({
      filePath: spec.file_path,
      lineNumbers: spec.line_numbers,
      colorScheme: spec.color_scheme,
      fontSize: spec.font_size,
      lineSpacing: spec.line_spacing,
      forceMarkdownRender: spec.force_markdown_render,
      forceCodeRender: spec.force_code_render,
    })

    let needsConfirmation = false
    let pdfPages: number | undefined
    let physicalSheets: number | undefined
    let isDuplex: boolean | undefined

    if (!spec.skip_confirmation && config.confirmIfOverPages > 0) {
      try {
        pdfPages = await getPdfPageCount(renderResult.actualFilePath)
        isDuplex = isDuplexEnabled(spec.options)
        physicalSheets = calculatePhysicalSheets(pdfPages, isDuplex)
        needsConfirmation = shouldTriggerConfirmation(physicalSheets)
      } catch {
        // Not a PDF (plain text, image, etc.) — no page-count gating.
      }
    }

    return { spec, renderResult, needsConfirmation, pdfPages, physicalSheets, isDuplex }
  } catch (error) {
    return {
      spec,
      renderResult: { actualFilePath: spec.file_path, renderedPdf: null, renderType: "" },
      needsConfirmation: false,
      prepareError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Phase 2 of a batch print: send a prepared file to the printer and clean up its
 * rendered PDF.
 *
 * @param job - A prepared job with no prepareError
 * @returns PrintResult for the file
 * @throws Never throws - all errors are captured in the result object
 */
async function executePreparedJob(job: PreparedPrintJob): Promise<PrintResult> {
  const { spec, renderResult } = job
  const copies = spec.copies ?? 1
  try {
    const { printerName } = await executePrintJob(
      renderResult.actualFilePath,
      spec.printer,
      copies,
      spec.options
    )
    const copiesInfo = copies > 1 ? ` × ${copies} copies` : ""
    return {
      success: true,
      file_path: spec.file_path,
      message: `Printed to ${printerName}${copiesInfo}${formatRenderInfo(renderResult.renderType)}`,
      renderType: renderResult.renderType,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      file_path: spec.file_path,
      message: `Failed to print: ${message}`,
      error: message,
    }
  } finally {
    cleanupRenderedPdf(renderResult.renderedPdf)
  }
}

/**
 * Handle a batch print request using a two-phase flow:
 *
 * 1. Prepare and measure every file (render if needed, count pages).
 * 2. If ANY file exceeds the page-count confirmation threshold, print NOTHING
 *    and return a confirmation summary. This is what prevents a confirmation
 *    retry (with skip_confirmation) from double-printing files that would
 *    otherwise have already printed in a per-file flow.
 * 3. Otherwise print every prepared file. Preparation failures are reported as
 *    individual failures, preserving partial-success behavior.
 *
 * @param files - Files to print
 * @returns MCP response (confirmation summary or per-file print results)
 * @throws Never throws - all errors are captured in the response
 */
export async function handlePrintBatch(
  files: FilePrintSpec[]
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Phase 1: prepare + measure all files.
  const prepared: PreparedPrintJob[] = []
  for (const spec of files) {
    prepared.push(await preparePrintJob(spec))
  }

  // Confirmation gate: hold the entire batch if anything needs confirmation, so
  // a skip_confirmation retry can't double-print files that already succeeded.
  const needConfirm = prepared.filter((job) => job.needsConfirmation)
  if (needConfirm.length > 0) {
    // Nothing prints on this call — clean up every rendered temp file.
    for (const job of prepared) {
      cleanupRenderedPdf(job.renderResult.renderedPdf)
    }
    return formatBatchConfirmation(needConfirm)
  }

  // Phase 2: print everything (preparation failures become per-file failures).
  const results: PrintResult[] = []
  for (const job of prepared) {
    if (job.prepareError) {
      results.push({
        success: false,
        file_path: job.spec.file_path,
        message: `Failed to print: ${job.prepareError}`,
        error: job.prepareError,
      })
    } else {
      results.push(await executePreparedJob(job))
    }
  }

  return formatPrintResults(results)
}

/**
 * Format a batch confirmation response listing the files that exceed the page
 * threshold. Nothing has been printed; the AI should re-issue the print with
 * skip_confirmation: true for the files the user approves.
 *
 * @param jobs - Prepared jobs that need confirmation
 * @returns MCP response object with the confirmation summary
 */
function formatBatchConfirmation(jobs: PreparedPrintJob[]): {
  content: Array<{ type: "text"; text: string }>
} {
  const lines = jobs.map((job) => {
    const sheets =
      job.physicalSheets !== undefined
        ? ` (${job.physicalSheets} sheets${formatDuplexInfo(job.isDuplex)})`
        : ""
    return `  • ${job.spec.file_path} — ${job.pdfPages} pages${sheets}${formatRenderInfo(job.renderResult.renderType)}`
  })

  const text =
    `⚠️  Confirmation required — nothing was printed.\n\n` +
    `${jobs.length} file(s) exceed the page threshold ` +
    `(MCP_PRINTER_CONFIRM_IF_OVER_PAGES=${config.confirmIfOverPages}):\n` +
    `${lines.join("\n")}\n\n` +
    `Ask the user to confirm, then retry with skip_confirmation: true for the file(s) to print.`

  return { content: [{ type: "text", text }] }
}

/**
 * Format print results into a readable MCP response.
 *
 * Creates a summary showing success/failure counts and detailed results for each file.
 * Distinguishes between regular errors and confirmation-required errors in the output.
 *
 * @param results - Array of print results from batch operation
 * @returns MCP response object with formatted text content
 *
 * @remarks
 * - Successful prints show checkmark (✓) with printer name and options
 * - Failed prints show cross (✗) with error details
 * - Confirmation-required errors are shown without full error stack
 */
export function formatPrintResults(results: PrintResult[]): {
  content: Array<{ type: "text"; text: string }>
} {
  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  let text = `Print Results: ${successful.length}/${results.length} successful`
  if (failed.length > 0) {
    text += `, ${failed.length} failed`
  }
  text += "\n\n"

  // Show successful prints
  for (const result of successful) {
    text += `✓ ${result.file_path}\n  ${result.message}\n\n`
  }

  // Show failed prints
  for (const result of failed) {
    text += `✗ ${result.file_path}${formatWouldRenderInfo(result.renderType)}\n  ${result.message}`
    if (result.error && result.error !== ERROR_CODES.PAGE_COUNT_CONFIRMATION_REQUIRED) {
      text += `: ${result.error}`
    }
    text += "\n\n"
  }

  return {
    content: [
      {
        type: "text",
        text: text.trim(),
      },
    ],
  }
}

// ============================================================================
// PAGE METADATA BATCH OPERATIONS
// ============================================================================

/**
 * Specification for a single file page metadata operation in a batch.
 */
export interface FilePageMetaSpec {
  file_path: string
  options?: string
  line_numbers?: boolean
  color_scheme?: string
  font_size?: string
  line_spacing?: string
  force_markdown_render?: boolean
  force_code_render?: boolean
}

/**
 * Result of a page metadata operation.
 */
export interface PageMetaResult {
  success: boolean
  file_path: string
  pages?: number
  sheets?: number
  duplex?: boolean
  renderType?: string
  error?: string
}

/**
 * Handle a file page metadata operation within a batch.
 *
 * This function:
 * - Prepares the file for printing (renders if needed)
 * - Extracts page count from the PDF
 * - Calculates physical sheets based on duplex settings
 * - Cleans up temporary files
 *
 * @param spec - File page metadata specification including path and rendering options
 * @returns PageMetaResult object with success status and page/sheet counts or error details
 * @throws Never throws - all errors are captured in the result object
 *
 * @remarks
 * - Only works for PDF files (including auto-rendered markdown/code files)
 * - Non-PDF files (plain text, images) will return success=false with error message
 * - Temporary rendered PDFs are automatically cleaned up in finally block
 * - Page count is the total number of pages in the PDF
 * - Sheets is the physical paper count (pages/2 for duplex)
 */
export async function handlePageMeta(spec: FilePageMetaSpec): Promise<PageMetaResult> {
  const {
    file_path,
    options,
    line_numbers,
    color_scheme,
    font_size,
    line_spacing,
    force_markdown_render,
    force_code_render,
  } = spec

  try {
    // Use shared rendering function
    const { actualFilePath, renderedPdf, renderType } = await prepareFileForPrinting({
      filePath: file_path,
      lineNumbers: line_numbers,
      colorScheme: color_scheme,
      fontSize: font_size,
      lineSpacing: line_spacing,
      forceMarkdownRender: force_markdown_render,
      forceCodeRender: force_code_render,
    })

    try {
      // Get page count from the file
      const pdfPages = await getPdfPageCount(actualFilePath)
      const isDuplex = isDuplexEnabled(options)
      const physicalSheets = calculatePhysicalSheets(pdfPages, isDuplex)

      return {
        success: true,
        file_path,
        pages: pdfPages,
        sheets: physicalSheets,
        duplex: isDuplex,
        renderType,
      }
    } finally {
      // Clean up rendered PDF if it was created
      cleanupRenderedPdf(renderedPdf)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      file_path,
      error: `Failed to get page metadata: ${message}`,
    }
  }
}

/**
 * Format page metadata results into a readable MCP response.
 *
 * Creates a summary showing success/failure counts and detailed metadata for each file.
 *
 * @param results - Array of page metadata results from batch operation
 * @returns MCP response object with formatted text content
 *
 * @remarks
 * - Successful results show checkmark (✓) with page count, sheet count, and duplex status
 * - Failed results show cross (✗) with error details
 * - Render type is shown for files that were auto-rendered (markdown, code)
 */
export function formatPageMetaResults(results: PageMetaResult[]): {
  content: Array<{ type: "text"; text: string }>
} {
  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  let text = `Page Metadata Results: ${successful.length}/${results.length} successful`
  if (failed.length > 0) {
    text += `, ${failed.length} failed`
  }
  text += "\n\n"

  // Show successful metadata
  for (const result of successful) {
    text += `✓ ${result.file_path}\n  ${result.pages} pages (${result.sheets} sheets${formatDuplexInfo(result.duplex)})${formatRenderInfo(result.renderType)}\n\n`
  }

  // Show failed metadata
  for (const result of failed) {
    text += `✗ ${result.file_path}\n  ${result.error}\n\n`
  }

  return {
    content: [
      {
        type: "text",
        text: text.trim(),
      },
    ],
  }
}

// ============================================================================
// JOB CANCELLATION BATCH OPERATIONS
// ============================================================================

/**
 * Specification for a single job cancellation operation in a batch.
 */
export interface JobCancelSpec {
  job_id?: string
  printer?: string
  cancel_all?: boolean
}

/**
 * Result of a job cancellation operation.
 */
export interface CancelJobResult {
  success: boolean
  message: string
  error?: string
}

/**
 * Handle a job cancellation operation within a batch.
 *
 * This function handles cancellation of either:
 * - A specific print job by job ID
 * - All jobs for a specific printer
 *
 * @param spec - Job cancellation specification with job_id or printer+cancel_all
 * @returns CancelJobResult object with success status and message or error details
 * @throws Never throws - all errors are captured in the result object
 *
 * @remarks
 * - Requires either job_id OR (printer + cancel_all=true)
 * - Invalid parameters return success=false with error message
 * - Uses lprm command for cancellation
 */
export async function handleCancel(spec: JobCancelSpec): Promise<CancelJobResult> {
  const { job_id, printer, cancel_all = false } = spec

  // Determine the action description for consistent messaging
  const actionDescription = cancel_all ? `all jobs for printer: ${printer}` : `job: ${job_id}`

  try {
    const lprmArgs: string[] = []

    if (cancel_all && printer) {
      lprmArgs.push("-P", printer, "-")
    } else if (job_id) {
      if (printer) {
        lprmArgs.push("-P", printer)
      }
      lprmArgs.push(job_id)
    } else {
      return {
        success: false,
        message: "Invalid parameters",
        error: "Must provide either job_id or set cancel_all=true with printer",
      }
    }

    await execa("lprm", lprmArgs)

    return {
      success: true,
      message: `Cancelled ${actionDescription}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      message: `Failed to cancel ${actionDescription}`,
      error: message,
    }
  }
}

/**
 * Format job cancellation results into a readable MCP response.
 *
 * Creates a summary showing success/failure counts and details for each cancellation.
 *
 * @param results - Array of cancellation results from batch operation
 * @returns MCP response object with formatted text content
 *
 * @remarks
 * - Successful cancellations show checkmark (✓) with job ID or printer name
 * - Failed cancellations show cross (✗) with error details
 */
export function formatCancelResults(results: CancelJobResult[]): {
  content: Array<{ type: "text"; text: string }>
} {
  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  let text = `Cancel Results: ${successful.length}/${results.length} successful`
  if (failed.length > 0) {
    text += `, ${failed.length} failed`
  }
  text += "\n\n"

  // Show successful cancellations
  for (const result of successful) {
    text += `✓ ${result.message}\n\n`
  }

  // Show failed cancellations
  for (const result of failed) {
    text += `✗ ${result.message}`
    if (result.error) {
      text += `: ${result.error}`
    }
    text += "\n\n"
  }

  return {
    content: [
      {
        type: "text",
        text: text.trim(),
      },
    ],
  }
}

// ============================================================================
// SHARED BATCH UTILITIES
// ============================================================================

/**
 * Check if a batch size exceeds the recommended limit and return a warning if needed.
 *
 * @param itemCount - Number of items in the batch
 * @param itemType - Type of items (e.g., "files", "jobs") for the warning message
 * @param limit - Optional batch size limit (defaults to RECOMMENDED_BATCH_SIZE)
 * @returns MCP response object with warning, or null if within limit
 *
 * @remarks
 * - Default limit is 50 items
 * - Returns a user-friendly warning message suggesting to split the batch
 * - AI can use this to ask the user before proceeding
 * - Optional limit parameter allows for testing with different thresholds
 */
export function checkBatchSizeLimit(
  itemCount: number,
  itemType: string,
  limit: number = RECOMMENDED_BATCH_SIZE
): { content: Array<{ type: "text"; text: string }> } | null {
  if (itemCount > limit) {
    return {
      content: [
        {
          type: "text",
          text:
            `⚠️  Large batch detected: ${itemCount} ${itemType}\n\n` +
            `For better reliability, consider splitting into batches of ${limit} ${itemType}.\n` +
            `The AI can make multiple tool calls to process all items.\n\n` +
            `Ask the user if they want to proceed with the full batch or split it into smaller batches.`,
        },
      ],
    }
  }
  return null
}
