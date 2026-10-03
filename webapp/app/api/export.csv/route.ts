import { searchEntities } from "../../../lib-hbase";
import { csvDocument } from "../../../lib-csv";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const rows = await searchEntities({ q: url.searchParams.get("q") || "", type: url.searchParams.get("type") || "", owner: url.searchParams.get("owner") || "", name: url.searchParams.get("name") || "" });
    const document = csvDocument([["rowKey", "type", "name", "owner", "qualifiedName", "createTime"], ...rows.map((r) => [r.rowKey, r.type, r.name, r.owner, r.qualifiedName, r.createTime])]);
    return new Response(document, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=atlas-meta.csv" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Export failed" }, { status: 502 }); }
}
