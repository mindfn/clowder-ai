"""film-stats.py 的回归测试：用 ffmpeg 现做一段已知答案的小片子。

运行：python3 -m unittest discover -s cat-cafe-skills/video-forge/scripts -p 'test_*.py'
没有 ffmpeg 或 numpy 时跳过。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILM_STATS = HERE / "film-stats.py"

try:
    import numpy  # noqa: F401

    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False


def make_clip(path: Path) -> None:
    """2 秒：前 1 秒红、后 1 秒蓝（1.0 秒处一次硬切）；前 1 秒有声、后 1 秒无声。"""
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=red:s=192x108:r=30:d=1",
            "-f", "lavfi", "-i", "color=blue:s=192x108:r=30:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=1",
            "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=1",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]",
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            str(path),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
    )


@unittest.skipUnless(shutil.which("ffmpeg") and HAVE_NUMPY, "needs ffmpeg and numpy")
class FilmStatsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.clip = self.tmp / "clip.mp4"
        make_clip(self.clip)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_stats(self, *args: str) -> list[dict]:
        out = subprocess.run([sys.executable, str(FILM_STATS), *args], check=True, capture_output=True, text=True, stdin=subprocess.DEVNULL)
        return json.loads(out.stdout)

    def test_counts_one_cut_half_silence_mostly_still(self):
        [s] = self.run_stats(str(self.clip))
        self.assertEqual(s["cutCount"], 1)
        self.assertAlmostEqual(s["cutCandidates"][0], 1.0, delta=0.1)
        self.assertGreater(s["stillPct"], 90)
        self.assertAlmostEqual(s["silentPct"], 50, delta=20)
        self.assertAlmostEqual(s["seconds"], 2.0, delta=0.1)

    def test_reports_each_video_in_order(self):
        out = self.run_stats(str(self.clip), str(self.clip))
        self.assertEqual([Path(s["path"]).name for s in out], ["clip.mp4", "clip.mp4"])

    def test_frame_rate_with_trailing_comma(self):
        # Remotion 渲出来的 mp4，ffprobe 会打成 "30/1,"（10-12 用真片子跑时崩过）
        import importlib.util

        spec = importlib.util.spec_from_file_location("film_stats", FILM_STATS)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual(mod.parse_rate("30/1,\n"), 30.0)
        self.assertEqual(mod.parse_rate("30000/1001\n"), 30000 / 1001)

    def test_video_without_audio_counts_as_silent(self):
        # 纯界面录屏常常没有音轨；说明里承诺的是 silentPct=100，不是 ffmpeg 报错（墨墨 10-12 审出）
        mute = self.tmp / "mute.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=gray:s=192x108:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(mute)],
            check=True,
            stdin=subprocess.DEVNULL,
        )
        [s] = self.run_stats(str(mute))
        self.assertEqual(s["silentPct"], 100.0)
        self.assertEqual(s["cutCount"], 0)

    def test_missing_file_exits_nonzero(self):
        res = subprocess.run([sys.executable, str(FILM_STATS), str(self.tmp / "nope.mp4")], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        self.assertNotEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
