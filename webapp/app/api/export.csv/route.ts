import { searchEntities } from "../../../lib-hbase";

function csv(value: string) { return `"${value.replaceAll('"', '""')}"`; }
export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const rows = await searchEntities({ q: url.searchParams.get("q") || "", type: url.searchParams.get("type") || "", owner: url.searchParams.get("owner") || "", name: url.searchParams.get("name") || "" });
    const lines = [["rowKey", "type", "name", "owner", "qualifiedName", "createTime"], ...rows.map((r) => [r.rowKey, r.type, r.name, r.owner, r.qualifiedName, r.createTime])].map((line) => line.map(csv).join(","));
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=atlas-meta.csv" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Export failed" }, { status: 502 }); }
}
