import { searchCatalog } from "../../../lib-hbase";
import { apiErrorResponse, parseFilters } from "../../../lib-api";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await searchCatalog(parseFilters(url.searchParams), { signal: request.signal });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
