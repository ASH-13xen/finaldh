// Build a base64 PDF containing only pages [startIdx0, endIdx0] (0-based, inclusive)
// of an already-loaded pdf-lib document. Shared by the compendium/PYQ ingestion
// passes and the toppers-copy AI analysis.
import { PDFDocument } from 'pdf-lib';

export const makeChunkPdfBase64 = async (srcDoc, startIdx0, endIdx0) => {
  const chunk = await PDFDocument.create();
  const indices = [];
  for (let p = startIdx0; p <= endIdx0; p++) indices.push(p);
  const pages = await chunk.copyPages(srcDoc, indices);
  pages.forEach((pg) => chunk.addPage(pg));
  const bytes = await chunk.save();
  return Buffer.from(bytes).toString('base64');
};
