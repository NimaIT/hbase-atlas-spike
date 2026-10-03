import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiErrorResponse, CatalogError, parseFilters } from "../lib-api";
import { scanEntities, searchCatalog, searchEntities } from "../lib-hbase";
import { GET } from "../app/api/search/route";

const originalFetch = globalThis.fetch;
const settings = ["HBASE_REST_URL", "HBASE_TABLE", "HBASE_MAX_ROWS", "HBASE_MAX_RESPONSE_BYTES", "HBASE_TIMEOUT_MS"];
const originalSettings = new Map(settings.map(key => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalSettings) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const b64 = (value: string) => Buffer.from(value).toString("base64");
function row(key: string, fields: Record<string, string> = {}) {
  return {
    key: b64(key),
    Cell: Object.entries({ type: "hive_table", name: "analytics.sales", owner: "Data-Platform", qualifiedName: "cluster/analytics.sales", ...fields })
      .map(([name, value]) => ({ column: b64(`cf:${name}`), $: b64(value), timestamp: 1710000000000 })),
  };
}
function upstream(body: unknown, headers: HeadersInit = {}) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { headers });
}
function code(expected: string) {
  return (error: unknown) => error instanceof CatalogError && error.code === expected;
}

test("valid empty CellSet is empty; malformed objects are errors", async () => {
  upstream({ Row: [] });
  assert.deepEqual(await searchCatalog({}), { results: [], count: 0, types: [] });
  upstream({ unexpected: "not CellSet" });
  await assert.rejects(scanEntities(), code("INVALID_UPSTREAM_DATA"));
});

test("combined filters are trimmed, case insensitive, and sorted; facets come from all rows", async () => {
  upstream({ Row: [row("z"), row("a"), row("other-owner", { owner: "someone" }), row("other-type", { type: "custom_vision_type" })] });
  const result = await searchCatalog({ q: " CLUSTER ", type: " HIVE_TABLE ", owner: " data-platform ", name: " SALES " });
  assert.deepEqual(result.results.map(entity => entity.rowKey), ["a", "z"]);
  assert.equal(result.count, 2);
  assert.deepEqual(result.types, ["custom_vision_type", "hive_table"]);
  assert.equal(result.results[0].createTime, "");
});

test("known HBase limit includes overflow sentinel; no matches beyond the limit are silently omitted", async () => {
  process.env.HBASE_MAX_ROWS = "2";
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(url.searchParams.has("maxrows"), false);
    assert.equal(options?.redirect, "error");
    return Response.json({ Row: [row("a"), row("b"), row("z", { name: "target-after-supported-limit" })] });
  };
  await assert.rejects(searchEntities({ q: "target-after-supported-limit" }), code("CATALOG_TOO_LARGE"));
  upstream({ Row: [row("a"), row("b")] });
  assert.equal((await searchEntities({})).length, 2);
});

for (const [description, body] of [
  ["array instead of CellSet", []],
  ["nonarray Row", { Row: {} }],
  ["row without cells", { Row: [{ key: b64("key") }] }],
  ["invalid base64", { Row: [{ ...row("key"), key: "%%%" }] }],
  ["noncanonical base64", { Row: [{ ...row("key"), key: "Zh==" }] }],
  ["invalid UTF8", { Row: [{ ...row("key"), key: Buffer.from([255]).toString("base64") }] }],
  ["duplicate row keys", { Row: [row("same"), row("same")] }],
  ["missing identity", { Row: [{ key: b64("key"), Cell: [] }] }],
  ["duplicate cells", { Row: [{ key: b64("key"), Cell: [...row("key").Cell, row("key").Cell[0]] }] }],
  ["unknown column family", { Row: [{ key: b64("key"), Cell: [{ column: b64("other:type"), $: b64("table") }] }] }],
  ["invalid timestamp", { Row: [{ key: b64("key"), Cell: [{ ...row("key").Cell[0], timestamp: -1 }] }] }],
] as const) {
  test(`reject ${description}`, async () => {
    upstream(body);
    await assert.rejects(scanEntities(), code("INVALID_UPSTREAM_DATA"));
  });
}

test("invalid JSON and non-JSON UTF8 are rejected", async () => {
  globalThis.fetch = async () => new Response("not json");
  await assert.rejects(scanEntities(), code("INVALID_UPSTREAM_DATA"));
  globalThis.fetch = async () => new Response(Uint8Array.from([255]));
  await assert.rejects(scanEntities(), code("INVALID_UPSTREAM_DATA"));
});

test("declared and streamed body sizes are bounded, even with a false content-length", async () => {
  process.env.HBASE_MAX_RESPONSE_BYTES = "100";
  upstream({ Row: [] }, { "content-length": "101" });
  await assert.rejects(scanEntities(), code("UPSTREAM_RESPONSE_TOO_LARGE"));
  upstream({ Row: [row("key")] }, { "content-length": "1" });
  await assert.rejects(scanEntities(), code("UPSTREAM_RESPONSE_TOO_LARGE"));
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(60)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(scanEntities(), code("UPSTREAM_RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("network failures and non-2xx replies produce safe structured errors", async () => {
  globalThis.fetch = async () => { throw new Error("PRIVATE-UPSTREAM-DETAIL"); };
  const result = await GET(new Request("http://localhost/api/search"));
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { error: "The metadata catalog is unavailable.", code: "CATALOG_UNAVAILABLE" });
  globalThis.fetch = async () => new Response("PRIVATE-UPSTREAM-DETAIL", { status: 500 });
  await assert.rejects(scanEntities(), code("CATALOG_UNAVAILABLE"));
});

test("total deadline covers both response headers and stalled streaming bodies", async () => {
  process.env.HBASE_TIMEOUT_MS = "25";
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  await assert.rejects(scanEntities(), code("CATALOG_TIMEOUT"));
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(scanEntities(), code("CATALOG_TIMEOUT"));
  assert.equal(cancelled, true);
});

test("cancellation before fetch and during a body scan propagates", async () => {
  const first = new AbortController();
  first.abort();
  globalThis.fetch = async () => { assert.fail("pre-cancelled request must not fetch"); };
  await assert.rejects(scanEntities({ signal: first.signal }), code("REQUEST_CANCELLED"));
  const second = new AbortController();
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = scanEntities({ signal: second.signal });
  setTimeout(() => second.abort(), 10);
  await assert.rejects(pending, code("REQUEST_CANCELLED"));
  assert.equal(cancelled, true);
});

test("invalid filter inputs fail before fetching and arbitrary bounded types are accepted", async () => {
  assert.deepEqual(parseFilters(new URLSearchParams("type=custom_vision_type&owner=%20ALICE%20")), { q: "", type: "custom_vision_type", owner: "ALICE", name: "" });
  for (const params of [new URLSearchParams({ q: "x".repeat(257) }), new URLSearchParams("q=a&q=b"), new URLSearchParams({ owner: "a\nb" })]) {
    assert.throws(() => parseFilters(params), code("INVALID_FILTER"));
  }
  globalThis.fetch = async () => { assert.fail("invalid input must not fetch"); };
  const response = await GET(new Request(`http://localhost/api/search?q=${"x".repeat(257)}`));
  assert.equal(response.status, 400);
  await assert.rejects(searchEntities({ name: "x".repeat(257) }), code("INVALID_FILTER"));
});

for (const [key, value] of [
  ["HBASE_REST_URL", "file:///etc/passwd"],
  ["HBASE_REST_URL", "http://user:password@localhost:8080"],
  ["HBASE_REST_URL", "http://localhost:8080?foo=bar"],
  ["HBASE_REST_URL", ""],
  ["HBASE_TABLE", "../another"],
  ["HBASE_TABLE", "a:b:c"],
  ["HBASE_TABLE", ""],
  ["HBASE_MAX_ROWS", "0"],
  ["HBASE_MAX_ROWS", "10001"],
  ["HBASE_TIMEOUT_MS", "Infinity"],
  ["HBASE_MAX_RESPONSE_BYTES", "-1"],
] as const) {
  test(`reject invalid configuration ${key}=${value}`, async () => {
    process.env[key] = value;
    globalThis.fetch = async () => { assert.fail("invalid configuration must not fetch"); };
    await assert.rejects(scanEntities(), code("INVALID_CONFIGURATION"));
  });
}

test("configured URL prefixes and namespaced tables construct a safe scan URL", async () => {
  process.env.HBASE_REST_URL = "http://localhost:8080/rest/";
  process.env.HBASE_TABLE = "catalog:atlas_meta";
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/rest/catalog%3Aatlas_meta/*");
    return Response.json({ Row: [] });
  };
  await scanEntities();
});

test("search API publishes shared facets, count, and no-store", async () => {
  upstream({ Row: [row("one"), row("two", { type: "new_type" })] });
  const response = await GET(new Request("http://localhost/api/search?type=new_type"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.count, 1);
  assert.deepEqual(data.types, ["hive_table", "new_type"]);
  assert.equal(data.results[0].rowKey, "two");
});

test("unknown errors never disclose raw details", async () => {
  const response = apiErrorResponse(new Error("SECRET"));
  assert.equal((await response.text()).includes("SECRET"), false);
});
