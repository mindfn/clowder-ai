"""Sound design: every effect placed on the picture's own events
(build/events.json, exported from the direction code) and cue sheet."""

from __future__ import annotations

import numpy as np

from lib.dsp import SR, RNG, Track, mono_to_stereo, samples
from lib import sfx, synth


def pan_x(x: float, cam_x: float = 0.0, half: float = 8.0) -> float:
    return float(np.clip((x - cam_x) / half, -0.9, 0.9))


class Design:
    def __init__(self, ev: dict, duration: float):
        self.ev = ev
        self.T = {k: Track(duration, k) for k in ["amb", "fx", "fx_hall", "foley", "exempt_fx"]}

    def add(self, track, clip, t, gain=1.0, pan=0.0):
        self.T[track].add(clip, t, gain=gain, pan=pan)

    def write(self):
        ev = self.ev
        cues = ev["cues"]
        A = self.add

        # ---------------- ambience beds
        A("amb", sfx.wind(19.0, 0.55, 0.4, seed=1), 0.0)
        A("amb", sfx.crickets(14.5, 1.0, seed=2), 1.2)
        A("amb", sfx.birds(4.5, 7, seed=3), 15.2)
        A("amb", sfx.wind(6.5, 1.0, 0.9, seed=4), 18.0)
        A("amb", sfx.birds(6.0, 5, seed=5), 24.5, gain=0.7)
        A("amb", sfx.wind(12.5, 0.4, 0.3, seed=6), 24.0)
        A("amb", sfx.rumble(14.0, 0.35, 70), 37.5)
        A("amb", sfx.wind(22.0, 0.45, 0.4, seed=7), 51.0)
        A("amb", sfx.crickets(34.0, 0.8, seed=8), 62.0, gain=0.9)
        A("amb", sfx.wind(14.0, 0.35, 0.3, seed=9), 96.0)
        A("amb", sfx.wind(12.0, 0.22, 0.2, seed=10), 110.0)

        # ---------------- act 1: the seed
        for t in ev["heartbeats"]:
            A("fx", mono_to_stereo(synth.heartbeat(0.55 if t < 5 else 0.4)), t)
        A("fx_hall", sfx.sparkles(1.4, 18, 3000, 9000, 0.5, seed=11), 0.7)
        A("fx", sfx.whoosh(3.0, 3000, 600, 0.35, 0.5, 0.1, peak=0.75), 3.0)
        A("fx_hall", sfx.sparkles(3.0, 40, 3500, 9000, 0.35, seed=12), 3.0)
        # landing
        A("fx", sfx.thud(0.35, 90, 0.6), 9.0)
        A("fx_hall", sfx.sparkles(1.6, 60, 2500, 8000, 0.8, seed=13, density_curve=lambda u: np.exp(-4 * u)), 9.0)
        A("fx", sfx.rustle(0.6, 0.25, seed=14), 9.1)
        A("fx", mono_to_stereo(sfx.pop(0.3, 900)), 12.05)
        A("fx", sfx.rustle(0.5, 0.2, seed=15), 12.1)
        A("fx_hall", sfx.sparkles(1.2, 26, 3000, 8000, 0.5, seed=16, density_curve=lambda u: np.exp(-3 * u)), 12.05)
        A("foley", mono_to_stereo(sfx.paper_tap(0.35), -0.3), 13.62)

        # ---------------- act 2: the rush
        for t in (18.0, 19.5, 21.0, 22.5):
            A("fx", sfx.whoosh(1.6, 300, 3000, 0.35, -0.6, 0.6, peak=0.5), t - 0.3)
        for t in (19.2, 20.6, 22.0):
            A("fx", mono_to_stereo(sfx.wood_creak(1.4, 0.4, seed=int(t * 10)), 0.1), t)
        for t in (22.5, 23.25, 24.0):
            A("fx", sfx.rustle(0.8, 0.5, seed=int(t * 10)), t)
            A("fx_hall", sfx.sparkles(0.7, 20, 3000, 9000, 0.35, seed=int(t * 7)), t)
        box_pan = {k: pan_x(v, 0.0, 8.0) for k, v in ev["boxX"].items()}
        for t, cat in zip(ev["glassAppear"], ["siamese", "ragdoll", "maine"]):
            A("fx_hall", sfx.glass_materialise(0.5, seed=int(t * 100)), t, pan=box_pan[cat])
        # the person running between cases
        for seg in ev["route"]:
            if seg["mode"] == "run":
                n = int((seg["t1"] - seg["t0"]) / 0.23)
                for k in range(n):
                    u = (k + 0.5) / n
                    x = seg["x0"] + (seg["x1"] - seg["x0"]) * u
                    A("foley", mono_to_stereo(sfx.footstep_grass(0.35, seed=k + int(seg["t0"] * 10)), pan_x(x)), seg["t0"] + k * 0.23)
        # paper planes: throw, flight, catch
        def where(name, t):
            if name == "person":
                for seg in ev["route"]:
                    if seg["t0"] <= t <= seg["t1"]:
                        u = (t - seg["t0"]) / max(1e-6, seg["t1"] - seg["t0"])
                        return seg["x0"] + (seg["x1"] - seg["x0"]) * u
                return 0.6
            return ev["boxX"][name]
        for f in ev["flights"]:
            x0 = where(f["from"], f["t0"])
            x1 = where(f["to"], f["t1"])
            if f["from"] == "person":
                A("foley", mono_to_stereo(sfx.paper_throw(0.4), pan_x(x0)), f["t0"] - 0.05)
            A("foley", sfx.paper_flight(f["t1"] - f["t0"], pan_x(x0), pan_x(x1), 0.55, seed=int(f["t0"] * 10)), f["t0"])
            A("foley", mono_to_stereo(sfx.paper_tap(0.4), pan_x(x1)), f["t1"])
        for t in ev["knocks"]:
            A("fx", mono_to_stereo(sfx.glass_knock(0.55, seed=int(t * 100)), box_pan["siamese"]), t)
        # the crack (35.25) and the shatter (36.0)
        for i, cat in enumerate(["siamese", "ragdoll", "maine"]):
            A("fx", mono_to_stereo(sfx.glass_crack(0.7, seed=30 + i), box_pan[cat]), cues["crack"] + i * 0.06)
        for i, cat in enumerate(["siamese", "ragdoll", "maine"]):
            A("fx_hall", sfx.glass_shatter(slowmo=1.6, vel=0.9, seed=40 + i), cues["shatter"] + i * 0.01, pan=box_pan[cat] * 0.6)

        # ---------------- act 3: taking root
        A("fx", sfx.whoosh(2.0, 2400, 180, 0.6, 0.0, 0.0, peak=0.35), cues["dive"])
        A("fx", sfx.thud(0.35, 60, 0.8), 38.95)
        for i, (t, pan) in enumerate(((38.65, -0.3), (38.5, -0.6), (38.8, 0.5))):
            A("fx_hall", sfx.sparkles(1.6, 40, 2500, 7000, 0.45, seed=50 + i, density_curve=lambda u: 0.4 + 0.6 * u, pan_spread=0.3), t, pan=pan)
        A("fx_hall", sfx.sparkles(2.2, 70, 2000, 8000, 0.6, seed=53, density_curve=lambda u: np.exp(-2.5 * u)), 40.2)
        for k in range(13):
            A("fx", mono_to_stereo(sfx.root_pulse(0.35 * (1 - k / 18))), 40.5 + k * 0.75)
        A("fx", sfx.whoosh(1.0, 300, 1800, 0.35), 44.9)
        A("fx", sfx.whoosh(1.1, 1800, 300, 0.3), 50.1)
        A("fx", sfx.whoosh(2.4, 200, 2600, 0.45, peak=0.6), cues["rise"])

        # ---------------- act 4: entrusting
        A("foley", mono_to_stereo(sfx.thud(0.25, 180, 0.3), -0.1), 54.95)
        A("fx", mono_to_stereo(sfx.lantern_catch(0.45), -0.1), 55.0)
        steps = np.arange(56.6, 61.0, 0.49)
        for k, t in enumerate(steps):
            A("foley", mono_to_stereo(sfx.footstep_grass(0.4 * (1 - k / len(steps)) + 0.05, seed=200 + k), 0.1 + 0.08 * k), t)
        for k, t in enumerate(ev["lanternOn"]):
            A("fx", mono_to_stereo(sfx.lantern_catch(0.3, seed=k), -0.5 + k * 0.2), t)
        for t0, t1 in ((61.5, 62.2), (63.0, 63.7)):
            A("fx", sfx.whoosh(t1 - t0 + 0.2, 800, 3000, 0.3, -0.3, 0.3, peak=0.5), t0 - 0.05)
            A("fx_hall", sfx.sparkles(t1 - t0, 12, 3000, 8000, 0.35, seed=int(t0)), t0)
        A("fx", mono_to_stereo(sfx.zing(0.45), 0.3), cues["chain"])
        A("fx", sfx.warning_hum(5.9, 0.4), cues["chain"])
        for k, t in enumerate(ev["lanternDim"]):
            A("fx", mono_to_stereo(sfx.dim_down(0.45), 0.7 - k * 0.2), t)
        for k in range(8):
            A("fx" if 66.0 + k * 0.75 < 69.0 else "exempt_fx", mono_to_stereo(synth.heartbeat(0.3 + 0.05 * min(k, 4))), 66.0 + k * 0.75)
        for k, t in enumerate(ev["lanternRelight"]):
            A("fx", mono_to_stereo(sfx.lantern_catch(0.35, seed=20 + k), 0.2 + k * 0.15), t)
        A("fx_hall", sfx.sparkles(1.1, 30, 2500, 8000, 0.45, seed=71), 70.5)
        A("fx", sfx.whoosh(1.4, 400, 5000, 0.35, 0.3, -0.2, peak=0.7), cues["deliver"])
        A("fx_hall", sfx.sparkles(3.0, 160, 2500, 10000, 0.9, seed=74, density_curve=lambda u: np.exp(-1.6 * u)), 74.8)

        # ---------------- act 5: fruit
        for t, pan in ((78.0, 0.0), (84.0, 0.0), (90.0, 0.0)):
            A("fx", mono_to_stereo(sfx.pop(0.35, 520)), t - 0.02, pan=pan)
            A("fx_hall", sfx.sparkles(1.8, 45, 2500, 9000, 0.6, seed=int(t), density_curve=lambda u: np.exp(-3 * u)), t)
        A("fx_hall", sfx.sparkles(3.0, 70, 3000, 10000, 0.45, seed=93), 93.0)

        # ---------------- act 6: forest
        A("fx", sfx.whoosh(0.8, 2000, 500, 0.3, 0.0, 0.2, peak=0.8), 96.0)
        A("foley", mono_to_stereo(sfx.thud(0.4, 150, 0.4), 0.1), 96.75)
        A("foley", mono_to_stereo(sfx.thud(0.2, 170, 0.3), 0.2), 97.2)
        A("foley", sfx.rumble(0.9, 0.25, 160), 97.2)
        A("fx", sfx.whoosh(1.2, 300, 4000, 0.35), 98.3)
        A("fx_hall", sfx.sparkles(2.0, 70, 2500, 9000, 0.75, seed=98, density_curve=lambda u: np.exp(-2.5 * u)), 98.3)
        for tr in ev["forest"][1:]:
            A("fx", mono_to_stereo(sfx.pop(0.2, 600), pan_x(tr["x"], 0, 160)), tr["at"])
            A("fx", mono_to_stereo(sfx.wood_creak(1.6, 0.25, seed=int(tr["at"] * 10)), pan_x(tr["x"], 0, 160)), tr["at"] + 0.4)
        A("fx_hall", sfx.sparkles(1.6, 40, 3000, 9000, 0.35, seed=103, density_curve=lambda u: 0.3 + 0.7 * u), 102.8)
        A("fx_hall", sfx.sparkles(7.0, 120, 4000, 11000, 0.22, seed=104), 104.0)
        cloud = sfx.sparkles(2.3, 160, 3000, 10000, 0.6, seed=108, density_curve=lambda u: np.exp(-3 * u))
        A("fx_hall", cloud[::-1].copy(), 111.0 - len(cloud) / SR)
        A("fx_hall", sfx.sparkles(1.5, 40, 3000, 9000, 0.4, seed=111, density_curve=lambda u: np.exp(-3 * u)), 111.0)
        return self.T
