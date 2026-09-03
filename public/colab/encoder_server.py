"""
Scene Weaver — remote encoder (CPU or GPU).

Runs on any machine with python3 + ffmpeg: a plain CPU cloud box/VPS, a
Colab/Kaggle notebook, or a GPU runtime. Accepts a panel list from the web app,
downloads every panel image, renders Ken Burns motion + colour grading with
ffmpeg, encodes with NVENC when a GPU is present and libx264 otherwise, and
serves the finished mp4 back over an https tunnel.

Run it directly on a CPU host:
    pip install --quiet requests    # not required, stdlib only
    python3 encoder_server.py       # listens on 0.0.0.0:$PORT (default 8000)
then expose port 8000 with cloudflared/ngrok and paste the https URL in the app.

Env knobs: SW_LANES, SW_THREADS, SW_X264_PRESET, SW_CRF, SW_TOKEN, SW_BASE, PORT.

Design notes for very long videos (2h+, thousands of panels):
  * Each panel becomes its own short clip -> memory stays flat.
  * Clips are cross-faded in groups (GROUP panels per filter_complex) so the
    ffmpeg command never grows unbounded, then the groups are stream-copy
    concatenated: no generation loss, no O(n^2) re-encoding.
  * Panels are rendered in parallel lanes; on CPU we run one lane per couple of
    cores so all cores stay saturated without thrashing.
"""

import json, math, os, re, shutil, subprocess, threading, time, uuid, hashlib
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import urllib.request

W, H, FPS, XF, GROUP = 1280, 720, 24, 0.7, 40
BASE = os.environ.get("SW_BASE") or ("/content" if os.path.isdir("/content") else os.getcwd())
WORK = os.path.join(BASE, "sw_work")
OUT = os.path.join(BASE, "sw_out")
LANES = int(os.environ.get("SW_LANES", "0"))
TOKEN = os.environ.get("SW_TOKEN", "")

os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

JOBS = {}
LOCK = threading.Lock()

# ---------------------------------------------------------------- encoder ---

def has_nvenc():
    """NVENC is only 'available' if it can actually encode a frame — ffmpeg
    builds on CPU-only cloud boxes still advertise the encoder."""
    if os.environ.get("SW_FORCE_CPU") == "1":
        return False
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True).stdout
        if "h264_nvenc" not in out:
            return False
        t = subprocess.run(["ffmpeg", "-hide_banner", "-y", "-f", "lavfi",
                            "-i", "color=c=black:s=256x144:d=0.1", "-c:v",
                            "h264_nvenc", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=20)
        return t.returncode == 0
    except Exception:
        return False

NVENC = has_nvenc()

# CPU-only hosts are the common case here, so tune for them: one lane per two
# cores keeps every core busy (x264 scales badly past ~4 threads per process),
# a cheap x264 preset, and a smaller supersample (see SS below).
CPU_COUNT = max(1, (os.cpu_count() or 2))
if LANES <= 0:
    LANES = 4 if NVENC else max(2, min(8, math.ceil(CPU_COUNT / 2)))
THREADS = int(os.environ.get("SW_THREADS", "0")) or max(1, min(4, CPU_COUNT // max(1, LANES)))

GPU_CODEC = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "8M"]
CPU_CODEC = ["-c:v", "libx264", "-preset", os.environ.get("SW_X264_PRESET", "veryfast"),
             "-crf", os.environ.get("SW_CRF", "23"), "-threads", str(THREADS)]
VCODEC = GPU_CODEC if NVENC else CPU_CODEC

# supersample factor before zoompan: 2x on GPU boxes, 1.25x on CPU-only runtimes
SS = 2.0 if NVENC else 1.25

print(f"[scene-weaver] encoder mode = {'GPU (NVENC)' if NVENC else 'CPU (libx264)'}, "
      f"lanes={LANES}, threads/lane={THREADS}, cpus={CPU_COUNT}")

# --------------------------------------------------------- cinematography ---

MOVES = [
    (1.00, 1.20, 0.5, 0.5, 0.5, 0.5),
    (1.22, 1.00, 0.5, 0.5, 0.5, 0.5),
    (1.14, 1.14, 0.0, 1.0, 0.5, 0.5),
    (1.14, 1.14, 1.0, 0.0, 0.5, 0.5),
    (1.14, 1.14, 0.5, 0.5, 0.0, 1.0),
    (1.14, 1.14, 0.5, 0.5, 1.0, 0.0),
    (1.02, 1.24, 0.3, 0.28, 0.3, 0.22),
    (1.02, 1.24, 0.7, 0.72, 0.7, 0.78),
    (1.08, 1.22, 0.15, 0.85, 0.85, 0.15),
]

# No mood grade: panels are clean, well-lit full-colour webtoon pages and the
# video shows them as drawn. Only a very light contrast touch, no colour cast.
CLEAN_GRADE = ("1.03", "0.00", "1.04", "0.00:0.00:0.00")


def grade_for(prompt, i):
    return CLEAN_GRADE


def move_for(i):
    h = int(hashlib.md5(f"m{i}".encode()).hexdigest()[:8], 16)
    return MOVES[h % len(MOVES)]


def clip_filter(i, dur, prompt):
    """zoompan Ken Burns + colour grade, always output exact 16:9 720p."""
    z0, z1, x0, x1, y0, y1 = move_for(i)
    frames = max(1, round(dur * FPS))
    contrast, bright, sat, cb = grade_for(prompt, i)
    # progress 0..1 across the clip, eased
    p = f"(on/{max(1, frames - 1)})"
    e = f"({p}*{p}*(3-2*{p}))"
    z = f"({z0}+({z1}-{z0})*{e})"
    fx = f"({x0}+({x1}-{x0})*{e})"
    fy = f"({y0}+({y1}-{y0})*{e})"
    return (
        f"scale={int(W*SS)}:{int(H*SS)}:force_original_aspect_ratio=increase,"
        f"crop={int(W*SS)}:{int(H*SS)},setsar=1,"
        f"zoompan=z='{z}':x='(iw-iw/zoom)*{fx}':y='(ih-ih/zoom)*{fy}'"
        f":d={frames}:s={W}x{H}:fps={FPS},"
        f"eq=contrast={contrast}:brightness={bright}:saturation={sat},"
        f"colorbalance=rm={cb.split(':')[0]}:gm={cb.split(':')[1]}:bm={cb.split(':')[2]},"
        f"format=yuv420p"
    )


def _clean_err(err):
    """ffmpeg prints its whole ./configure line on failure — drop the noise."""
    lines = [l for l in (err or "").splitlines()
             if l.strip() and not l.startswith(("  configuration:", "  lib", "  built with"))
             and not l.startswith("ffmpeg version")]
    return "\n".join(lines[-12:])[-1200:] or (err or "")[-500:]


def run(cmd, allow_codec_fallback=True):
    global VCODEC
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        return
    err = _clean_err(r.stderr)
    # NVENC can be advertised but unusable (no GPU runtime / all sessions busy).
    if allow_codec_fallback and "h264_nvenc" in cmd:
        print(f"[scene-weaver] NVENC failed, switching to CPU encoding: {err[:200]}")
        VCODEC = CPU_CODEC
        cmd = [("libx264" if c == "h264_nvenc" else c) for c in cmd]
        for flag in ("-preset", "-rc", "-cq", "-b:v", "-tune", "-crf", "-threads"):
            while flag in cmd:
                i = cmd.index(flag)
                del cmd[i:i + 2]
        i = cmd.index("-c:v")
        cmd[i + 2:i + 2] = CPU_CODEC[2:]
        r2 = subprocess.run(cmd, capture_output=True, text=True)
        if r2.returncode == 0:
            return
        err = _clean_err(r2.stderr)
    raise RuntimeError(err)


def is_real_image(path):
    """Rejects blank/near-blank or corrupt panels.

    A drawn panel always has structure; a solid fill (the failure mode that used
    to slip into the video, or get silently skipped) has almost no luminance
    spread. Falls back to a size check when PIL is unavailable.
    """
    try:
        if os.path.getsize(path) < 4000:
            return False
    except Exception:
        return False
    try:
        from PIL import Image, ImageStat
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            small = im.convert("L").resize((32, 18))
            sd = ImageStat.Stat(small).stddev[0]
        return sd >= 4.0
    except ImportError:
        return True
    except Exception:
        return False


def fetch(url, path, attempts=4):
    """Downloads a panel and validates it; raises if it never arrives usable."""
    last = ""
    for a in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "scene-weaver-colab"})
            with urllib.request.urlopen(req, timeout=90) as r, open(path, "wb") as f:
                shutil.copyfileobj(r, f)
            if not os.path.getsize(path):
                last = "empty file"
            elif not is_real_image(path):
                last = "blank or corrupt image"
            else:
                return
        except Exception as e:
            last = str(e)
        time.sleep(0.6 * (a + 1))
    raise RuntimeError(f"download failed: {last}")



# ------------------------------------------------------------------- job ---

def set_job(jid, **kw):
    with LOCK:
        JOBS[jid].update(kw)


def probe_duration(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "format=duration", "-of", "csv=p=0", path],
                           capture_output=True, text=True)
        return float((r.stdout or "0").strip())
    except Exception:
        return 0.0


def render(jid, panels, target_seconds=0.0):
    d = os.path.join(WORK, jid)
    os.makedirs(d, exist_ok=True)
    n = len(panels)

    # ---- stage 1: download + validate every panel image ---------------------
    imgs = [None] * n
    got = [0]

    def grab(i):
        img = os.path.join(d, f"i{i:06d}")
        try:
            fetch(panels[i]["url"], img)
            imgs[i] = img
        except Exception as e:
            print(f"[scene-weaver] panel {i} unusable ({e}); will reuse a neighbour")
        got[0] += 1
        set_job(jid, pct=round(got[0] / n * 18),
                note=f"Fetching panels · {got[0]}/{n}")

    with ThreadPoolExecutor(max_workers=max(4, LANES * 2)) as ex:
        list(ex.map(grab, range(n)))

    if not any(imgs):
        raise RuntimeError("none of the panel images could be downloaded")

    # A blank/failed panel never loses its slice of time: the nearest valid
    # image covers it, so the mp4 stays exactly as long as the script.
    subs = 0
    for i in range(n):
        if imgs[i]:
            continue
        for off in range(1, n):
            j = i - off
            k = i + off
            if j >= 0 and imgs[j]:
                imgs[i] = imgs[j]
                break
            if k < n and imgs[k]:
                imgs[i] = imgs[k]
                break
        subs += 1
    if subs:
        print(f"[scene-weaver] {subs} panel(s) substituted with a neighbour image")

    # ---- frame budget: exact absolute frames taken from the global target ---
    # Every lane boundary is computed in ABSOLUTE frames from the final target,
    # so per-panel rounding can never accumulate: sum(frames) == total_frames.
    starts = [float(p["start"]) for p in panels]
    ends = [float(p["end"]) for p in panels]
    target = float(target_seconds or 0.0)
    if target <= 0:
        target = max(ends[-1] - starts[0],
                     sum(max(0.8, e - s) for s, e in zip(starts, ends)))
    total_frames = max(n, int(round(target * FPS)))
    t0 = starts[0]
    span_s = max(1e-6, ends[-1] - t0)

    bounds = [0]
    for i in range(n):
        bounds.append(int(round((ends[i] - t0) / span_s * total_frames)))
    bounds[n] = total_frames
    for i in range(1, n + 1):                 # monotonic, >= 1 frame per panel
        if bounds[i] <= bounds[i - 1]:
            bounds[i] = bounds[i - 1] + 1
    if bounds[n] > total_frames:              # clamp pushed past target: reclaim
        bounds[n] = total_frames
        for i in range(n - 1, 0, -1):
            if bounds[i] >= bounds[i + 1]:
                bounds[i] = bounds[i + 1] - 1
            else:
                break
    frames = [max(1, bounds[i + 1] - bounds[i]) for i in range(n)]
    durs = [f / FPS for f in frames]
    target = total_frames / FPS
    XFF = max(1, int(round(XF * FPS)))        # transition overlap, in frames

    # ---- stage 2: one clip per panel ---------------------------------------
    done = [0]

    def one(i):
        p = panels[i]
        # The transition overlap is borrowed from the FOLLOWING panel's budget:
        # the clip renders frames[i] visible frames plus an XFF tail that the
        # next panel's fade consumes, so no transition eats real running time.
        tail = XFF if i < n - 1 else 0
        total = frames[i] + tail
        clip = os.path.join(d, f"c{i:06d}.mp4")
        run(["ffmpeg", "-y", "-loop", "1", "-i", imgs[i],
             "-frames:v", str(total),
             "-vf", clip_filter(i, total / FPS, p.get("prompt")),
             "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", clip])
        done[0] += 1
        set_job(jid, pct=18 + round(done[0] / n * 60),
                note=f"Rendering panels · {done[0]}/{n}"
                     + (f" · {subs} substituted" if subs else ""))

    with ThreadPoolExecutor(max_workers=LANES) as ex:
        list(ex.map(one, range(n)))

    # keep one valid frame around for tail padding, then drop the downloads
    pad_src = os.path.join(d, "pad_src")
    last_valid = next((imgs[i] for i in range(n - 1, -1, -1) if imgs[i]), None)
    if last_valid and os.path.exists(last_valid):
        shutil.copy(last_valid, pad_src)
    for path in set(p for p in imgs if p):
        try:
            os.remove(path)
        except Exception:
            pass

    def probe_frames(path):
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-count_frames",
                                "-select_streams", "v:0", "-show_entries",
                                "stream=nb_read_frames", "-of", "csv=p=0", path],
                               capture_output=True, text=True)
            return int((r.stdout or "0").strip() or 0)
        except Exception:
            return 0

    def force_frames(path, want, tag):
        """Per-lane audit: pad (clone last frame) or cut so the lane is exact."""
        have = probe_frames(path)
        if have == want or have <= 0:
            return path
        fixed = os.path.join(d, f"{tag}.exact.mp4")
        hold = max(0.0, (want - have) / FPS) + 2.0
        run(["ffmpeg", "-y", "-i", path,
             "-vf", f"tpad=stop_mode=clone:stop_duration={hold:.3f},fps={FPS}",
             "-frames:v", str(want),
             "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", fixed])
        os.replace(fixed, path)
        return path

    # ---- cross-fade inside groups, then stream-copy concat the groups ------
    groups = []
    gi = 0
    for g0 in range(0, n, GROUP):
        idxs = list(range(g0, min(n, g0 + GROUP)))
        gpath = os.path.join(d, f"g{gi:05d}.mp4")
        span_frames = sum(frames[i] for i in idxs)
        if len(idxs) == 1:
            only = idxs[0]
            run(["ffmpeg", "-y", "-i", os.path.join(d, f"c{only:06d}.mp4"),
                 "-frames:v", str(span_frames), "-c", "copy", gpath])
        else:
            args, fc, prev = [], [], "0:v"
            for i in idxs:
                args += ["-i", os.path.join(d, f"c{i:06d}.mp4")]
            # clip k's fade starts exactly at the sum of the visible frame
            # budgets before it, so the overlap never shortens the lane
            off_f = 0
            for k in range(1, len(idxs)):
                off_f += frames[idxs[k - 1]]
                lab = f"x{k}"
                fc.append(f"[{prev}][{k}:v]xfade=transition=fade:duration={XF}:"
                          f"offset={max(1, off_f) / FPS:.3f}[{lab}]")
                prev = lab

            run(["ffmpeg", "-y", *args, "-filter_complex", ";".join(fc),
                 "-map", f"[{prev}]", "-frames:v", str(span_frames),
                 "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", gpath])

        # audit THIS lane now, while the error is still one lane wide
        force_frames(gpath, span_frames, f"g{gi:05d}")
        for i in idxs:
            try:
                os.remove(os.path.join(d, f"c{i:06d}.mp4"))
            except Exception:
                pass

        groups.append(gpath)
        gi += 1
        set_job(jid, pct=78 + round(gi / max(1, math.ceil(n / GROUP)) * 16),
                note=f"Stitching · part {gi}/{math.ceil(n / GROUP)}")

    # ---- length guarantee: hit target_seconds exactly ----------------------
    have = sum(probe_duration(g) for g in groups)
    short = target - have
    if short > 1.0 / FPS and os.path.exists(pad_src):
        # hold the final frame so the runtime matches the script's last timestamp
        set_job(jid, pct=95, note="Matching video length to the script…")
        pad = os.path.join(d, "zpad.mp4")
        run(["ffmpeg", "-y", "-loop", "1", "-i", pad_src, "-t", f"{short:.3f}",
             "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,"
                    f"crop={W}:{H},setsar=1,fps={FPS},"
                    f"eq=contrast=1.10:brightness=0.04:saturation=0.88,format=yuv420p",
             "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", pad])
        groups.append(pad)

    listf = os.path.join(d, "list.txt")
    with open(listf, "w") as f:
        for g in groups:
            f.write(f"file '{g}'\n")
    final = os.path.join(OUT, f"{jid}.mp4")
    set_job(jid, pct=97, note="Writing final mp4…")
    trim = ["-t", f"{target:.3f}"] if have > target + 1.0 / FPS else []
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
         *trim, "-c", "copy", "-movflags", "+faststart", final])


    # ---- final audit: measure the real mp4 and correct any residual drift ---
    # Stream-copy trims land on keyframes, so retry and fall back to an exact
    # re-encode until the runtime equals the script's last timestamp.
    tol = 1.0 / FPS
    for attempt in range(4):
        got = probe_duration(final)
        drift = target - got
        if abs(drift) <= tol:
            break
        set_job(jid, pct=98, note="Matching video length to the script…")
        fixed = os.path.join(OUT, f"{jid}.fix{attempt}.mp4")
        if drift > 0 and os.path.exists(pad_src) and attempt < 2:
            tailc = os.path.join(d, f"tail{attempt}.mp4")
            run(["ffmpeg", "-y", "-loop", "1", "-i", pad_src, "-t", f"{drift:.3f}",
                 "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,"
                        f"crop={W}:{H},setsar=1,fps={FPS},"
                        f"eq=contrast=1.10:brightness=0.04:saturation=0.88,format=yuv420p",
                 "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", tailc])
            listf2 = os.path.join(d, f"list{attempt}.txt")
            with open(listf2, "w") as f:
                f.write(f"file '{final}'\nfile '{tailc}'\n")
            run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf2,
                 "-c", "copy", "-movflags", "+faststart", fixed])
        elif attempt == 0:
            run(["ffmpeg", "-y", "-i", final, "-t", f"{target:.3f}",
                 "-c", "copy", "-movflags", "+faststart", fixed])
        else:
            # frame-exact last resort: clone the last frame for as long as it
            # takes (tpad), then cut on the precise frame count. This handles
            # both a short and a long file, with or without a pad source.
            hold = max(0.0, drift) + 2.0
            run(["ffmpeg", "-y", "-i", final,
                 "-vf", f"tpad=stop_mode=clone:stop_duration={hold:.3f},fps={FPS}",
                 "-frames:v", str(max(1, int(round(target * FPS)))),
                 "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart", fixed])
        os.replace(fixed, final)
    got = probe_duration(final)
    if abs(target - got) > tol:
        # Never publish a partial export as successful.
        raise RuntimeError(
            f"duration audit failed: expected {target:.3f}s, encoded {got:.3f}s"
        )

    shutil.rmtree(d, ignore_errors=True)
    size = os.path.getsize(final)
    set_job(jid, pct=100, state="done",
            note=f"Video ready · {probe_duration(final):.1f}s"
                 + (f" · {subs} panel(s) substituted" if subs else ""),
            size=size, download=f"/download/{jid}.mp4")



def worker(jid, panels, target_seconds=0.0):
    try:
        render(jid, panels, target_seconds)

    except Exception as e:
        set_job(jid, state="error", note=str(e)[:500])


# ---------------------------------------------------------------- server ---

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj, extra=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        for k, v in {**CORS, **(extra or {})}.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._send(200, {"ok": True, "gpu": NVENC, "lanes": LANES,
                                    "mode": "gpu" if NVENC else "cpu"})
        m = re.match(r"^/status/([\w-]+)$", path)
        if m:
            j = JOBS.get(m.group(1))
            return self._send(200, j) if j else self._send(404, {"error": "no job"})
        m = re.match(r"^/download/([\w-]+)\.mp4$", path)
        if m:
            f = os.path.join(OUT, f"{m.group(1)}.mp4")
            if not os.path.exists(f):
                return self._send(404, {"error": "not ready"})
            size = os.path.getsize(f)
            self.send_response(200)
            for k, v in CORS.items():
                self.send_header(k, v)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             f'attachment; filename="manga-video.mp4"')
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 1024)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/render":
            return self._send(404, {"error": "not found"})
        if not self._auth():
            return self._send(401, {"error": "bad token"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        panels = data.get("panels") or []
        if not panels:
            return self._send(400, {"error": "no panels"})
        # exact runtime the mp4 must have (the script's last timestamp)
        try:
            target = float(data.get("target_seconds") or 0.0)
        except Exception:
            target = 0.0
        jid = uuid.uuid4().hex[:12]
        with LOCK:
            JOBS[jid] = {"id": jid, "state": "running", "pct": 0,
                         "note": "Queued", "panels": len(panels),
                         "target_seconds": target}
        threading.Thread(target=worker, args=(jid, panels, target), daemon=True).start()

        self._send(200, {"id": jid})


def serve(port=8000):
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    p = int(os.environ.get("PORT", "8000"))
    print(f"[scene-weaver] listening on 0.0.0.0:{p}")
    serve(p)
