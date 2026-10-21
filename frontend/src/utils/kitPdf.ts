// PDF del Kit scritto a mano: 1 pagina A4, Helvetica + Courier standard, solo Latin-1.
export interface KitPdfInput {
  title: string;
  /** Righe di testo sotto il titolo (gia' tradotte). */
  lines: string[];
  /** Kit gia' formattato (`formatKit`), in Courier. */
  kit: string;
  footer?: string;
}

// Latin-1 per PDF WinAnsi; sostituisce il resto e le parentesi/backslash vanno escapati.
function esc(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c >= 32 && c <= 255 && !(c >= 0x7f && c <= 0x9f) && ch.length === 1) out += ch;
    else out += '?';
  }
  return out;
}

const WRAP_COLS = 85;

// A capo per numero di caratteri sugli spazi; una parola piu' lunga viene spezzata.
function wrap(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let word of line.split(' ')) {
    while (word.length > WRAP_COLS) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(word.slice(0, WRAP_COLS));
      word = word.slice(WRAP_COLS);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= WRAP_COLS) cur += ' ' + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  out.push(cur);
  return out;
}

export function buildKitPdf(input: KitPdfInput): Uint8Array {
  let y = 780;
  let content = `BT /F1 20 Tf 50 ${y} Td (${esc(input.title)}) Tj ET\n`;
  y -= 40;
  for (const line of input.lines.flatMap(wrap)) {
    content += `BT /F1 11 Tf 50 ${y} Td (${esc(line)}) Tj ET\n`;
    y -= 16;
  }
  y -= 20;
  // Il Kit non deve finire sul footer / fuori pagina.
  if (y < 60) throw new Error('vault.kit.errors.pdfOverflow');
  content += `BT /F2 15 Tf 50 ${y} Td (${esc(input.kit)}) Tj ET\n`;
  if (input.footer) content += `BT /F1 9 Tf 50 40 Td (${esc(input.footer)}) Tj ET\n`;

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Tutti i caratteri sono <= 255: un byte ciascuno.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  return bytes;
}
