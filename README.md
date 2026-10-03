# HBase + Next.js Atlas metadata spike

Local throwaway prototype under /workspace/hbase-spike. No Docker or cloud VM.
## Installed versions

- Temurin JDK 11.0.32.1+1 at jdk-11.0.32.1+1/
- Apache HBase 2.5.11 at hbase/
- Node.js v20.19.2; npx reports 9.2.0
- Next.js 16.3.4, React 19.2.8, TypeScript 7.0.2

## Ports

- UI: http://127.0.0.1:3000
- Master UI: http://127.0.0.1:16010
- Thrift: 127.0.0.1:9090
- REST: 127.0.0.1:8080
- Thrift admin: 9095; REST admin: 8085; ZooKeeper: 2181

HBase is standalone (hbase.cluster.distributed=false), with local data at data/hbase, 512 MiB master/region-server heap, and 256 MiB Thrift/REST gateway heaps.
## Thrift vs REST

Both gateways are started, so Thrift is available on 9090. The Next.js API uses HBase REST at http://127.0.0.1:8080 with Accept: application/json. REST was selected for this spike because it avoids an unmaintained/generated Thrift binding and works with Node built-in fetch. Set HBASE_REST_URL to override the base URL.

## Run and stop

From this directory:

./start.sh
 ./seed.sh
 ./webapp/start-dev.sh
 ./webapp/stop-dev.sh
 ./stop.sh

The API routes are GET /api/search?q=...&type=...&owner=...&name=... and GET /api/export.csv?... .
## Curl examples

curl 'http://127.0.0.1:3000/api/search?q=sales&type=hive_table'
curl -OJ 'http://127.0.0.1:3000/api/export.csv?owner=data-platform&name=sales'
curl -H 'Accept: application/json' 'http://127.0.0.1:8080/atlas_meta/*?column=cf:type&column=cf:name'

## Teardown and restart

./stop.sh stops services and retains data.
./wipe.sh stops services and removes HBase data, ZooKeeper data, logs, and PID files; installations remain.
To free RAM, run ./webapp/stop-dev.sh then ./stop.sh. Later run ./start.sh, ./seed.sh if needed, and ./webapp/start-dev.sh.

## Paths

HBase config: hbase/conf/hbase-site.xml and hbase/conf/hbase-env.sh
Data/logs/PIDs: data/
Seed: seed.sh and seed-data.hbase
Webapp: webapp/
Lifecycle: start.sh, stop.sh, wipe.sh, webapp/start-dev.sh, webapp/stop-dev.sh
## Status and blockers

Build passed; search and CSV endpoints were smoke-tested successfully. Current RAM after startup: 1.0 GiB free and 3.9 GiB available out of 15 GiB, with no swap. No OOMs or download failures. HBase only warns that the optional native Hadoop library is unavailable; the Java fallback works. Seed count: 20 rows.
