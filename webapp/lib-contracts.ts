export type Entity = {
  rowKey: string;
  type: string;
  name: string;
  owner: string;
  qualifiedName: string;
  createTime: string;
};

export type SearchFilters = { q?: string; type?: string; owner?: string; name?: string };
export type SearchResponse = { results: Entity[]; count: number; types: string[] };
export type ApiError = { error: string; code: string };
