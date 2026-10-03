#!/usr/bin/env bash
set -euo pipefail
source /workspace/hbase-spike/env.sh
if ! (set +o pipefail; printf 'list
' | "$HBASE_HOME/bin/hbase" shell -n 2>/dev/null | grep -q 'atlas_meta'); then
  printf "create 'atlas_meta','cf'\n" | "$HBASE_HOME/bin/hbase" shell -n
fi
records=(
'hive_table|analytics.sales|data-platform|2026-01-15T09:00:00Z'
'hive_table|analytics.customers|alice|2026-02-01T10:15:00Z'
'hive_table|raw.events|ingestion|2026-02-04T08:20:00Z'
'hive_table|prod.orders|bob|2026-02-11T14:30:00Z'
'hive_table|finance.transactions|finance-team|2026-02-20T16:00:00Z'
'hdfs_path|/data/warehouse/analytics.db/sales|data-platform|2026-01-15T08:45:00Z'
'hdfs_path|/data/raw/events|ingestion|2026-02-04T08:00:00Z'
'hdfs_path|/data/archive/cold/2024|archive-ops|2026-01-05T11:10:00Z'
'hdfs_path|/data/finance/transactions|finance-team|2026-02-20T15:40:00Z'
'hdfs_path|/data/archive/warm/orders|archive-ops|2026-02-12T09:00:00Z'
'hive_database|analytics|data-platform|2025-12-20T10:00:00Z'
'hive_database|finance|finance-team|2025-12-21T10:00:00Z'
'hive_database|raw|ingestion|2025-12-19T10:00:00Z'
'hive_database|archive|archive-ops|2025-12-18T10:00:00Z'
)
for record in "${records[@]}"; do
  IFS='|' read -r typ name owner created <<< "$record"
  row="$typ|$name"
  printf "put 'atlas_meta','%s','cf:type','%s'\nput 'atlas_meta','%s','cf:name','%s'\nput 'atlas_meta','%s','cf:owner','%s'\nput 'atlas_meta','%s','cf:qualifiedName','%s'\nput 'atlas_meta','%s','cf:createTime','%s'\n" "$row" "$typ" "$row" "$name" "$row" "$owner" "$row" "$name" "$row" "$created"
done | "$HBASE_HOME/bin/hbase" shell -n
printf 'scan "atlas_meta", {COLUMNS => ["cf:type", "cf:name", "cf:owner"]}\n' | "$HBASE_HOME/bin/hbase" shell -n
