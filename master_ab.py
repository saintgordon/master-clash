#!/usr/bin/env python3
"""
Master Clash by Saint Gordon Collective — Local CLI & Studio Companion Server.
Serves the single-source web console directly from the repository root and
provides optional ffmpeg-backed local folder scanning and format decoding
(e.g., AIFF, CAF, 32-bit float WAV) when launched from the command line.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import platform
import random
import re
import shutil
import struct
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AUDIO_EXTENSIONS = {
    ".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".caf", ".wma"
}

APP_DIR = Path(__file__).resolve().parent

MASTER_REGEX = re.compile(r"master(?:ed)?", re.IGNORECASE)
UNMASTERED_REGEX = re.compile(r"un[\W_]?master(?:ed)?", re.IGNORECASE)

STATIC_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}

ALLOWED_STATIC_PREFIXES = ("assets/", "js/")
ALLOWED_ROOT_FILES = {"index.html", "app.css"}


def has_binary(name: str) -> bool:
    return shutil.which(name) is not None


def is_master_filename(filename: str, folder_path: str = "", filter_only_masters: bool = True) -> bool:
    """Return True if filename is an audio track matching filter rules."""
    if filename.startswith(".") or filename.startswith("._"):
        return False
    suffix = Path(filename).suffix.lower()
    if suffix not in AUDIO_EXTENSIONS:
        return False
    if not filter_only_masters:
        return True
    if UNMASTERED_REGEX.search(filename) or (folder_path and UNMASTERED_REGEX.search(folder_path)):
        return False
    return bool(MASTER_REGEX.search(filename))


def resolve_safe_static_path(request_path: str, base_dir: Path = APP_DIR):
    """Safely resolve a static asset path inside base_dir without directory traversal."""
    clean = request_path.lstrip("/") or "index.html"
    if clean == "":
        clean = "index.html"

    allowed = (clean in ALLOWED_ROOT_FILES) or any(
        clean.startswith(prefix) for prefix in ALLOWED_STATIC_PREFIXES
    )
    if not allowed:
        return None

    try:
        base_resolved = base_dir.resolve()
        candidate = (base_resolved / clean).resolve()
        candidate.relative_to(base_resolved)
    except (ValueError, OSError):
        return None

    if not candidate.is_file():
        return None
    return candidate


class AudioInspector:
    @staticmethod
    def probe_track(file_path: str) -> dict:
        """Probe audio file using ffprobe to get duration, format, sample rate, bit depth."""
        path_obj = Path(file_path)
        size_bytes = path_obj.stat().st_size
        size_mb = round(size_bytes / (1024 * 1024), 2)

        resolved_path = str(path_obj.resolve())
        stable_id = f"trk_{hashlib.sha256(resolved_path.encode('utf-8')).hexdigest()[:10]}"

        info = {
            "id": stable_id,
            "filename": path_obj.name,
            "filepath": resolved_path,
            "extension": path_obj.suffix.lower(),
            "size_mb": size_mb,
            "duration": 30.0,
            "sample_rate": 44100,
            "channels": 2,
            "bit_depth": 16,
            "codec_name": "unknown",
            "format_desc": f"{path_obj.suffix.upper()[1:]}",
            "midpoint": 15.0,
            "clip_start": 7.5,
            "clip_duration": 15.0,
        }

        if not has_binary("ffprobe"):
            return info

        try:
            cmd = [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,size,bit_rate",
                "-show_entries",
                "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample",
                "-of",
                "json",
                file_path,
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if res.returncode == 0:
                data = json.loads(res.stdout)
                fmt = data.get("format", {})
                streams = data.get("streams", [])
                audio_stream = next((s for s in streams if s.get("codec_name")), {})

                dur = float(fmt.get("duration", audio_stream.get("duration", 30.0)))
                info["duration"] = round(dur, 2)

                sr = int(audio_stream.get("sample_rate", 44100))
                info["sample_rate"] = sr

                ch = int(audio_stream.get("channels", 2))
                info["channels"] = ch

                bits = audio_stream.get("bits_per_raw_sample") or audio_stream.get("bits_per_sample")
                if bits and str(bits).isdigit():
                    info["bit_depth"] = int(bits)
                elif "24" in audio_stream.get("codec_name", ""):
                    info["bit_depth"] = 24
                elif "32" in audio_stream.get("codec_name", ""):
                    info["bit_depth"] = 32
                else:
                    info["bit_depth"] = 16

                codec = audio_stream.get("codec_name", path_obj.suffix.lstrip(".")).upper()
                info["codec_name"] = codec

                sr_khz = f"{sr / 1000:g}kHz"
                ch_str = "Stereo" if ch == 2 else ("Mono" if ch == 1 else f"{ch}ch")
                if "PCM" in codec or path_obj.suffix.lower() in (".wav", ".aif", ".aiff"):
                    ext_label = path_obj.suffix.lstrip(".").upper()
                    info["format_desc"] = f"{ext_label} {info['bit_depth']}-bit {sr_khz} {ch_str}"
                else:
                    info["format_desc"] = f"{codec} {sr_khz} {ch_str}"

                mid = dur / 2.0
                info["midpoint"] = round(mid, 2)
                clip_dur = min(15.0, dur)
                info["clip_duration"] = round(clip_dur, 2)
                clip_start = max(0.0, mid - (clip_dur / 2.0))
                info["clip_start"] = round(clip_start, 2)
        except Exception:
            pass

        return info


def scan_master_tracks(folder_path: str, filter_only_masters: bool = True) -> list:
    """Scan directory (and up to 2 subfolder levels) for audio tracks."""
    found_files = []
    folder = Path(folder_path).expanduser().resolve()

    if not folder.exists() or not folder.is_dir():
        return []

    root_depth = len(folder.parts)
    for root, dirs, files in os.walk(folder):
        current_depth = len(Path(root).parts)
        if current_depth - root_depth > 2:
            dirs.clear()
            continue

        rel_root = os.path.relpath(root, folder)
        check_root = "" if rel_root == "." else rel_root

        for file in files:
            if is_master_filename(file, check_root, filter_only_masters=filter_only_masters):
                found_files.append(os.path.join(root, file))

    with ThreadPoolExecutor(max_workers=8) as executor:
        tracks = list(executor.map(AudioInspector.probe_track, found_files))

    tracks.sort(key=lambda x: x["filename"].lower())
    return tracks


class LocalLibraryManager:
    """Manages local scanned folder state for the companion HTTP server."""

    def __init__(self):
        self.lock = threading.Lock()
        self.folder_path = ""
        self.filter_only_masters = True
        self.all_tracks = []

    def load_folder(self, folder_path: str, filter_only_masters: bool = True) -> dict:
        with self.lock:
            self.folder_path = str(Path(folder_path).expanduser().resolve())
            self.filter_only_masters = filter_only_masters
            self.all_tracks = scan_master_tracks(
                self.folder_path, filter_only_masters=filter_only_masters
            )
            return {
                "folder": self.folder_path,
                "filter_only_masters": self.filter_only_masters,
                "total_found": len(self.all_tracks),
                "tracks": self.all_tracks,
            }

    def get_track(self, track_id: str):
        with self.lock:
            return next((t for t in self.all_tracks if t["id"] == track_id), None)

    def get_status(self) -> dict:
        with self.lock:
            return {
                "server_mode": True,
                "platform": platform.system(),
                "has_ffmpeg": has_binary("ffmpeg"),
                "has_ffprobe": has_binary("ffprobe"),
                "folder": self.folder_path,
                "filter_only_masters": self.filter_only_masters,
                "total_tracks": len(self.all_tracks),
                "tracks": self.all_tracks,
            }


def extract_pcm_wav_clip(filepath: str, start_time: float, duration: float) -> bytes:
    """Run ffmpeg to extract an exact audio slice and return a 24-bit/16-bit PCM WAV."""
    if not has_binary("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed or not on PATH.")

    start_val = max(0.0, float(start_time))
    dur_val = max(0.1, float(duration))
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_val:.3f}",
        "-t",
        f"{dur_val:.3f}",
        "-i",
        filepath,
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "wav",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', errors='ignore')}")

    data = bytearray(proc.stdout)
    if len(data) >= 44 and data[:4] == b"RIFF":
        total_len = len(data)
        data[4:8] = struct.pack("<I", total_len - 8)
        pos = data.find(b"data")
        if pos != -1 and pos + 8 <= len(data):
            data[pos + 4 : pos + 8] = struct.pack("<I", total_len - (pos + 8))

    return bytes(data)


def convert_full_track_to_wav(filepath: str) -> bytes:
    """Convert any ffmpeg-readable audio file to standard stereo WAV for browser decoding."""
    if not has_binary("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed or not on PATH.")

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        filepath,
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "wav",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', errors='ignore')}")

    data = bytearray(proc.stdout)
    if len(data) >= 44 and data[:4] == b"RIFF":
        total_len = len(data)
        data[4:8] = struct.pack("<I", total_len - 8)
        pos = data.find(b"data")
        if pos != -1 and pos + 8 <= len(data):
            data[pos + 4 : pos + 8] = struct.pack("<I", total_len - (pos + 8))

    return bytes(data)


library = LocalLibraryManager()


def prompt_native_folder_picker() -> str:
    """Open native folder picker where supported (macOS osascript)."""
    if platform.system() != "Darwin" or not has_binary("osascript"):
        return ""
    apple_script = 'POSIX path of (choose folder with prompt "Select Folder Containing Master Tracks")'
    try:
        proc = subprocess.run(
            ["osascript", "-e", apple_script], capture_output=True, text=True, timeout=60
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:
        pass
    return ""


def reveal_file_in_os(filepath: str) -> bool:
    """Reveal a file in the native file manager if supported."""
    if not filepath or not os.path.exists(filepath):
        return False
    sys_name = platform.system()
    try:
        if sys_name == "Darwin":
            subprocess.run(["open", "-R", filepath], check=False)
            return True
        if sys_name == "Windows":
            subprocess.run(["explorer", "/select,", filepath], check=False)
            return True
        if has_binary("xdg-open"):
            subprocess.run(["xdg-open", str(Path(filepath).parent)], check=False)
            return True
    except Exception:
        return False
    return False


class AppServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if "/api/audio" in str(args):
            return
        super().log_message(format, *args)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == "/api/status":
            self.send_json(library.get_status())
            return

        if path == "/api/audio/track_clip":
            track_id = params.get("track_id", [""])[0]
            track = library.get_track(track_id)
            if not track:
                self.send_error(404, "Track not found")
                return
            try:
                dur = float(params.get("duration", [track["clip_duration"]])[0])
                start_raw = params.get("start", [None])[0]
                if start_raw is not None:
                    start = float(start_raw)
                else:
                    start = max(0.0, (track["duration"] / 2.0) - (dur / 2.0))
                clip_bytes = extract_pcm_wav_clip(track["filepath"], start, dur)
                self.send_bytes_with_range(clip_bytes, "audio/wav")
            except Exception as exc:
                self.send_error(500, f"Error extracting clip: {exc}")
            return

        if path == "/api/audio/full":
            track_id = params.get("track_id", [""])[0]
            transcode = params.get("transcode", ["0"])[0] == "1"
            track = library.get_track(track_id)
            if not track:
                self.send_error(404, "Track not found")
                return
            if transcode and has_binary("ffmpeg"):
                try:
                    wav_bytes = convert_full_track_to_wav(track["filepath"])
                    self.send_bytes_with_range(wav_bytes, "audio/wav")
                except Exception as exc:
                    self.send_error(500, f"Error transcoding track: {exc}")
                return
            self.stream_audio_file(track["filepath"])
            return

        static_file = resolve_safe_static_path(path, APP_DIR)
        if static_file is not None:
            mime = STATIC_MIME_TYPES.get(
                static_file.suffix.lower(),
                mimetypes.guess_type(str(static_file))[0] or "application/octet-stream",
            )
            self.serve_path(static_file, mime)
            return

        self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            data = {}

        if path == "/api/browse_folder":
            selected_path = prompt_native_folder_picker()
            if selected_path:
                filter_masters = bool(data.get("filter_only_masters", True))
                result = library.load_folder(selected_path, filter_only_masters=filter_masters)
                self.send_json({"success": True, "folder": selected_path, "data": result})
            else:
                self.send_json({"success": False, "cancelled": True})
            return

        if path == "/api/scan":
            folder_path = data.get("folder", "")
            filter_masters = bool(data.get("filter_only_masters", True))
            if not folder_path:
                self.send_json({"error": "No folder provided"}, status=400)
                return
            result = library.load_folder(folder_path, filter_only_masters=filter_masters)
            self.send_json(result)
            return

        if path == "/api/reveal_in_finder":
            track_id = data.get("track_id", "")
            track = library.get_track(track_id) if track_id else None
            filepath = track["filepath"] if track else ""
            if filepath and reveal_file_in_os(filepath):
                self.send_json({"success": True})
            else:
                self.send_json({"error": "File not found or unsupported platform"}, status=404)
            return

        self.send_error(404, "Not Found")

    def serve_path(self, target_path: Path, content_type: str):
        content = target_path.read_bytes()
        if target_path.name == "index.html":
            html = content.decode("utf-8", errors="replace")
            marker = '<meta name="mc-local-server" content="1" />\n  </head>'
            if "</head>" in html and 'name="mc-local-server"' not in html:
                html = html.replace("</head>", marker, 1)
                content = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes_with_range(self, data: bytes, content_type: str = "audio/wav"):
        file_size = len(data)
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                end = min(end, file_size - 1)
                if start <= end < file_size:
                    chunk = data[start : end + 1]
                    self.send_response(206)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(len(chunk)))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    self.wfile.write(chunk)
                    return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def stream_audio_file(self, filepath: str):
        if not os.path.exists(filepath):
            self.send_error(404, "Audio file not found")
            return

        file_size = os.path.getsize(filepath)
        mime, _ = mimetypes.guess_type(filepath)
        mime = mime or "audio/wav"

        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                end = min(end, file_size - 1)
                if start <= end < file_size:
                    length = end - start + 1
                    self.send_response(206)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    with open(filepath, "rb") as f:
                        f.seek(start)
                        self.wfile.write(f.read(length))
                    return

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                self.wfile.write(chunk)


def main():
    parser = argparse.ArgumentParser(
        description="Master Clash by Saint Gordon Collective — Local Blind Mastering Console",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python3 master_ab.py                         # Launch console in browser
  python3 master_ab.py ~/Music/Masters         # Pre-load a folder of MASTER tracks
  python3 master_ab.py --all-audio ~/Music/Mix # Include non-MASTER tracks too
""",
    )
    parser.add_argument("folder", nargs="?", default=None, help="Path to folder containing audio tracks")
    parser.add_argument("--all-audio", action="store_true", help="Do not restrict scan to MASTER/MASTERED filenames")
    parser.add_argument("--port", type=int, default=8282, help="Local port (default: 8282)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open browser")
    args = parser.parse_args()

    if not has_binary("ffmpeg") or not has_binary("ffprobe"):
        print("Note: ffmpeg/ffprobe not found on PATH. Browser-native formats still work; install ffmpeg for AIFF/CAF transcoding.")

    initial_folder = None
    if args.folder:
        folder_p = Path(args.folder).expanduser().resolve()
        if folder_p.exists() and folder_p.is_dir():
            initial_folder = str(folder_p)
            print(f"Pre-loading folder: {initial_folder}")
            library.load_folder(initial_folder, filter_only_masters=not args.all_audio)
            print(f"Detected {len(library.all_tracks)} audio track(s).")
        else:
            print(f"Warning: '{args.folder}' does not exist or is not a directory.")

    port = args.port
    server = None
    for candidate_port in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate_port), AppServerHandler)
            port = candidate_port
            break
        except OSError:
            continue

    if not server:
        print("Error: Could not bind to an available local port.")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"
    print("=" * 64)
    print("  SAINT GORDON COLLECTIVE — MASTER CLASH STUDIO CONSOLE")
    print("=" * 64)
    print(f"  Running at : {url}")
    if initial_folder:
        print(f"  Folder     : {initial_folder} ({len(library.all_tracks)} tracks)")
    print("  Press Ctrl+C to stop.")
    print("=" * 64)

    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Master Clash.")
        server.server_close()


if __name__ == "__main__":
    main()
