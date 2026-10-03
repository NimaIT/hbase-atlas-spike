import type { ApiError, SearchFilters } from "./lib-contracts";

export class CatalogError extends Error {
  readonly upstreamStatus?: number;
  constructor(public readonly code: string, public readonly status: number, message: string, options?: ErrorOptions & { upstreamStatus?: number }) {
    super(message, options);
    this.name = "CatalogError";
    this.upstreamStatus = options?.upstreamStatus;
  }
}

// Bounds apply before trimming as well, so whitespace cannot evade input limits.
export const MAX_FILTER_LENGTH = 256;
export const filterKeys = ["q", "type", "owner", "name"] as const;

export function normalizeFilters(filters: SearchFilters): SearchFilters {
  const normalized: SearchFilters = {};
  for (const key of filterKeys) {
    const value = filters[key] ?? "";
    if (typeof value !== "string" || value.length > MAX_FILTER_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new CatalogError("INVALID_FILTER", 400, `Filters must contain at most ${MAX_FILTER_LENGTH} characters and no control characters.`);
    }
    normalized[key] = value.trim();
  }
  return normalized;
}

export function parseFilters(params: URLSearchParams): SearchFilters {
  const filters: SearchFilters = {};
  for (const key of filterKeys) {
    if (params.getAll(key).length > 1) throw new CatalogError("INVALID_FILTER", 400, "Each filter may be supplied only once.");
    filters[key] = params.get(key) ?? "";
  }
  return normalizeFilters(filters);
}

export function apiErrorResponse(error: unknown): Response {
  const known = error instanceof CatalogError ? error : new CatalogError("CATALOG_UNAVAILABLE", 502, "The metadata catalog is unavailable.", { cause: error });
  if (known.status >= 500) {
    // No request URLs, response bodies or credential values in diagnostics.
    console.error("Catalog request failed", { code: known.code, status: known.status, upstreamStatus: known.upstreamStatus, cause: known.cause instanceof Error ? known.cause.name : undefined });
  }
  const body: ApiError = { error: known.message, code: known.code };
  return Response.json(body, { status: known.status, headers: { "Cache-Control": "no-store" } });
}
