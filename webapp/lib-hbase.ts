import { CatalogError, normalizeFilters } from "./lib-api";
import type { Entity, SearchFilters, SearchResponse } from "./lib-contracts";

export type { Entity } from "./lib-contracts";
type ScanOptions = { signal?: AbortSignal };
const columns = ["cf:type", "cf:name", "cf:owner", "cf:qualifiedName", "cf:createTime"];

function positiveSetting(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > ceiling) {
    throw new CatalogError("INVALID_CONFIGURATION", 503, "The metadata catalog configuration is invalid.");
  }
  return Number(raw);
}

function configuration() {
  let base: URL;
  try { base = new URL(process.env.HBASE_REST_URL ?? "http://127.0.0.1:8080"); }
  catch { throw new CatalogError("INVALID_CONFIGURATION", 503, "The metadata catalog configuration is invalid."); }
  const table = process.env.HBASE_TABLE ?? "atlas_meta";
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || table.length > 256 || !/^(?:[A-Za-z0-9_]+:)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(table)) {
    throw new CatalogError("INVALID_CONFIGURATION", 503, "The metadata catalog configuration is invalid.");
  }
  base.pathname = `${base.pathname.replace(/\/$/u, "")}/${encodeURIComponent(table)}/*`;
  const maxRows = positiveSetting("HBASE_MAX_ROWS", 1000, 10000);
  for (const column of columns) base.searchParams.append("column", column);
  // HBase wildcard scans recognize limit, not maxrows. The extra row detects overflow.
  base.searchParams.set("limit", String(maxRows + 1));
  return {
    url: base, maxRows,
    maxBytes: positiveSetting("HBASE_MAX_RESPONSE_BYTES", 4 * 1024 * 1024, 16 * 1024 * 1024),
    timeoutMs: positiveSetting("HBASE_TIMEOUT_MS", 10000, 60000),
  };
}

function invalidData(): never {
  throw new CatalogError("INVALID_UPSTREAM_DATA", 502, "The metadata catalog returned invalid data.");
}

function decoded(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return invalidData();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return invalidData();
  // Each cell is a string, so a leading U+FEFF is data rather than a byte-order marker.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalidData(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entities(body: unknown, maxRows: number): Entity[] {
  if (!record(body) || !Array.isArray(body.Row)) return invalidData();
  if (body.Row.length > maxRows) throw new CatalogError("CATALOG_TOO_LARGE", 503, "The metadata catalog exceeds the supported row limit. No partial results were returned.");
  const keys = new Set<string>();
  return body.Row.map((row: unknown) => {
    if (!record(row) || !Array.isArray(row.Cell)) return invalidData();
    const rowKey = decoded(row.key);
    if (!rowKey || keys.has(rowKey)) return invalidData();
    keys.add(rowKey);
    const values = new Map<string, string>();
    for (const cell of row.Cell) {
      if (!record(cell)) return invalidData();
      const column = decoded(cell.column);
      if (!columns.includes(column) || values.has(column)) return invalidData();
      if (cell.timestamp !== undefined && (!Number.isSafeInteger(cell.timestamp) || Number(cell.timestamp) < 0)) return invalidData();
      values.set(column, decoded(cell.$));
    }
    // Identity fields are required; optional metadata may be absent.
    const type = values.get("cf:type");
    const name = values.get("cf:name");
    if (!type?.trim() || !name?.trim()) return invalidData();
    return { rowKey, type, name, owner: values.get("cf:owner") ?? "", qualifiedName: values.get("cf:qualifiedName") ?? "", createTime: values.get("cf:createTime") ?? "" };
  });
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new CatalogError("UPSTREAM_RESPONSE_TOO_LARGE", 502, "The metadata catalog response exceeds the supported size limit.");
  }
  if (!response.body) return invalidData();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CatalogError("UPSTREAM_RESPONSE_TOO_LARGE", 502, "The metadata catalog response exceeds the supported size limit.");
      }
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))); }
    catch { return invalidData(); }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function scanEntities(options: ScanOptions = {}): Promise<Entity[]> {
  const config = configuration();
  const controller = new AbortController();
  const abortRequest = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortRequest, { once: true });
  if (options.signal?.aborted) abortRequest();
  const timer = setTimeout(() => controller.abort(new DOMException("Catalog deadline exceeded", "TimeoutError")), config.timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(config.url, {
      cache: "no-store", signal: controller.signal, redirect: "error",
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogError("CATALOG_UNAVAILABLE", 502, "The metadata catalog is unavailable.", { upstreamStatus: response.status });
    }
    const body = await readBoundedBody(response, config.maxBytes, controller.signal);
    controller.signal.throwIfAborted();
    return entities(body, config.maxRows);
  } catch (error) {
    if (options.signal?.aborted) throw new CatalogError("REQUEST_CANCELLED", 499, "The metadata request was cancelled.");
    if (controller.signal.aborted) throw new CatalogError("CATALOG_TIMEOUT", 504, "The metadata catalog did not respond in time.");
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("CATALOG_UNAVAILABLE", 502, "The metadata catalog is unavailable.", { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortRequest);
  }
}

function filtered(rows: Entity[], filters: SearchFilters): Entity[] {
  const normalized = normalizeFilters(filters);
  const q = normalized.q!.toLowerCase();
  const type = normalized.type!.toLowerCase();
  const owner = normalized.owner!.toLowerCase();
  const name = normalized.name!.toLowerCase();
  return rows.filter((row) => {
    const haystack = [row.type, row.name, row.owner, row.qualifiedName].join(" ").toLowerCase();
    return (!q || haystack.includes(q)) && (!type || row.type.toLowerCase() === type) &&
      (!owner || row.owner.toLowerCase() === owner) && (!name || row.name.toLowerCase().includes(name));
  }).sort((a, b) => a.rowKey.localeCompare(b.rowKey));
}

export async function searchCatalog(filters: SearchFilters, options: ScanOptions = {}): Promise<SearchResponse> {
  const normalized = normalizeFilters(filters);
  const rows = await scanEntities(options);
  const results = filtered(rows, normalized);
  const types = [...new Set(rows.map(row => row.type))].sort((a, b) => a.localeCompare(b));
  return { results, count: results.length, types };
}

export async function searchEntities(filters: SearchFilters, options: ScanOptions = {}): Promise<Entity[]> {
  return (await searchCatalog(filters, options)).results;
}
