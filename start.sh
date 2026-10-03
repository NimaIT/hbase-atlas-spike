#!/usr/bin/env bash
set -euo pipefail
source /workspace/hbase-spike/env.sh
if ! "$HBASE_HOME/bin/hbase-daemon.sh" status master >/dev/null 2>&1; then "$HBASE_HOME/bin/start-hbase.sh"; fi
for i in $(seq 1 60); do if "$JAVA_HOME/bin/jps" 2>/dev/null | grep -q HMaster; then break; fi; sleep 1; done
if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':9090$'; then nohup "$HBASE_HOME/bin/hbase" thrift start >"$HBASE_SPIKE_ROOT/data/logs/thrift.out" 2>&1 & echo $! > "$HBASE_SPIKE_ROOT/data/pids/thrift.pid"; fi
if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8080$'; then nohup "$HBASE_HOME/bin/hbase" rest start >"$HBASE_SPIKE_ROOT/data/logs/rest.out" 2>&1 & echo $! > "$HBASE_SPIKE_ROOT/data/pids/rest.pid"; fi
echo "HBase master/UI: http://127.0.0.1:16010"
echo "HBase Thrift: 127.0.0.1:9090"
echo "HBase REST: 127.0.0.1:8080"
