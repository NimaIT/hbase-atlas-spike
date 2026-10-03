import { searchEntities } from "../../../lib-hbase";
import { csvDocument } from "../../../lib-csv";
import { apiErrorResponse, parseFilters } from "../../../lib-api";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rows = await searchEntities(parseFilters(url.searchParams), { signal: request.signal });
    const document = csvDocument([["rowKey", "type", "name", "owner", "qualifiedName", "createTime"], ...rows.map((r) => [r.rowKey, r.type, r.name, r.owner, r.qualifiedName, r.createTime])]);
    return new Response(document, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=atlas-meta.csv", "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
