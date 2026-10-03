#!/usr/bin/env bash
set -euo pipefail
export HBASE_SPIKE_ROOT="/workspace/hbase-spike"
export JAVA_HOME="$HBASE_SPIKE_ROOT/jdk-11.0.32.1+1"
export HBASE_HOME="$HBASE_SPIKE_ROOT/hbase"
export PATH="$JAVA_HOME/bin:$HBASE_HOME/bin:$PATH"
export HBASE_CONF_DIR="$HBASE_HOME/conf"
mkdir -p "$HBASE_SPIKE_ROOT/data/logs" "$HBASE_SPIKE_ROOT/data/pids" "$HBASE_SPIKE_ROOT/data/hbase" "$HBASE_SPIKE_ROOT/data/zookeeper"
