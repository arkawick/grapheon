/**
 * A minimal, valid, text-bearing PDF, built by hand.
 *
 * The drive needs a PDF fixture that is committed and deterministic. Real PDFs
 * are someone's document — and the two on this machine are an image-only
 * poster (no text layer) and a personal CV, so neither belongs in a repo.
 * This is ~40 lines of PDF syntax with correct byte offsets, which is also a
 * far better regression test than a binary blob nobody can inspect.
 *
 * Two font sizes on purpose: the heading heuristic keys off size, so a
 * single-size PDF would never exercise it.
 */
export function makeTestPdf() {
  const lines = [
    { size: 24, y: 720, text: 'Retrieval Overview' },
    { size: 11, y: 690, text: 'Passages are ranked with BM25 over every document.' },
    { size: 11, y: 674, text: 'Term saturation stops one repeated word dominating.' },
    { size: 18, y: 630, text: 'Indexing' },
    { size: 11, y: 600, text: 'Sections become graph nodes and passages stay searchable.' },
    { size: 11, y: 584, text: 'Length normalisation keeps long passages competitive.' },
  ];

  const content = lines
    .map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${l.text}) Tj ET`)
    .join('\n');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]'
      + '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}
