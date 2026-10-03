"use client";
import { useEffect, useMemo, useState } from "react";
type Entity = { rowKey: string; type: string; name: string; owner: string; qualifiedName: string; createTime: string };
const types = ["", "hive_table", "hive_database", "hdfs_path"];
export default function Home() {
  const [q, setQ] = useState(""); const [type, setType] = useState(""); const [owner, setOwner] = useState(""); const [name, setName] = useState("");
  const [rows, setRows] = useState<Entity[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const query = useMemo(() => new URLSearchParams({ q, type, owner, name }).toString(), [q, type, owner, name]);
  useEffect(() => { const timer = setTimeout(async () => { setLoading(true); setError(""); try { const r = await fetch(`/api/search?${query}`); const data = await r.json(); if (!r.ok) throw new Error(data.error || "Search failed"); setRows(data.results); } catch (e) { setError(e instanceof Error ? e.message : "Search failed"); setRows([]); } finally { setLoading(false); } }, 180); return () => clearTimeout(timer); }, [query]);
  return <main className="shell"><header><div><p className="eyebrow">LOCAL PROTOTYPE · HBASE + REST</p><h1>Atlas Metadata Search</h1><p className="subtitle">A lightweight catalog view over <code>atlas_meta</code>.</p></div><span className="status"><i /> HBase connected</span></header>
    <section className="panel filters"><label className="search"><span>⌕</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search metadata…" /></label><label>Type<select value={type} onChange={e => setType(e.target.value)}>{types.map(t => <option key={t} value={t}>{t || "All types"}</option>)}</select></label><label>Owner<input value={owner} onChange={e => setOwner(e.target.value)} placeholder="e.g. data-platform" /></label><label>Name contains<input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. sales" /></label><button className="secondary" onClick={() => { setQ(""); setType(""); setOwner(""); setName(""); }}>Reset</button></section>
    <section className="summary"><div><strong>{loading ? "…" : rows.length}</strong><span>entities found</span></div><button className="primary" onClick={() => { window.location.href = `/api/export.csv?${query}`; }}>↓ Export CSV</button></section>
    {error && <div className="error">Could not reach HBase REST: {error}</div>}
    <section className="panel table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Owner</th><th>Qualified name</th><th>Created</th></tr></thead><tbody>{rows.map(row => <tr key={row.rowKey}><td><span className="tag">{row.type}</span></td><td className="name">{row.name}</td><td>{row.owner}</td><td className="muted">{row.qualifiedName}</td><td className="muted">{row.createTime}</td></tr>)}{!loading && rows.length === 0 && !error && <tr><td colSpan={5} className="empty">No matching metadata.</td></tr>}</tbody></table></section>
    <footer>Standalone HBase · REST 8080 · table <code>atlas_meta</code></footer></main>;
}
