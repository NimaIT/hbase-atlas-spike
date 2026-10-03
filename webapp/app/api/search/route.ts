import { NextResponse } from "next/server";
import { searchEntities } from "../../../lib-hbase";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const results = await searchEntities({ q: url.searchParams.get("q") || "", type: url.searchParams.get("type") || "", owner: url.searchParams.get("owner") || "", name: url.searchParams.get("name") || "" });
    return NextResponse.json({ results, count: results.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Search failed" }, { status: 502 });
  }
}
