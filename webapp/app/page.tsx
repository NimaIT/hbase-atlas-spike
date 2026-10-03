"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity, SearchResponse } from "../lib-contracts";

type Filters = { q: string; type: string; owner: string; name: string };
type SearchState =
  | { status: "pending" }
  | { status: "error"; error: string }
  | { status: "success"; rows: Entity[]; query: string };
const emptyFilters: Filters = { q: "", type: "", owner: "", name: "" };
const filterKeys = Object.keys(emptyFilters) as Array<keyof Filters>;

function readFilters(): Filters {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(filterKeys.map(key => [key, params.get(key) || ""])) as Filters;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return new Error(body.error);
    }
  } catch { /* Non-JSON upstream errors still get a useful message. */ }
  return new Error(`${fallback} (HTTP ${response.status})`);
}

export default function Home() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState<SearchState>({ status: "pending" });
  const [catalogTypes, setCatalogTypes] = useState<string[]>([]);
  const [exportState, setExportState] = useState<"idle" | "pending" | "success">("idle");
  const [exportError, setExportError] = useState("");
  const currentFilters = useRef<Filters>(emptyFilters);
  const searchRequest = useRef(0);
  const exportRequest = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const query = useMemo(() => new URLSearchParams(filters).toString(), [filters]);
  const typeOptions = useMemo(() => Array.from(new Set([...catalogTypes, filters.type].filter(Boolean))).sort(), [catalogTypes, filters.type]);

  function cancelPending() {
    // Invalidate immediately, including the interval before React runs effect cleanup.
    searchRequest.current += 1;
    searchController.current?.abort();
    exportRequest.current += 1;
    exportController.current?.abort();
    setSearch({ status: "pending" });
    setExportState("idle");
    setExportError("");
  }

  function applyFilters(next: Filters) {
    if (filterKeys.every(key => next[key] === currentFilters.current[key])) return;
    currentFilters.current = next;
    cancelPending();
    setFilters(next);
  }

  function changeFilters(next: Filters) {
    const url = new URL(window.location.href);
    for (const key of filterKeys) {
      if (next[key]) url.searchParams.set(key, next[key]);
      else url.searchParams.delete(key);
    }
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    applyFilters(next);
  }

  useEffect(() => {
    const initialFilters = readFilters();
    currentFilters.current = initialFilters;
    setFilters(initialFilters);
    setReady(true);
    function restoreFilters() {
      applyFilters(readFilters());
    }
    window.addEventListener("popstate", restoreFilters);
    const urls = downloadUrls.current;
    return () => {
      window.removeEventListener("popstate", restoreFilters);
      searchRequest.current += 1;
      searchController.current?.abort();
      exportRequest.current += 1;
      exportController.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const requestId = ++searchRequest.current;
    const controller = new AbortController();
    searchController.current = controller;
    setSearch({ status: "pending" });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?${query}`, { signal: controller.signal });
        if (!response.ok) throw await responseError(response, "Search failed");
        const data: SearchResponse = await response.json();
        if (!Array.isArray(data.results) || !Array.isArray(data.types) || !data.types.every((value: unknown) => typeof value === "string")) {
          throw new Error("Search returned an invalid response");
        }
        if (requestId !== searchRequest.current) return;
        setCatalogTypes(data.types);
        setSearch({ status: "success", rows: data.results, query });
      } catch (error) {
        if (requestId !== searchRequest.current || controller.signal.aborted) return;
        setSearch({ status: "error", error: error instanceof Error ? error.message : "Search failed" });
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (searchRequest.current === requestId) searchRequest.current += 1;
    };
  }, [query, ready]);

  async function exportCsv() {
    if (search.status !== "success" || search.query !== query || exportState === "pending") return;
    const requestId = ++exportRequest.current;
    const controller = new AbortController();
    exportController.current = controller;
    setExportState("pending");
    setExportError("");
    try {
      const response = await fetch(`/api/export.csv?${search.query}`, { signal: controller.signal });
      if (!response.ok) throw await responseError(response, "CSV export failed");
      const blob = await response.blob();
      if (requestId !== exportRequest.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      downloadUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = "atlas-metadata.csv";
      document.body.append(link);
      try { link.click(); } finally {
        link.remove();
        setTimeout(() => {
          if (downloadUrls.current.delete(url)) URL.revokeObjectURL(url);
        }, 0);
      }
      setExportState("success");
    } catch (error) {
      if (requestId !== exportRequest.current || controller.signal.aborted) return;
      setExportState("idle");
      setExportError(error instanceof Error ? error.message : "CSV export failed");
    }
  }

  const completed = search.status === "success" && search.query === query;
  const rows = completed ? search.rows : [];
  const status = search.status === "error" ? "HBase REST unavailable" : completed ? "HBase REST reachable" : ready ? "Searching HBase REST…" : "Checking HBase REST…";
  return <main className="shell">
    <header><div><p className="eyebrow">LOCAL PROTOTYPE · HBASE + REST</p><h1>Atlas Metadata Search</h1><p className="subtitle">A lightweight catalog view over <code>atlas_meta</code>.</p></div><span className={`status ${search.status}`}><i aria-hidden="true" />{status}</span></header>
    <section className="panel filters" aria-label="Catalog filters">
      <label className="search" htmlFor="metadata-query">Search metadata<span aria-hidden="true" className="search-icon">⌕</span><input id="metadata-query" value={filters.q} onChange={event => changeFilters({ ...filters, q: event.target.value })} placeholder="Search metadata…" /></label>
      <label htmlFor="metadata-type">Type<select id="metadata-type" value={filters.type} onChange={event => changeFilters({ ...filters, type: event.target.value })}><option value="">All types</option>{typeOptions.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
      <label htmlFor="metadata-owner">Owner<input id="metadata-owner" value={filters.owner} onChange={event => changeFilters({ ...filters, owner: event.target.value })} placeholder="e.g. data-platform" /></label>
      <label htmlFor="metadata-name">Name contains<input id="metadata-name" value={filters.name} onChange={event => changeFilters({ ...filters, name: event.target.value })} placeholder="e.g. sales" /></label>
      <button className="secondary" onClick={() => changeFilters(emptyFilters)}>Reset filters</button>
    </section>
    <section className="summary" aria-label="Search results summary"><div role="status" aria-live="polite" aria-atomic="true">{completed ? <><strong>{rows.length}</strong><span>entities found</span></> : <span>{search.status === "error" ? "Search failed." : "Searching metadata…"}</span>}</div><button className="primary" disabled={!completed || exportState === "pending"} onClick={exportCsv}>{exportState === "pending" ? "Exporting CSV…" : "Export CSV"}</button></section>
    {search.status === "error" && <div className="error" role="alert">Could not load metadata: {search.error}</div>}
    {exportError && <div className="error" role="alert">Could not export CSV: {exportError}</div>}
    <p className="export-status" role="status" aria-live="polite">{exportState === "pending" ? "Preparing CSV download…" : exportState === "success" ? "CSV download started." : ""}</p>
    <section className="panel table-wrap"><table aria-busy={!completed && search.status !== "error"}>
      <caption className="sr-only">Atlas metadata search results</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Owner</th><th scope="col">Qualified name</th><th scope="col">Created</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.rowKey}><td><span className="tag">{row.type}</span></td><td className="name">{row.name}</td><td>{row.owner}</td><td className="muted">{row.qualifiedName}</td><td className="muted">{row.createTime}</td></tr>)}{completed && rows.length === 0 && <tr><td colSpan={5} className="empty">No matching metadata.</td></tr>}{!completed && search.status !== "error" && <tr><td colSpan={5} className="empty">Loading metadata…</td></tr>}</tbody>
    </table></section>
    <footer>Standalone HBase · REST · table <code>atlas_meta</code></footer>
  </main>;
}
