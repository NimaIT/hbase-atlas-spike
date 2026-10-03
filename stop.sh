#!/usr/bin/env bash
set -u
source /workspace/hbase-spike/env.sh
for svc in thrift rest; do pidfile="$HBASE_SPIKE_ROOT/data/pids/$svc.pid"; if [ -f "$pidfile" ]; then pid=$(python3 -c "print(open(\"$pidfile\").read().strip())"); kill "$pid" 2>/dev/null || true; rm -f "$pidfile"; fi; done
"$HBASE_HOME/bin/stop-hbase.sh" 2>/dev/null || true
echo "HBase services stopped (data retained)."
