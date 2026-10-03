#!/usr/bin/env python3
"""Linux local runtime: verified bootstrap, loopback configuration and owned processes."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
JDK_VERSION = "11.0.32.1+1"
HBASE_VERSION = "2.5.11"
JDK_URL = "https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz"
HBASE_URL = "https://archive.apache.org/dist/hbase/2.5.11/hbase-2.5.11-bin.tar.gz"


def fail(message):
    raise RuntimeError(message)


class Runtime:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.data = Path(os.environ.get("HBASE_DATA_DIR", self.root / "data")).absolute()
        self.java = Path(os.environ.get("JAVA_HOME", self.root / f"jdk-{JDK_VERSION}"))
        self.hbase = Path(os.environ.get("HBASE_HOME", self.root / "hbase"))
        self.offset = int(os.environ.get("HBASE_PORT_OFFSET", "0"))
        self.ports = {"zk": 2181, "master": 16000, "master-ui": 16010, "region": 16020,
                      "region-ui": 16030, "rest": 8080, "rest-ui": 8085,
                      "thrift": 9090, "thrift-ui": 9095, "webapp": 3000}
        self.ports = {name: port + self.offset for name, port in self.ports.items()}
        self.ports["webapp"] = int(os.environ.get("WEBAPP_PORT", self.ports["webapp"]))
        if len(set(self.ports.values())) != len(self.ports) or any(p < 1024 or p > 65535 for p in self.ports.values()):
            fail("Ports must be distinct and between 1024 and 65535")
        self.timeout = float(os.environ.get("HBASE_START_TIMEOUT", "90"))
        if not 0 < self.timeout <= 600:
            fail("HBASE_START_TIMEOUT must be between 0 and 600 seconds")
        self.conf = self.data / "config"
        self.children = {}

    def safe_data(self):
        resolved = self.data.resolve()
        if self.data.is_symlink() or resolved == Path.home() or resolved == self.root or resolved in self.root.parents:
            fail(f"Refusing unsafe runtime directory: {self.data}")
        # An override must identify a dedicated directory, never a shared system tree.
        if resolved in (Path("/tmp"), Path("/workspace"), Path("/var"), Path("/usr"), Path("/home")):
            fail(f"Refusing shared runtime directory: {self.data}")
        for name in ("hbase", "zookeeper", "logs", "pids", "config", ".atlas-runtime-owner", ".lifecycle.lock"):
            if (self.data / name).is_symlink():
                fail(f"Refusing symlinked runtime child: {name}")

    def initialize(self, adopt=False):
        self.safe_data()
        self.data.mkdir(parents=True, exist_ok=True)
        marker = self.data / ".atlas-runtime-owner"
        if marker.exists():
            if marker.read_text().strip() != str(self.root):
                fail("Runtime directory belongs to another checkout")
        else:
            # Never claim somebody else's existing data/configuration.
            existing = {p.name for p in self.data.iterdir()}
            if existing and (not adopt or not existing <= {"hbase", "zookeeper", "logs", "pids", "config"}):
                fail("Runtime directory is nonempty and unowned; select a new HBASE_DATA_DIR, or explicitly migrate known local data using setup --adopt-runtime")
            marker.write_text(str(self.root) + "\n")
        for name in ("hbase", "zookeeper", "logs", "pids", "config"):
            (self.data / name).mkdir(exist_ok=True)

    def properties(self):
        p = self.ports
        return {
            "hbase.rootdir": "file://" + str((self.data / "hbase").resolve()),
            "hbase.zookeeper.property.dataDir": str((self.data / "zookeeper").resolve()),
            "hbase.cluster.distributed": "false", "hbase.unsafe.stream.capability.enforce": "false",
            "hbase.zookeeper.quorum": "127.0.0.1", "hbase.zookeeper.property.clientPortAddress": "127.0.0.1",
            "hbase.zookeeper.property.clientPort": str(p["zk"]),
            "hbase.master.ipc.address": "127.0.0.1", "hbase.regionserver.ipc.address": "127.0.0.1",
            "hbase.master.hostname": "localhost", "hbase.unsafe.regionserver.hostname": "localhost",
            "hbase.master.port": str(p["master"]), "hbase.regionserver.port": str(p["region"]),
            "hbase.master.info.bindAddress": "127.0.0.1", "hbase.master.info.port": str(p["master-ui"]),
            "hbase.regionserver.info.bindAddress": "127.0.0.1", "hbase.regionserver.info.port": str(p["region-ui"]),
            "hbase.regionserver.info.port.auto": "false",
            "hbase.rest.host": "127.0.0.1", "hbase.rest.port": str(p["rest"]), "hbase.rest.readonly": "true",
            "hbase.rest.info.bindAddress": "127.0.0.1", "hbase.rest.info.port": str(p["rest-ui"]),
            "hbase.regionserver.thrift.ipaddress": "127.0.0.1", "hbase.regionserver.thrift.port": str(p["thrift"]),
            "hbase.thrift.info.bindAddress": "127.0.0.1", "hbase.thrift.info.port": str(p["thrift-ui"]),
        }

    def configure(self, regenerate=False):
        site = self.conf / "hbase-site.xml"
        expected = self.properties()
        if site.exists():
            entries = ET.parse(site).getroot().findall("property")
            current = {x.findtext("name"): x.findtext("value") for x in entries}
            mismatch = len(current) != len(entries) or any(current.get(k) != v for k, v in expected.items())
            if mismatch and not regenerate:
                fail("Existing hbase-site.xml differs from required local settings; preserved. Use setup --regenerate-config to back up and merge required settings")
            if not mismatch:
                return
            backup = site.with_name(f"hbase-site.xml.backup-{time.time_ns()}")
            shutil.copy2(site, backup)
            expected = {**current, **expected}
            print(f"Previous configuration preserved at {backup}")
        if not site.exists() or regenerate:
            tree = ET.Element("configuration")
            for key, value in expected.items():
                prop = ET.SubElement(tree, "property")
                ET.SubElement(prop, "name").text = key
                ET.SubElement(prop, "value").text = value
            ET.indent(tree)
            ET.ElementTree(tree).write(site, encoding="utf-8", xml_declaration=True)
        logging = self.conf / "log4j2.properties"
        if not logging.exists() and (self.hbase / "conf/log4j2.properties").exists():
            shutil.copyfile(self.hbase / "conf/log4j2.properties", logging)

    def java_command(self, service):
        # HBase's shell launcher word-splits Java options and fails for paths containing
        # spaces. Invoke its documented Java entrypoints with an argument array instead.
        cp = [str(self.conf), str(self.hbase)]
        directories = ["lib", "lib/client-facing-thirdparty"] + (["lib/ruby"] if service == "shell" else [])
        cp += [str(p) for directory in directories
               for p in sorted((self.hbase / directory).glob("*.jar"))]
        classes = {"master": "org.apache.hadoop.hbase.master.HMaster",
                   "rest": "org.apache.hadoop.hbase.rest.RESTServer",
                   "thrift": "org.apache.hadoop.hbase.thrift.ThriftServer",
                   "shell": "org.jruby.JarBootstrapMain"}
        heap = "512m" if service in ("master", "shell") else "256m"
        command = [str(self.java / "bin/java"), "-Xms128m", f"-Xmx{heap}",
                   f"-Datlas.runtime.root={self.root}", f"-Datlas.runtime.service={service}",
                   f"-Dhbase.log.dir={self.data / 'logs'}", f"-Dhbase.log.file={service}.log",
                   f"-Dhbase.home.dir={self.hbase}", "-Dhbase.root.logger=INFO,console",
                   "-Djava.util.logging.config.class=org.apache.hadoop.hbase.logging.JulToSlf4jInitializer",
                   "-cp", os.pathsep.join(cp), classes[service]]
        if service == "rest":
            return command + ["start", "-ro"]
        if service == "thrift":
            return command + ["-b", "127.0.0.1", "start"]
        if service == "shell":
            return command + ["-n"]
        return command + ["start"]

    def record_path(self, name):
        return self.data / "pids" / f"{name}.json"

    def owned(self, name):
        path = self.record_path(name)
        if path.is_symlink():
            fail(f"Refusing symlinked process record: {path}")
        if not path.exists():
            return None
        try:
            record = json.loads(path.read_text())
            pid = record["pid"]
            state = process_identity(pid)
            if record["root"] != str(self.root):
                fail(f"Process record {path} belongs to another checkout")
            if state is None:
                if group_alive(pid):
                    fail(f"{name} leader exited but its process group remains; record retained for inspection")
                return None
            if not self.belongs(name, pid) or state != record["identity"] or os.getpgid(pid) != pid:
                fail(f"Refusing process ownership mismatch for {name}; preserve {path} for inspection")
            return record
        except (ValueError, KeyError, TypeError) as error:
            fail(f"Invalid process record {path}: {error}")

    def belongs(self, name, pid):
        try:
            argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            return False
        if name == "webapp":
            return str(self.root / "webapp/node_modules/next/dist/bin/next").encode() in argv
        return (f"-Datlas.runtime.root={self.root}".encode() in argv and
                f"-Datlas.runtime.service={name}".encode() in argv)

    def ensure_ports_free(self, names):
        for name in names:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    sock.bind(("127.0.0.1", self.ports[name]))
                except OSError:
                    fail(f"Port {self.ports[name]} ({name}) is occupied; refusing to adopt an unrelated service")

    def spawn(self, name, command):
        env = os.environ.copy()
        env.update({"JAVA_HOME": str(self.java), "HBASE_HOME": str(self.hbase), "HBASE_CONF_DIR": str(self.conf),
                    "HBASE_REST_URL": f"http://127.0.0.1:{self.ports['rest']}", "JRUBY_OPTS": "-X+O"})
        log = self.data / "logs" / f"{name}.out"
        with log.open("ab") as output:
            process = subprocess.Popen(command, cwd=self.root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        self.children[name] = process
        # The exec handshake can return while /proc still briefly exposes the
        # pre-exec command. Capture the fingerprint only after our instance arguments
        # appear, rather than persisting that transient inherited command.
        deadline = time.monotonic() + 2
        while process.poll() is None and not self.belongs(name, process.pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        if process.poll() is not None:
            fail(f"{name} exited immediately; see {log}")
        if not self.belongs(name, process.pid):
            process.terminate()
            process.wait(timeout=2)
            fail(f"{name} did not establish process identity; see {log}")
        identity = process_identity(process.pid)
        if identity is None:
            fail(f"{name} exited immediately; see {log}")
        record = {"pid": process.pid, "root": str(self.root), "identity": identity}
        self.record_path(name).write_text(json.dumps(record))

    def wait_ready(self, name, check):
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if not self.owned(name):
                fail(f"{name} exited; see {self.data / 'logs' / (name + '.out')}")
            try:
                if check():
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        fail(f"{name} readiness timed out; see {self.data / 'logs' / (name + '.out')}")

    def http(self, path, port, json_body=False):
        request = urllib.request.Request(f"http://127.0.0.1:{self.ports[port]}{path}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=2) as response:
            return json.load(response) if json_body else response.status == 200

    def start(self):
        if not (self.java / "bin/java").is_file() or not (self.hbase / "lib").is_dir():
            fail("Missing Java/HBase runtime; run ./setup.sh")
        self.configure()
        started = []
        try:
            for name, ports, check in (
                ("master", ["zk", "master", "master-ui", "region", "region-ui"], lambda: self.http("/", "master-ui")),
                ("rest", ["rest", "rest-ui"], lambda: bool(self.http("/status/cluster", "rest", True).get("LiveNodes"))),
                ("thrift", ["thrift", "thrift-ui"], lambda: self.http("/", "thrift-ui") and port_open(self.ports["thrift"])),
            ):
                if not self.owned(name):
                    self.ensure_ports_free(ports)
                    self.spawn(name, self.java_command(name))
                    started.append(name)
                self.wait_ready(name, check)
        except Exception:
            for name in reversed(started):
                self.stop_one(name)
            raise
        print(f"HBase ready: REST http://127.0.0.1:{self.ports['rest']}; master UI http://127.0.0.1:{self.ports['master-ui']}")

    def stop_one(self, name):
        record = self.owned(name)
        path = self.record_path(name)
        if not record:
            path.unlink(missing_ok=True)
            if name in self.children:
                self.children.pop(name).wait(timeout=2)
            return
        pid = record["pid"]
        # Dedicated process group includes Next's worker; never signal a PID-only file.
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process_identity(pid) is None and not group_alive(pid):
                path.unlink(missing_ok=True)
                if name in self.children:
                    self.children.pop(name).wait(timeout=2)
                return
            time.sleep(0.1)
        fail(f"{name} did not stop; process record retained; inspect its log before retrying")

    def stop(self):
        for name in ("webapp", "thrift", "rest", "master"):
            self.stop_one(name)
        print("All owned services stopped; data retained.")

    def wipe(self):
        self.safe_data()
        self.stop()
        for name in ("hbase", "zookeeper", "logs", "pids"):
            shutil.rmtree(self.data / name)
            (self.data / name).mkdir()
        print("Local HBase/ZooKeeper data, logs and PID records removed; installations/config retained.")

    def web_start(self):
        if not self.owned("webapp"):
            self.ensure_ports_free(["webapp"])
            next_cli = self.root / "webapp/node_modules/next/dist/bin/next"
            if not next_cli.is_file():
                fail("Missing Next.js dependencies; run ./setup.sh")
            self.spawn("webapp", ["node", str(next_cli), "dev", str(self.root / "webapp"),
                                   "--hostname", "127.0.0.1", "--port", str(self.ports["webapp"])])
        try:
            self.wait_ready("webapp", lambda: self.http("/", "webapp"))
        except Exception:
            self.stop_one("webapp")
            raise
        print(f"UI ready: http://127.0.0.1:{self.ports['webapp']}")

    def seed(self):
        self.configure()
        fixture = self.root / "seed-data.hbase"
        with fixture.open("rb") as source:
            subprocess.run(self.java_command("shell"), cwd=self.root, stdin=source, check=True,
                           env={**os.environ, "JRUBY_OPTS": "-X+O"})
        print("Seeded 14 fixture entities; existing unrelated rows retained.")


def process_identity(pid):
    if not isinstance(pid, int) or pid <= 1:
        fail("Invalid PID in process record")
    try:
        raw = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if raw[0] == "Z":
            return None
        command = Path(f"/proc/{pid}/cmdline").read_bytes()
        return {"birth": raw[19], "command": hashlib.sha256(command).hexdigest()}
    except FileNotFoundError:
        return None


def group_alive(group):
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")", 1)[1].split()
            if fields[0] != "Z" and int(fields[2]) == group:
                return True
        except (FileNotFoundError, ProcessLookupError):
            pass
    return False


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def download_verified(url, target, algorithm, suffix):
    """Reverify cached artifacts against the publisher's TLS-protected checksum."""
    checksum = subprocess.check_output(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "2", url + suffix], text=True)
    width = hashlib.new(algorithm).digest_size * 2
    # Apache prints groups separated by whitespace after `filename:`, Adoptium a hex token.
    expected = "".join(checksum.split(":", 1)[-1].split()) if ":" in checksum else checksum.split()[0]
    if not re.fullmatch(rf"[0-9a-fA-F]{{{width}}}", expected):
        fail("Publisher checksum has an unexpected format")
    if not target.exists():
        partial = target.with_suffix(target.suffix + ".part")
        subprocess.run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "2", "--output", str(partial), url], check=True)
        partial.replace(target)
    with target.open("rb") as source:
        actual = hashlib.file_digest(source, algorithm).hexdigest()
    if actual.lower() != expected.lower():
        fail(f"Checksum mismatch for {target}; remove the bad archive before retrying")


def extract_verified(archive, destination, top):
    with tarfile.open(archive) as bundle:
        # Python 3.12's data filter preserves harmless links inside official distributions.
        bundle.extractall(destination, filter="data")
    if not (destination / top).is_dir():
        fail("Verified archive did not contain the expected distribution")


def setup(runtime, skip_npm=False, regenerate=False):
    if not skip_npm and runtime.owned("webapp"):
        fail("Stop the owned webapp with ./webapp/stop-dev.sh before refreshing dependencies")
    if sys.platform != "linux" or os.uname().machine != "x86_64" or sys.version_info < (3, 12):
        fail("Bootstrap requires Linux x86_64 and Python 3.12+ (safe archive extraction)")
    for command in ("curl", "node", "npm"):
        if not shutil.which(command):
            fail(f"Install prerequisite {command} before running setup")
    node_major = int(subprocess.check_output(["node", "-p", "process.versions.node.split('.')[0]"], text=True))
    if node_major != 24:
        fail("Use Node.js 24 before setup (for example your supported node version manager)")
    downloads = runtime.root / "downloads"
    downloads.mkdir(exist_ok=True)
    for url, archive, algo, suffix, top, destination in (
        (JDK_URL, f"jdk-{JDK_VERSION}.tar.gz", "sha256", ".sha256.txt", f"jdk-{JDK_VERSION}", runtime.java),
        (HBASE_URL, f"hbase-{HBASE_VERSION}.tar.gz", "sha512", ".sha512", f"hbase-{HBASE_VERSION}", runtime.hbase),
    ):
        # Explicitly supplied external installations are checked, never downloaded over.
        default_destination = runtime.root / (f"jdk-{JDK_VERSION}" if algo == "sha256" else "hbase")
        if destination != default_destination:
            if not destination.is_dir():
                fail(f"Explicit runtime override is missing: {destination}")
            continue
        download_verified(url, downloads / archive, algo, suffix)
        if not destination.exists():
            staging = downloads / (top + ".extract")
            if staging.exists():
                shutil.rmtree(staging)
            staging.mkdir()
            extract_verified(downloads / archive, staging, top)
            shutil.move(str(staging / top), destination)
            shutil.rmtree(staging)
    version = subprocess.run([str(runtime.java / "bin/java"), "-version"], capture_output=True, text=True, check=True)
    if '"11.0.32.1"' not in version.stderr:
        fail("Java override must provide the pinned supported JDK 11.0.32.1")
    if not (runtime.hbase / f"lib/hbase-common-{HBASE_VERSION}.jar").is_file():
        fail(f"HBase override must provide the pinned supported HBase {HBASE_VERSION}")
    if regenerate and any(runtime.owned(name) for name in ("master", "rest", "thrift", "webapp")):
        fail("Stop all owned services before regenerating configuration")
    runtime.configure(regenerate)
    if not skip_npm:
        subprocess.run(["npm", "ci", "--cache", str(Path(os.environ.get("TMPDIR", "/tmp")) / "hbase-atlas-npm-cache")], cwd=runtime.root / "webapp", check=True)
    print("Setup ready. Run ./start.sh, ./seed.sh, then ./webapp/start-dev.sh.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["setup", "start", "stop", "wipe", "seed", "web-start", "web-stop"])
    parser.add_argument("--skip-npm", action="store_true", help="bootstrap Java/HBase only")
    parser.add_argument("--adopt-runtime", action="store_true", help="explicitly adopt legacy local data during setup; never signals legacy PID files")
    parser.add_argument("--regenerate-config", action="store_true", help="back up existing config and merge required local settings during setup")
    args = parser.parse_args()
    if args.action != "setup" and (args.adopt_runtime or args.regenerate_config or args.skip_npm):
        parser.error("setup options require the setup action")
    runtime = Runtime()
    runtime.initialize(args.adopt_runtime)
    with (runtime.data / ".lifecycle.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == "setup":
            setup(runtime, args.skip_npm, args.regenerate_config)
        else:
            actions = {"start": runtime.start, "stop": runtime.stop, "wipe": runtime.wipe,
                       "seed": runtime.seed, "web-start": runtime.web_start,
                       "web-stop": lambda: runtime.stop_one("webapp")}
            actions[args.action]()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError, ET.ParseError) as error:
        detail = f"{Path(error.cmd[0]).name} exited with status {error.returncode}" if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"Runtime error: {detail}", file=sys.stderr)
        sys.exit(1)
