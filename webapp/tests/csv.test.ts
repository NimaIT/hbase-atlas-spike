import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../app/api/export.csv/route";
import { csvCell, csvDocument } from "../lib-csv";
import { searchEntities } from "../lib-hbase";
import type { Entity } from "../lib-contracts";

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

test("HBase decoding preserves leading BOM data and distinct row identities for export", async (context) => {
  const entities = ["entity", "\ufeffentity"].map((rowKey) => ({
    rowKey, type: "\ufeffhive_table", name: "\ufeff東京", owner: "\ufeffdata-platform",
    qualifiedName: "\ufeffcatalog", createTime: "\ufeff2026-01-15T09:00:00Z",
  }));
  context.mock.method(globalThis, "fetch", async () => hbaseResponse(entities));
  const actual = await searchEntities({});
  assert.equal(actual.length, 2);
  for (const entity of entities) assert.deepEqual(actual.find((row) => row.rowKey === entity.rowKey), entity);
  const response = await GET(new Request("http://localhost/api/export.csv"));
  assert.equal(response.status, 200);
  const [, ...rows] = parseCsv(await response.text());
  for (const entity of entities) assert.deepEqual(rows.find((row) => row[0] === entity.rowKey), columns.map((column) => entity[column]));
});

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
  assert.equal(response.headers.get("cache-control"), "no-store");
  const [header, ...rows] = parseCsv(await response.text());
  assert.deepEqual(header, columns);
  const expected = entities.map((entity, index) => columns.map((column, columnIndex) => {
    const value = entity[column];
    return columnIndex === Math.floor(index / formulas.length) ? `'${value}` : value;
  }));
  const sorted = (values: string[][]) => values.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(sorted(rows), sorted(expected));
});

test("CSV endpoint rejects oversized, control-containing, and duplicate filters before fetching", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    assert.fail("invalid filters must not reach HBase");
  });
  for (const key of ["q", "type", "owner", "name"]) {
    for (const params of [
      new URLSearchParams({ [key]: "x".repeat(257) }),
      new URLSearchParams({ [key]: "safe\nunsafe" }),
      new URLSearchParams([[key, "first"], [key, "second"]]),
    ]) {
      const response = await GET(new Request(`http://localhost/api/export.csv?${params}`));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_FILTER");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("CSV endpoint sanitizes upstream exception messages in errors and diagnostics", async (context) => {
  const privateMessage = "synthetic-password@example.invalid/internal/catalog";
  context.mock.method(globalThis, "fetch", async () => { throw new Error(privateMessage); });
  const diagnostic = context.mock.method(console, "error", () => {});
  const response = await GET(new Request("http://localhost/api/export.csv"));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "The metadata catalog is unavailable.", code: "CATALOG_UNAVAILABLE",
  });
  assert.ok(diagnostic.mock.calls.length > 0);
  assert.ok(!JSON.stringify(diagnostic.mock.calls.map((call) => call.arguments)).includes(privateMessage));
});

test("CSV endpoint avoids HBase work when the request is already cancelled", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    assert.fail("an already cancelled export must not reach HBase");
  });
  const controller = new AbortController();
  controller.abort();
  const response = await GET(new Request("http://localhost/api/export.csv", { signal: controller.signal }));
  assert.equal(response.status, 499);
  assert.equal((await response.json()).code, "REQUEST_CANCELLED");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("CSV endpoint propagates cancellation to its active HBase request", { timeout: 1000 }, async (context) => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    upstreamSignal = init?.signal;
    assert.ok(upstreamSignal);
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      controller.abort();
    });
  });
  const response = await GET(new Request("http://localhost/api/export.csv", { signal: controller.signal }));
  assert.equal(response.status, 499);
  assert.equal((await response.json()).code, "REQUEST_CANCELLED");
  assert.ok(upstreamSignal?.aborted);
});
