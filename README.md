# HBase + Next.js Atlas metadata spike

A local, read-only catalog prototype over synthetic Hive and HDFS metadata in
standalone HBase. Search combines free text, exact type/owner, and a name substring;
CSV exports use the same filters. This spike does not connect to Apache Atlas or
provide ingestion, lineage, entity management, or production authentication.

## Prerequisites and setup

Use an existing checkout; cloud tasks already have an isolated environment and do
not need a Git worktree. Bootstrap supports Linux x86_64, Python 3.12+, `curl`, and
Node.js **24.19.0** with npm **11**. The root `.node-version` and `.nvmrc` pin Node.
Install Node using your supported version manager before running setup.

```sh
./setup.sh
./start.sh
./seed.sh
./webapp/start-dev.sh
```

`setup.sh` installs Temurin **11.0.32.1+1** and Apache HBase **2.5.11** from official
HTTPS archives, verifies publisher SHA-256/SHA-512 checksums before extraction,
and runs `npm ci` against the committed lockfile. Downloads are cached under
`downloads/`; npm's cache uses `${TMPDIR:-/tmp}/hbase-atlas-npm-cache`. Existing
cached archives are reverified. Setup is noninteractive and needs no credentials.
Use `./setup.sh --skip-npm` to prepare only Java/HBase. Stop the owned UI before
rerunning full setup so dependency refresh cannot race a running Next.js process.

The webapp pins Next.js **16.3.8**, React **19.2.8**, and TypeScript **7.0.2**.
Runtime distributions, generated configuration, local data, logs, and dependency
outputs are ignored; no application/lockfile changes are needed for setup.

Scripts derive the checkout directory and support paths containing spaces. They
invoke HBase's Java entrypoints directly with argument arrays because its upstream
shell launcher word-splits path-containing options. Configuration is generated in
`data/config/hbase-site.xml`, leaving the distribution's `hbase/conf` untouched.
Master uses a 512 MiB heap; REST and Thrift use 256 MiB each.

## Local services and isolation

Every configured listener binds to **127.0.0.1**, including master/region RPC,
ZooKeeper, all admin UIs, REST, Thrift, and the webapp. REST is configured read-only;
seed writes use the HBase shell locally. Thrift remains available for protocol
experiments and permits writes from local clients. Loopback is the access boundary;
do not expose this unauthenticated prototype through a public proxy.

| Service | Default port |
| --- | --- |
| Catalog UI | 3000 |
| HBase master UI / RPC | 16010 / 16000 |
| Region server UI / RPC | 16030 / 16020 |
| HBase REST / admin UI | 8080 / 8085 |
| HBase Thrift / admin UI | 9090 / 9095 |
| ZooKeeper | 2181 |

`start.sh` checks for port conflicts and waits for master UI, functioning REST
cluster status, and Thrift readiness. Starting twice reuses this checkout's owned
processes. A failed startup cleans up only processes started by that invocation.
`webapp/start-dev.sh` waits for the UI and injects the local REST URL.

Optional environment overrides must be consistent for setup/start/stop/seed/wipe:

| Variable | Purpose |
| --- | --- |
| `HBASE_DATA_DIR` | Dedicated local runtime directory (default `data/`) |
| `HBASE_PORT_OFFSET` | Add an integer offset to all default ports, including UI |
| `WEBAPP_PORT` | Override the resulting webapp port |
| `HBASE_START_TIMEOUT` | Readiness deadline in seconds, default 90, maximum 600 |
| `JAVA_HOME`, `HBASE_HOME` | Reuse explicitly supplied installations of the pinned versions |
| `HBASE_REST_URL`, `HBASE_TABLE` | Webapp backend override, default local REST and `atlas_meta` |

For a second isolated instance, select both a fresh dedicated data directory and
nonconflicting ports, for example `HBASE_DATA_DIR=/tmp/atlas-second-data` and
`HBASE_PORT_OFFSET=10000`. Overrides outside ignored repository directories should
stay outside the checkout. The webapp launcher always points to that instance's
local REST gateway.

Existing generated XML is checked and preserved. If you intentionally change ports
or need to repair local settings, stop services first and run
`./setup.sh --regenerate-config`; it saves a timestamped backup and merges the
required loopback/data settings while keeping unrelated properties. Do not edit
listener bindings to expose the services: startup rejects unsupported configuration.

### Migrating the original prototype

Before updating from the original scripts, stop its services with the old
`webapp/stop-dev.sh` and `stop.sh`; check that the old listeners have closed. Then
run `./setup.sh --adopt-runtime` after updating. This explicitly adopts an existing
`data/` containing only the known HBase/ZooKeeper/log/PID/config directories, retains
data, and generates separate secure configuration. Old PID-only files are never
trusted or signalled by the new scripts. If legacy processes remain, inspect their
logs/commands and stop them explicitly rather than deleting the evidence. Old
`hbase/conf` edits remain untouched.

## Seed and API examples

`seed-data.hbase` is the single authoritative **14-entity** fixture (five Hive
tables, four Hive databases, five HDFS paths). `seed.sh` creates a missing
`atlas_meta` table and writes the same row keys on subsequent runs. Reseeding does
not create duplicate entities; it restores fixture field values and retains
unrelated development rows. Use wipe first when an exact clean fixture is needed.

```sh
curl 'http://127.0.0.1:3000/api/search?q=sales&type=hive_table'
curl -OJ 'http://127.0.0.1:3000/api/export.csv?owner=data-platform&name=sales'
curl -H 'Accept: application/json' 'http://127.0.0.1:8080/atlas_meta/*?column=cf:type&column=cf:name&limit=100'
```

The first query matches `analytics.sales`; the second exports that Hive table and
its warehouse HDFS path. Filters use AND semantics; text matching is insensitive
to case. `docs/screenshots/` and `atlas_meta_export.csv` are historical fixture
samples, not live validation results. The API routes are `GET /api/search` and
`GET /api/export.csv` with `q`, `type`, `owner`, and `name` parameters.

## Stop, restart, wipe, and troubleshooting

```sh
./webapp/stop-dev.sh # stop only the UI
./stop.sh           # stop UI + gateways + HBase; retain data
./start.sh          # reuse data; seed only if desired
./wipe.sh           # stop all owned services and remove local data/logs/PIDs
```

Process records under `data/pids/` store checkout identity, Linux process birth
identity and command fingerprint. Stop refuses a live ownership mismatch, retains
its record, and never signals an unrelated stale PID. Stops wait for termination
and report failures. Wipe refuses shared/root/checkout paths, foreign runtime
ownership, and symlinked runtime directories; installations and configuration stay.

Read `data/logs/{master,rest,thrift,webapp}.out` for failures. A busy port is a
conflict, not evidence that this instance is running; stop its owner or use an
offset and separate data directory. A checksum failure requires replacing the bad
cached archive; verification is never disabled. An unknown/nonempty runtime
directory requires a fresh path or the documented explicit legacy adoption option.
The optional native Hadoop library warning is harmless: Java implementations work.

## Validation

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
cd webapp
npm test
npm run typecheck
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Root lifecycle tests use temporary fake services, including paths with spaces,
repeated start/stop/restart, port conflicts, failed-start cleanup, stale PID
refusal, configuration preservation, safe wipe, fixture count, and checksum
rejection. They need no Java downloads. Browser tests mock the API for deterministic
request-order and error cases; the real-service smoke test is to seed twice, check
14 REST rows, verify filtered search/CSV, confirm REST writes return 403, and
inspect `ss -ltnp` for loopback-only sockets. CI runs the automated checks.
