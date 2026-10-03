#!/usr/bin/env bash
set -euo pipefail
/workspace/hbase-spike/stop.sh
rm -rf /workspace/hbase-spike/data/hbase /workspace/hbase-spike/data/zookeeper /workspace/hbase-spike/data/logs /workspace/hbase-spike/data/pids
echo "HBase local data and logs removed; tarballs and installations retained."
