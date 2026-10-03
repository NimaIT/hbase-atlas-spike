#!/usr/bin/env bash
set -u
pidfile=/workspace/hbase-spike/data/pids/webapp.pid
if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
echo "Webapp stopped."
