#!/usr/bin/env bash
# Source this file to use this checkout's isolated local runtime.
export HBASE_SPIKE_ROOT="${HBASE_SPIKE_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)}"
export JAVA_HOME="${JAVA_HOME:-$HBASE_SPIKE_ROOT/jdk-11.0.32.1+1}"
export HBASE_HOME="${HBASE_HOME:-$HBASE_SPIKE_ROOT/hbase}"
export HBASE_DATA_DIR="${HBASE_DATA_DIR:-$HBASE_SPIKE_ROOT/data}"
export HBASE_CONF_DIR="$HBASE_DATA_DIR/config"
export PATH="$JAVA_HOME/bin:$HBASE_HOME/bin:$PATH"
