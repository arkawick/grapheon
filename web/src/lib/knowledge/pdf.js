/**
 * PDF -> markdown-ish text.
 *
 * The trick that keeps this small: rather than teaching the parser about PDFs,
 * we convert a PDF into text that LOOKS like markdown — detected headings get
 * a `#` prefix — and hand it to `parseDocument` unchanged. Sections, passages,
 * graph nodes and BM25 then all work exactly as they do for a .md file.
 *
 * Loaded dynamically so nothing pays for pdf.js unless a PDF is actually
 * opened; it is by far the largest dependency in the app.
 *
 * Runs on the MAIN THREAD, not inside the knowledge worker. pdf.js spawns a
 * worker of its own, and nesting that inside ours made getDocument() hang
 * forever with no error at all — the promise simply never settled. On the main
 * thread it is the ordinary, well-trodden path, and the heavy work still
 * happens off-thread because pdf.js puts it in its own worker.
 *
 * WHAT THIS CANNOT DO: a scanned PDF has no text layer at all — it is images
 * of text — and comes back empty. That needs OCR (Tesseract, ~10 MB plus
 * language data), which is a different project. We report it rather than
 * silently producing a document with no content.
 */

let pdfjs = null;

async function load() {
  if (pdfjs) return pdfjs;
  const lib = await import('pdfjs-dist');
  // Vite turns this into an asset URL; pdf.js then spawns its own worker.
  // Nested workers are fine in Chromium (so, in the Android WebView too).
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfjs = lib;
  return lib;
}

// A line is a heading if it is meaningfully taller than the body text and
// short enough to be a title. Ratio rather than an absolute size, because
// documents set their own scale.
const HEADING_RATIO = 1.18;
const MAX_HEADING_CHARS = 90;

/**
 * @param {ArrayBuffer} data
 * @param {string} path  for error messages only
 * @returns {Promise<{text: string, pages: number, headings: number}>}
 */
export async function pdfToText(data, path) {
  const lib = await load();
  // Keep the LOADING TASK: in pdf.js 6 the document proxy has no destroy(),
  // and leaking the task leaks its worker along with the whole file's buffers.
  const task = lib.getDocument({
    data,
    // No network fetches for fonts/cmaps: this must work offline, and a
    // missing glyph map only affects rendering, which we never do.
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;

  const lines = [];
  const heights = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    // Group items into visual lines by their y position. PDF text items are
    // positioned glyph runs with no concept of a line, so anything that
    // reads them item-by-item produces one word per line.
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      const h = Math.abs(item.transform[3]) || item.height || 0;
      // Bucket to 2pt so sub-pixel baseline drift doesn't split a line.
      const key = Math.round(y / 2);
      if (!rows.has(key)) rows.set(key, { y, h: 0, parts: [] });
      const row = rows.get(key);
      row.parts.push(item.str);
      row.h = Math.max(row.h, h);
    }

    // Top of the page downwards: PDF y grows upwards.
    const ordered = [...rows.values()].sort((a, b) => b.y - a.y);
    for (const row of ordered) {
      const text = row.parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push({ text, h: row.h, page: n });
      if (row.h) heights.push(row.h);
    }
    lines.push({ text: '', h: 0, page: n }); // blank line = passage boundary
    page.cleanup();
  }

  const pages = doc.numPages;
  await task.destroy();

  if (!lines.some((l) => l.text)) {
    throw new Error(
      `${path}: no text layer — this looks like a scanned PDF, which needs OCR.`
    );
  }

  // Median, not mean: a title page can be 40pt and would drag a mean up far
  // enough that nothing else registers as a heading.
  heights.sort((a, b) => a - b);
  const body = heights[Math.floor(heights.length / 2)] || 0;

  let headings = 0;
  const out = lines.map((l) => {
    if (!l.text) return '';
    const isHeading =
      body > 0 && l.h >= body * HEADING_RATIO && l.text.length <= MAX_HEADING_CHARS;
    if (!isHeading) return l.text;
    headings++;
    // Two sizes of heading, so the section hierarchy has some shape.
    return `${l.h >= body * 1.5 ? '#' : '##'} ${l.text}`;
  });

  return { text: out.join('\n'), pages, headings };
}
