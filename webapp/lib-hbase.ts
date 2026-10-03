export type Entity = {
  rowKey: string;
  type: string;
  name: string;
  owner: string;
  qualifiedName: string;
  createTime: string;
};

const REST = process.env.HBASE_REST_URL || "http://127.0.0.1:8080";
const TABLE = process.env.HBASE_TABLE || "atlas_meta";
const columns = ["cf:type", "cf:name", "cf:owner", "cf:qualifiedName", "cf:createTime"];

function b64(value: string) { return Buffer.from(value, "base64").toString("utf8"); }

export async function scanEntities(): Promise<Entity[]> {
  const params = new URLSearchParams();
  for (const column of columns) params.append("column", column);
  params.set("maxrows", "1000");
  const response = await fetch(`${REST}/${TABLE}/*?${params.toString()}`, { cache: "no-store", headers: { "Accept": "application/json", "Accept-Encoding": "identity" } });
  if (!response.ok) throw new Error(`HBase REST returned ${response.status}`);
  const body = await response.json() as { Row?: Array<{ key: string; Cell?: Array<{ column: string; $: string }> }> };
  return (body.Row || []).map((row) => {
    const values: Record<string, string> = {};
    for (const cell of row.Cell || []) values[b64(cell.column).split(":").pop()!] = b64(cell.$);
    return {
      rowKey: b64(row.key), type: values.type || "", name: values.name || "", owner: values.owner || "",
      qualifiedName: values.qualifiedName || "", createTime: values.createTime || ""
    };
  });
}

export async function searchEntities(filters: { q?: string; type?: string; owner?: string; name?: string }) {
  const q = (filters.q || "").toLowerCase();
  const type = (filters.type || "").toLowerCase();
  const owner = (filters.owner || "").toLowerCase();
  const name = (filters.name || "").toLowerCase();
  const rows = await scanEntities();
  return rows.filter((row) => {
    const haystack = [row.type, row.name, row.owner, row.qualifiedName].join(" ").toLowerCase();
    return (!q || haystack.includes(q)) && (!type || row.type.toLowerCase() === type) &&
      (!owner || row.owner.toLowerCase() === owner) && (!name || row.name.toLowerCase().includes(name));
  }).sort((a, b) => a.rowKey.localeCompare(b.rowKey));
}
