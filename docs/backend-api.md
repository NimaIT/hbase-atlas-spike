# Bounded local catalog API

Search and CSV export read one complete, bounded HBase catalog snapshot. Search
applies conjunctive, case-insensitive filters and sorts by row key. `q` searches
type, name, owner and qualified name; `type` and `owner` match exactly; `name`
matches a substring. Filters are trimmed and limited to 256 characters; duplicate
filter keys and control characters return HTTP 400.

`GET /api/search` returns `{ results, count, types }`. `types` lists distinct types
from the complete catalog, even when the current filters match no rows. The
shared TypeScript shapes are in `webapp/lib-contracts.ts`.

| Server environment variable | Default | Maximum |
| --- | --- | --- |
| `HBASE_MAX_ROWS` | 1,000 | 10,000 |
| `HBASE_MAX_RESPONSE_BYTES` | 4 MiB | 16 MiB |
| `HBASE_TIMEOUT_MS` | 10,000 ms | 60,000 ms |

Limits must be positive integers. The REST URL defaults to
`http://127.0.0.1:8080`; `HBASE_REST_URL` accepts HTTP/HTTPS base paths without
credentials, query strings or fragments. `HBASE_TABLE` defaults to `atlas_meta`
and accepts table/namespace identifiers rather than URL paths.

HBase wildcard scans use the supported `limit` parameter set to the configured
row limit plus one. The extra row detects overflow. An oversized catalog returns
HTTP 503 with `CATALOG_TOO_LARGE`; neither search nor export returns a partial
catalog. This intentionally suits the local spike. Larger catalogs need a
separate paginated/indexed design rather than simply increasing these limits.
Response bytes are bounded as they are read, and the deadline covers headers and
body consumption. Client cancellation aborts upstream work.

Responses use `{ error, code }` for errors. Upstream failures return 502, deadlines
return 504, invalid server configuration returns 503 and cancelled requests use
499. Raw upstream exceptions and response bodies are excluded from API replies;
server diagnostics record error codes and failure classes. Both search and export
should use `parseFilters` and `apiErrorResponse` from `webapp/lib-api.ts`.
