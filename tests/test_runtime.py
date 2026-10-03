"""Regress lifecycle ownership and configuration using real isolated fake services."""
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("runtime", Path(__file__).parents[1] / "scripts/runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

FAKE_JAVA = '#!' + sys.executable + r'''

import http.server,json,os,pathlib,socket,sys,threading,time,xml.etree.ElementTree as ET
service=next(a.split('=',1)[1] for a in sys.argv if a.startswith('-Datlas.runtime.service='))
conf=pathlib.Path(sys.argv[sys.argv.index('-cp')+1].split(':')[0])
values={p.findtext('name'):p.findtext('value') for p in ET.parse(conf/'hbase-site.xml').getroot()}
if service==os.environ.get('FAKE_FAIL_SERVICE'): sys.exit(17)
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'LiveNodes':[{'name':'local'}]}).encode())
 def log_message(self,*args): pass
names={'master':['hbase.master.info.port'],'rest':['hbase.rest.port','hbase.rest.info.port'],
       'thrift':['hbase.regionserver.thrift.port','hbase.thrift.info.port']}[service]
for name in names:
 server=http.server.ThreadingHTTPServer(('127.0.0.1',int(values[name])),Handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
while True: time.sleep(0.1)
'''


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="atlas checkout with spaces ")
        self.root = Path(self.temp.name)
        (self.root / "fake-java/bin").mkdir(parents=True)
        java = self.root / "fake-java/bin/java"
        java.write_text(FAKE_JAVA)
        java.chmod(0o755)
        (self.root / "hbase/lib").mkdir(parents=True)
        for _ in range(100):
            offset = random.randint(10000, 25000)
            ports = [n + offset for n in (2181,16000,16010,16020,16030,8080,8085,9090,9095,3000)]
            try:
                sockets = []
                for port in ports:
                    sock = socket.socket(); sockets.append(sock); sock.bind(("127.0.0.1",port))
                break
            except OSError:
                pass
            finally:
                for sock in sockets: sock.close()
        self.environment = patch.dict(os.environ, {"JAVA_HOME": str(self.root / "fake-java"),
            "HBASE_HOME": str(self.root / "hbase"), "HBASE_DATA_DIR": str(self.root / "data"),
            "HBASE_PORT_OFFSET": str(offset), "HBASE_START_TIMEOUT": "2"})
        self.environment.start()
        self.rt = runtime.Runtime(self.root)
        java_command = self.rt.java_command
        self.rt.java_command = lambda service: [sys.executable, str(java)] + java_command(service)[1:]
        self.rt.initialize()
        self.rt.configure()

    def tearDown(self):
        try: self.rt.stop()
        except RuntimeError: pass
        for child in self.rt.children.values():
            if child.poll() is None:
                child.terminate(); child.wait(timeout=2)
        self.environment.stop()
        self.temp.cleanup()

    def test_start_twice_stop_and_restart_with_spaces(self):
        self.rt.start()
        first = [self.rt.owned(name)["pid"] for name in ("master","rest","thrift")]
        self.rt.start()
        self.assertEqual(first, [self.rt.owned(name)["pid"] for name in ("master","rest","thrift")])
        sentinel = self.rt.data / "hbase/retained"
        sentinel.write_text("development data")
        self.rt.stop()
        self.assertEqual(sentinel.read_text(), "development data")
        self.rt.start()
        self.assertNotEqual(first[0], self.rt.owned("master")["pid"])

    def test_port_conflict_does_not_adopt_or_kill_other_service(self):
        with socket.socket() as unrelated:
            unrelated.bind(("127.0.0.1",self.rt.ports["master"]))
            unrelated.listen()
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                self.rt.start()
            self.assertIsNone(self.rt.owned("master"))
            self.assertGreater(unrelated.fileno(), -1)

    def test_stale_pid_birth_mismatch_cannot_signal_unrelated_process(self):
        other = subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"],start_new_session=True)
        try:
            identity = runtime.process_identity(other.pid)
            identity["birth"] = "wrong-birth"
            record = {"pid":other.pid,"root":str(self.root),"identity":identity}
            self.rt.record_path("rest").write_text(json.dumps(record))
            with self.assertRaisesRegex(RuntimeError,"ownership mismatch"):
                self.rt.stop_one("rest")
            self.assertIsNone(other.poll())
            self.assertTrue(self.rt.record_path("rest").exists())
        finally:
            other.terminate(); other.wait()
            self.rt.record_path("rest").unlink()

    def test_old_pid_only_file_never_signals_process(self):
        legacy = self.rt.data / "pids/rest.pid"
        legacy.write_text(str(os.getpid()))
        self.rt.stop()
        self.assertTrue(legacy.exists())

    def test_failed_start_cleans_up_new_services(self):
        with patch.dict(os.environ, {"FAKE_FAIL_SERVICE":"rest"}):
            with self.assertRaisesRegex(RuntimeError,"rest exited"):
                self.rt.start()
        self.assertIsNone(self.rt.owned("master"))
        self.assertIsNone(self.rt.owned("rest"))
        self.assertTrue((self.rt.data / "logs/rest.out").exists())

    def test_configuration_loopback_readonly_and_preservation(self):
        site = self.rt.conf / "hbase-site.xml"
        tree = ET.parse(site); root = tree.getroot()
        props = {p.findtext("name"):p.findtext("value") for p in root}
        for key in ("hbase.master.ipc.address","hbase.regionserver.ipc.address","hbase.rest.host",
                    "hbase.master.info.bindAddress","hbase.regionserver.info.bindAddress",
                    "hbase.rest.info.bindAddress","hbase.thrift.info.bindAddress",
                    "hbase.zookeeper.property.clientPortAddress"):
            self.assertEqual(props[key],"127.0.0.1")
        self.assertEqual(props["hbase.rest.readonly"],"true")
        prop = ET.SubElement(root,"property"); ET.SubElement(prop,"name").text="user.option"
        ET.SubElement(prop,"value").text="preserved"
        root.find("property/value").text="file:///unsafe"
        tree.write(site)
        old = site.read_bytes()
        with self.assertRaisesRegex(RuntimeError,"preserved"):
            self.rt.configure()
        self.assertEqual(site.read_bytes(),old)
        self.rt.configure(regenerate=True)
        self.assertEqual(next(self.rt.conf.glob("*.backup-*")).read_bytes(),old)
        props={p.findtext("name"):p.findtext("value") for p in ET.parse(site).getroot()}
        self.assertEqual(props["user.option"],"preserved")
        self.assertEqual(props["hbase.rootdir"],self.rt.properties()["hbase.rootdir"])

    def test_safe_wipe_stops_services_and_refuses_symlink(self):
        self.rt.start()
        (self.rt.data / "hbase/fixture").write_text("test")
        cli=self.root / "webapp/node_modules/next/dist/bin/next"
        cli.parent.mkdir(parents=True)
        cli.write_text("import time; time.sleep(60)")
        self.rt.spawn("webapp", [sys.executable,str(cli)])
        web_pid=self.rt.owned("webapp")["pid"]
        self.rt.wipe()
        self.assertIsNone(runtime.process_identity(web_pid))
        self.assertFalse((self.rt.data / "hbase/fixture").exists())
        self.assertTrue((self.rt.conf / "hbase-site.xml").exists())
        (self.rt.data / "logs").rmdir()
        (self.rt.data / "logs").symlink_to(self.root)
        with self.assertRaisesRegex(RuntimeError,"symlinked"):
            self.rt.wipe()
        (self.rt.data / "logs").unlink(); (self.rt.data / "logs").mkdir()
        with patch.dict(os.environ, {"HBASE_DATA_DIR":str(self.root)}):
            with self.assertRaisesRegex(RuntimeError,"unsafe"):
                runtime.Runtime(self.root).initialize()

    def test_legacy_data_requires_explicit_adoption(self):
        legacy = self.root / "legacy"
        (legacy / "hbase").mkdir(parents=True)
        with patch.dict(os.environ,{"HBASE_DATA_DIR":str(legacy)}):
            instance=runtime.Runtime(self.root)
            with self.assertRaisesRegex(RuntimeError,"unowned"):
                instance.initialize()
            instance.initialize(adopt=True)
            instance.configure()
        self.assertTrue((legacy / ".atlas-runtime-owner").exists())

    def test_fixture_single_source_fourteen_entities(self):
        repo=Path(__file__).parents[1]
        fixture=(repo / "seed-data.hbase").read_text()
        keys=re.findall(r"^put 'atlas_meta','([^']+)'",fixture,re.M)
        self.assertEqual(len(keys),70)
        self.assertEqual(len(set(keys)),14)
        self.assertIn("unless exists 'atlas_meta'",fixture)
        self.assertNotIn("records=(",(repo / "seed.sh").read_text())

    def test_forged_current_pid_record_cannot_signal_unrelated_command(self):
        other=subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"],start_new_session=True)
        try:
            record={"pid":other.pid,"root":str(self.root),"identity":runtime.process_identity(other.pid)}
            self.rt.record_path("rest").write_text(json.dumps(record))
            with self.assertRaisesRegex(RuntimeError,"ownership mismatch"):
                self.rt.stop_one("rest")
            self.assertIsNone(other.poll())
        finally:
            other.terminate();other.wait();self.rt.record_path("rest").unlink()

    def test_setup_refuses_dependency_refresh_with_owned_webapp(self):
        cli=self.root / "webapp/node_modules/next/dist/bin/next"
        cli.parent.mkdir(parents=True)
        cli.write_text("import time; time.sleep(60)")
        self.rt.spawn("webapp",[sys.executable,str(cli)])
        with self.assertRaisesRegex(RuntimeError,"before refreshing dependencies"):
            runtime.setup(self.rt)

    def test_bad_checksum_rejected_without_extracting(self):
        archive=self.root / "bad.tar.gz";archive.write_bytes(b"corrupt")
        with patch.object(runtime.subprocess,"check_output",return_value="0"*64):
            with self.assertRaisesRegex(RuntimeError,"Checksum mismatch"):
                runtime.download_verified("https://publisher.example/artifact",archive,"sha256",".sha256")


if __name__ == "__main__":
    unittest.main()
