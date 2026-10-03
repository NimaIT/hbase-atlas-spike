import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../app/api/export.csv/route";
import { csvCell, csvDocument } from "../lib-csv";
import type { Entity } from "../lib-hbase";

const columns = ["rowKey", "type", "name", "owner", "qualifiedName", "createTime"] as const;
const formulas = [
  "=1+1", "+1+1", "-1+1", "@SUM(1,1)", '=HYPERLINK("https://example.invalid","click")',
  " =1+1", "\t+1+1", "\r-1+1", "\n@SUM(1,1)", " \t\r\n=1+1",
  "\u0000=1+1", "\u001f=1+1", "\u007f=1+1", "\u0085=1+1",
  "\u00a0=1+1", "\u2003=1+1", "\ufeff=1+1",
];

// Independent CSV reader exercises delimiter escaping and embedded line breaks.
function parseCsv(document: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < document.length; index += 1) {
    const character = document[index];
    if (character === '"') {
      if (quoted && document[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && character === ",") { row.push(cell); cell = ""; }
    else if (!quoted && character === "\r" && document[index + 1] === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; index += 1;
    } else cell += character;
  }
  assert.equal(quoted, false, "CSV has a closing quote");
  assert.equal(cell, "", "CSV ends with a record separator");
  assert.deepEqual(row, []);
  return rows;
}

test("formula cells are text even after spreadsheet whitespace/control trimming", () => {
  for (const formula of formulas) {
    assert.deepEqual(parseCsv(csvDocument([[formula]])), [[`'${formula}`]]);
    assert.ok(csvCell(formula).startsWith('"\''));
  }
});

test("safe metadata round-trips quotes, commas, embedded newlines, Unicode, and empty fields", () => {
  const safeValues = [
    "", "analytics.sales", "finance-team", "orders+returns", "contact@example.com",
    "東京 / café / 🗂️", 'value,"with quotes"', "first\nsecond\r\nthird", " leading text",
    "\tordinary text", "\r\nordinary text", "2026-01-15T09:00:00Z", "'=already text",
  ];
  assert.deepEqual(parseCsv(csvDocument([safeValues, safeValues])), [safeValues, safeValues]);
  assert.equal(csvCell('value,"with quotes"'), '"value,""with quotes"""');
});

function hbaseResponse(entities: Entity[]): Response {
  const encode = (value: string) => Buffer.from(value).toString("base64");
  return Response.json({ Row: entities.map((entity) => ({
    key: encode(entity.rowKey),
    Cell: columns.filter((column) => column !== "rowKey").map((column) => ({
      column: encode(`cf:${column}`), $: encode(entity[column]),
    })),
  })) });
}

test("CSV endpoint neutralizes malicious metadata in every exported column", async (context) => {
  const entities = columns.flatMap((column, columnIndex) => formulas.map((formula, formulaIndex) => ({
    rowKey: `entity-${columnIndex}-${formulaIndex}`, type: "hive_table", name: `safe-${columnIndex}-${formulaIndex}`,
    owner: "data-platform", qualifiedName: '東京,"catalog"\nqualified', createTime: "2026-01-15T09:00:00Z",
    [column]: formula,
  })));
  context.mock.method(globalThis, "fetch", async () => hbaseResponse(entities));
  const response = await GET(new Request("http://localhost/api/export.csv"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=atlas-meta.csv");
  const [header, ...rows] = parseCsv(await response.text());
  assert.deepEqual(header, columns);
  const expected = entities.map((entity, index) => columns.map((column, columnIndex) => {
    const value = entity[column];
    return columnIndex === Math.floor(index / formulas.length) ? `'${value}` : value;
  }));
  const sorted = (values: string[][]) => values.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(sorted(rows), sorted(expected));
});
