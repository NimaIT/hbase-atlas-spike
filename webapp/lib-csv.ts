// CSV quoting protects delimiters, but spreadsheets still evaluate quoted formulas.
// Include leading whitespace and control characters that spreadsheet importers
// may discard before interpreting a cell.
const spreadsheetFormula = /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u;

export function csvCell(value: string): string {
  const safeValue = spreadsheetFormula.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function csvDocument(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
