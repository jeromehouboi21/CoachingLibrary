import * as pdfjsLib from 'pdfjs-dist'

// Vite resolves the worker file and inlines the URL at build time
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

/**
 * Convert a PDF File into an array of PNG Blobs, one per page.
 * @param {File} file - The PDF file to convert
 * @param {function} onProgress - Optional callback: ({ current, total, phase })
 * @returns {Promise<{ pageCount: number, pages: Array<{ pageNumber, blob, filename }> }>}
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

    pages.push({
      pageNumber: pageNum,
      blob,
      filename: `page_${String(pageNum).padStart(3, '0')}.png`,
    })

    onProgress?.({ current: pageNum, total: pageCount, phase: 'converting' })
  }

  return { pageCount, pages }
}
