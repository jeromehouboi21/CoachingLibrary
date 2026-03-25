import * as pdfjsLib from 'pdfjs-dist'

// Vite resolves the worker file and inlines the URL at build time
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

/** Compute SHA-256 hex string of a Blob's contents */
async function hashBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Convert a PDF File into an array of PNG Blobs, one per page.
 * Each page object includes a SHA-256 hash for duplicate detection.
 * @param {File} file - The PDF file to convert
 * @param {function} onProgress - Optional callback: ({ current, total, phase })
 * @returns {Promise<{ pageCount: number, pages: Array<{ pageNumber, blob, filename, hash }> }>}
 */
export async function convertPdfToPages(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const pageCount = pdf.numPages

  const pages = []

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum)

    // scale 1.0 = native scan resolution (2480×3507 for Canon GX2000) — sufficient for OCR
    const viewport = page.getViewport({ scale: 1.0 })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')

    await page.render({ canvasContext: ctx, viewport }).promise

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const hash = await hashBlob(blob)

    pages.push({
      pageNumber: pageNum,
      blob,
      filename: `page_${String(pageNum).padStart(3, '0')}.png`,
      hash,
    })

    onProgress?.({ current: pageNum, total: pageCount, phase: 'converting' })
  }

  return { pageCount, pages }
}
