import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import master_ab


class MasterAbServerTests(unittest.TestCase):
    def test_is_master_filename_filtering(self):
        self.assertTrue(master_ab.is_master_filename("Track_01_MASTER_v1.wav"))
        self.assertTrue(master_ab.is_master_filename("Track_01_mastered_warm.flac"))
        self.assertFalse(master_ab.is_master_filename("Track_01_UNMASTERED.wav"))
        self.assertFalse(master_ab.is_master_filename("Track_01_un-master.wav"))
        self.assertFalse(master_ab.is_master_filename("Track_01_rough_mix.wav"))
        self.assertFalse(master_ab.is_master_filename("._Track_01_MASTER.wav"))
        self.assertFalse(master_ab.is_master_filename("Track_01_MASTER.txt"))
        self.assertTrue(
            master_ab.is_master_filename("Track_01_UNMASTERED.wav", filter_only_masters=False)
        )

    def test_resolve_safe_static_path_blocks_traversal_and_code(self):
        self.assertIsNotNone(master_ab.resolve_safe_static_path("/"))
        self.assertIsNotNone(master_ab.resolve_safe_static_path("/index.html"))
        self.assertIsNotNone(master_ab.resolve_safe_static_path("/app.css"))
        self.assertIsNotNone(master_ab.resolve_safe_static_path("/js/app.js"))
        self.assertIsNotNone(master_ab.resolve_safe_static_path("/assets/icons/mark.svg"))

        # Must block source code & path traversal
        self.assertIsNone(master_ab.resolve_safe_static_path("/master_ab.py"))
        self.assertIsNone(master_ab.resolve_safe_static_path("/../etc/passwd"))
        self.assertIsNone(master_ab.resolve_safe_static_path("/js/../../etc/passwd"))
        self.assertIsNone(master_ab.resolve_safe_static_path("/.git/HEAD"))

    def test_scan_folder_and_http_endpoints(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            (tmp / "Song_MASTER_v1.wav").write_bytes(b"RIFF" + b"\x00" * 64)
            (tmp / "Song_UNMASTERED.wav").write_bytes(b"RIFF" + b"\x00" * 64)
            (tmp / "Notes.txt").write_text("ignore")

            result = master_ab.library.load_folder(tmpdir, filter_only_masters=True)
            self.assertEqual(result["total_found"], 1)
            self.assertEqual(result["tracks"][0]["filename"], "Song_MASTER_v1.wav")

            server = ThreadingHTTPServer(("127.0.0.1", 0), master_ab.AppServerHandler)
            port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                conn.request("GET", "/api/status")
                resp = conn.getresponse()
                self.assertEqual(resp.status, 200)
                payload = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(payload["server_mode"])
                self.assertEqual(payload["total_tracks"], 1)

                conn.request("GET", "/")
                resp = conn.getresponse()
                body = resp.read().decode("utf-8")
                self.assertEqual(resp.status, 200)
                self.assertIn("Saint Gordon", body)
                self.assertIn('name="mc-local-server"', body)

                conn.request("GET", "/master_ab.py")
                resp = conn.getresponse()
                resp.read()
                self.assertEqual(resp.status, 404)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
