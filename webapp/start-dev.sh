#!/usr/bin/env bash
set -euo pipefail
cd /workspace/hbase-spike/webapp
mkdir -p /workspace/hbase-spike/data/logs /workspace/hbase-spike/data/pids
if [ -f /workspace/hbase-spike/data/pids/webapp.pid ] && kill -0 "$(cat /workspace/hbase-spike/data/pids/webapp.pid)" 2>/dev/null; then echo "webapp already running"; exit 0; fi
nohup ./node_modules/.bin/next dev --hostname 127.0.0.1 > /workspace/hbase-spike/data/logs/webapp.out 2>&1 &
echo $! > /workspace/hbase-spike/data/pids/webapp.pid
echo "UI: http://127.0.0.1:3000"
