"""The score: 40 bars at 80 BPM in D major, written against timeline.json.

The "growing" motif is four rising notes, A-D-E-F#. It is first struck on
celesta as the seed lands, answered by flute at dawn, stated by solo horn
over the lit roots, carried by strings through the fruit, swelled by the
whole orchestra over the forest, and left alone on a music box at the end.

Theme (8 bars):  A4 D5 E5 F#5 | A5 . . F#5 | G5 F#5 E5 D5 | E5 . . .
                 A4 D5 E5 F#5 | B5 . . A5  | G5 F#5 E5. D5 | D5 . . .
"""

from __future__ import annotations

import numpy as np

from lib.dsp import SR, RNG, Track, nm, samples, mono_to_stereo
from lib import synth

BEAT = 0.75
BAR = 3.0


def at(bar: int, beat: float = 0.0) -> float:
    return (bar - 1) * BAR + beat * BEAT


def notes(line: str) -> list[int]:
    return [nm(s) for s in line.split()]


CH = {
    "D": "D2 A2 D3 F#3 A3 D4",
    "D/F#": "F#1 F#2 D3 A3 D4 F#4",
    "D/A": "A1 A2 D3 F#3 A3 D4",
    "Dadd9": "D2 A2 D3 F#3 A3 E4",
    "Bm": "B1 F#2 B2 D3 F#3 B3",
    "Bm7": "B1 F#2 A2 D3 F#3 A3",
    "G": "G1 D2 G2 B2 D3 G3",
    "G/D": "D2 G2 B2 D3 G3 B3",
    "A": "A1 E2 A2 C#3 E3 A3",
    "A/C#": "C#2 A2 C#3 E3 A3",
    "A7": "A1 E2 G2 C#3 E3 G3",
    "Asus": "A1 E2 A2 D3 E3 A3",
    "Em7": "E2 B2 D3 G3 B3 D4",
    "Em": "E2 B2 E3 G3 B3",
    "F#": "F#1 C#2 F#2 A#2 C#3 F#3",
    "F#sus4": "F#1 C#2 F#2 B2 C#3 F#3",
}

T1 = [("A4", 1), ("D5", 1), ("E5", 1), ("F#5", 1), ("A5", 3), ("F#5", 1), ("G5", 1), ("F#5", 1), ("E5", 1), ("D5", 1), ("E5", 4)]
T2 = [("A4", 1), ("D5", 1), ("E5", 1), ("F#5", 1), ("B5", 3), ("A5", 1), ("G5", 1), ("F#5", 1), ("E5", 1.5), ("D5", 0.5), ("D5", 4)]


def line(t0: float, seq, beat: float = BEAT):
    t = t0
    for n, b in seq:
        if n:
            yield nm(n), t, b * beat
        t += b * beat


class Score:
    def __init__(self, orc, duration: float):
        self.o = orc
        self.T = {k: Track(duration, k) for k in ["strings", "brass", "winds", "keys", "bells", "choir", "perc", "musicbox", "sub", "exempt_m"]}

    # ------------------------------------------------------------ helpers
    def chord(self, name_or_notes, t: float, dur: float, vel: float = 0.5, attack: float = 0.4, release: float = 1.5,
              inst: str = "strings", track: str = "strings", spread: float = 0.6, humanize: float = 0.012, top: int = 0,
              offset: float = 0.0):
        ns = notes(CH[name_or_notes]) if isinstance(name_or_notes, str) and name_or_notes in CH else (
            notes(name_or_notes) if isinstance(name_or_notes, str) else list(name_or_notes))
        if top:
            ns = ns + [n + 12 for n in ns[-top:]]
        for i, m in enumerate(ns):
            pan = (i / max(1, len(ns) - 1) - 0.5) * 2 * spread
            dt = RNG.uniform(-humanize, humanize)
            v = vel * (0.62 if m < 43 else 0.8 if m < 48 else 1.0) * RNG.uniform(0.94, 1.04)
            y = self.o[inst].note(m, dur, v, attack=attack, release=release, detune=RNG.uniform(-4, 4), offset=offset)
            self.T[track].add(y, t + dt, gain=1.0 / np.sqrt(len(ns)), pan=pan)

    def melody(self, seq_iter, inst: str, track: str, vel: float = 0.7, legato: float = 1.12, attack: float = 0.06,
               release: float = 0.7, pan: float = 0.0, octave: int = 0, gain: float = 1.0, offset: float | None = None):
        # sampled strings swell in slowly; melodic lines start a little into the bow
        off = offset if offset is not None else (0.22 if inst.startswith("strings") else 0.0)
        for m, t, d in seq_iter:
            y = self.o[inst].note(m + 12 * octave, d * legato, vel, attack=attack, release=release, offset=off)
            self.T[track].add(y, t, gain=gain, pan=pan)

    def mallet(self, fn, m, t, vel=0.6, dur=3.0, track="keys", pan=0.0, gain=1.0):
        y = fn(m, dur, vel)
        self.T[track].add(mono_to_stereo(y, pan), t, gain=gain)

    def arp(self, fn, names: str, t0: float, step: float, count: int, vel=0.4, track="keys", pan_spread=0.5, updown=True,
            dur=3.0, gain=1.0, cresc=0.0):
        ns = notes(names)
        seq = ns + (ns[-2:0:-1] if updown else [])
        for k in range(count):
            m = seq[k % len(seq)]
            v = vel * (1 + cresc * k / max(1, count - 1)) * RNG.uniform(0.9, 1.05)
            pan = ((k % len(seq)) / max(1, len(seq) - 1) - 0.5) * 2 * pan_spread
            self.mallet(fn, m, t0 + k * step + RNG.uniform(-0.006, 0.006), v, dur, track, pan, gain)

    def gliss(self, fn, names: str, t0: float, dur: float, vel=0.4, track="keys", gain=1.0):
        ns = notes(names)
        for k, m in enumerate(ns):
            u = k / max(1, len(ns) - 1)
            self.mallet(fn, m, t0 + u * dur, vel * (0.7 + 0.3 * np.sin(np.pi * u)), 2.5, track, (u - 0.5) * 1.2, gain)

    # ------------------------------------------------------------ the film
    def write(self):
        o = self
        c = synth
        # ================= ACT 1 — seed (bars 1-6)
        o.chord("D2 A2 D3", 0.3, 8.7, 0.22, attack=3.0, release=2.0)
        o.chord("F#3 A3", 3.0, 6.0, 0.16, attack=2.5, release=1.5)
        o.T["choir"].add(c.choir(notes("D4 A4"), 8.0, 0.1, vowel="oo", attack=3.0), 0.5)
        o.mallet(c.celesta, nm("F#6"), 0.9, 0.28, pan=0.4)
        o.mallet(c.celesta, nm("A6"), 2.4, 0.22, pan=0.5)
        # the star falls
        o.gliss(c.celesta, "D7 A6 F#6 E6 D6 A5 F#5 E5 D5", 3.05, 2.4, 0.32)
        o.T["sub"].add(c.riser(2.8, 1200, 300, 0.12, tonal=0.0), 3.0)
        # it floats down like a dandelion seed
        o.chord("G3 B3 D4", 6.0, 3.0, 0.2, attack=1.2, release=1.0)
        o.arp(c.harp, "D3 G3 B3 D4 G4 B4", 6.0, 0.375, 8, vel=0.32)
        o.T["perc"].add(mono_to_stereo(c.timpani_roll(nm("D2"), 1.4, 0.05, 0.45)), 7.6)
        # it lands (9.0): the motif is struck for the first time
        o.T["sub"].add(mono_to_stereo(c.sub_drop(2.5, 60, 32, 0.5)), 9.0)
        o.T["perc"].add(mono_to_stereo(c.timpani(nm("D2"), 3.0, 0.5)), 9.0)
        o.gliss(c.harp, "D3 F#3 A3 D4 F#4 A4 D5 F#5 A5 D6", 9.0, 0.55, 0.42)
        o.chord("D", 9.0, 3.0, 0.4, attack=0.7, release=1.2)
        for m, t, d in line(at(4), [("A4", 1), ("D5", 1), ("E5", 1), ("F#5", 1)]):
            o.mallet(c.celesta, m, t, 0.55, 3.5, pan=-0.1)
            o.mallet(c.crotale, m + 24, t, 0.12, 4.0, track="bells", pan=0.3)
        # the sprout (12.0), Ragdoll's paw (13.5)
        o.mallet(c.glock, nm("A5"), 12.0, 0.45, pan=0.1)
        o.mallet(c.glock, nm("D6"), 12.03, 0.35, pan=-0.1)
        o.mallet(c.celesta, nm("A5"), 12.0, 0.5, 4.0)
        o.mallet(c.celesta, nm("F#5"), at(5, 3), 0.45, 3.0)
        o.chord("Bm", 12.0, 3.0, 0.42, attack=0.6, release=1.2)
        o.mallet(c.pizz, nm("D4"), 13.5, 0.55, 1.2, track="strings", pan=-0.3)
        # dawn: flute answers
        o.chord("G", 15.0, 1.5, 0.5, attack=0.5, release=0.6)
        o.chord("A", 16.5, 1.5, 0.58, attack=0.4, release=0.6)
        o.melody(line(at(6), [("G5", 1), ("F#5", 1), ("E5", 1), ("D5", 1)]), "flute", "winds", 0.6, pan=0.15)
        o.arp(c.harp, "G3 B3 D4 G4 B4 D5", 15.0, 0.375, 4, vel=0.35)
        o.arp(c.harp, "A3 C#4 E4 A4 C#5 E5", 16.5, 0.1875, 8, vel=0.38, updown=False, cresc=0.4)
        o.T["perc"].add(mono_to_stereo(c.cymbal(2.2, 0.35, swell=True)), 15.8)
        o.T["sub"].add(c.riser(2.0, 400, 5000, 0.18), 16.0)

        # ================= ACT 2 — the rush (bars 7-12)
        o.chord("D", 18.0, 3.0, 0.55, attack=0.12, release=0.6, inst="strings_fast")
        o.chord("A/C#", 21.0, 3.0, 0.55, attack=0.12, release=0.6, inst="strings_fast")
        o.melody(line(at(7), T1[:6]), "horns", "brass", 0.62, pan=-0.1)
        o.melody(line(at(7), T1[:6]), "strings_fast", "strings", 0.45, octave=0, gain=0.6)
        # spiccato-ish ostinato: short slices of sustained strings
        pat = ["D3", "A3", "F#3", "A3"] * 4 + ["C#3", "A3", "E3", "A3"] * 4
        for k, n in enumerate(pat):
            y = o.o["strings_fast"].note(nm(n), 0.14, 0.6 if k % 4 == 0 else 0.45, attack=0.004, release=0.12, offset=0.6)
            o.T["strings"].add(y, 18.0 + k * 0.375, gain=0.5, pan=-0.35 if k % 2 else 0.35)
        o.arp(c.harp, "D4 F#4 A4 D5 F#5 A5", 18.0, 0.1875, 16, vel=0.3, gain=0.8)
        o.arp(c.harp, "C#4 E4 A4 C#5 E5 A5", 21.0, 0.1875, 16, vel=0.3, gain=0.8)
        for tt in (18.0, 21.0):
            o.T["perc"].add(mono_to_stereo(c.timpani(nm("D2") if tt == 18 else nm("A1"), 2.5, 0.55)), tt)
        # the leaves renew overnight: three shimmering flips
        for tt, base in ((22.5, "A5 B5 D6 E6 F#6"), (23.25, "B5 D6 E6 F#6 A6"), (24.0, "D6 E6 F#6 A6 B6")):
            o.gliss(c.celesta, base, tt, 0.45, 0.3)
        # glass cases (24): the music turns mechanical, in B minor
        chords2 = [("Bm", 24.0), ("G", 27.0), ("Em", 30.0)]
        pats = {"Bm": "B3 F#3 D4 F#3", "G": "G3 D4 B3 D4", "Em": "E3 B3 G3 B3"}
        for ch, t0 in chords2:
            o.chord(ch, t0, 3.0, 0.3, attack=0.3, release=0.4)
            ns = notes(pats[ch])
            for k in range(8):
                o.mallet(c.pizz, ns[k % 4], t0 + k * 0.375, 0.6 if k % 4 == 0 else 0.45, 1.0, track="strings",
                         pan=-0.25 if k % 2 else 0.25)
        for k in range(8 * 3 + 6):
            o.T["perc"].add(mono_to_stereo(__import__("lib.sfx", fromlist=["x"]).clock_tick(k % 2 == 0, 0.35), 0.2), 24.0 + k * 0.375)
        for t0, ch in ((27.0, "G3 B3 D4"), (28.5, "G3 B3 D4"), (30.0, "E3 G3 B3"), (30.75, "E3 G3 B3"), (31.5, "E3 G3 B3")):
            for m in notes(ch):
                o.T["brass"].add(o.o["horns_stac"].note(m, 0.3, 0.55, attack=0.005, release=0.2), t0, gain=0.5)
        # pressure (33 - 35.25): F#sus4 -> F#, tremolo, roll, riser
        trem = np.clip(0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 7.5 * np.arange(int(2.6 * SR)) / SR)), 0.2, 1)
        for ch, t0, d in (("F#sus4", 33.0, 1.5), ("F#", 34.5, 0.75)):
            for m in notes(CH[ch]):
                y = o.o["strings_fast"].note(m, d, 0.5 + 0.2 * (t0 > 34), attack=0.2, release=0.08, offset=0.4)
                y = y * trem[: len(y), None]
                o.T["strings"].add(y, t0, gain=0.45)
        o.T["perc"].add(mono_to_stereo(c.timpani_roll(nm("F#2"), 2.25, 0.15, 0.9)), 33.0)
        o.T["sub"].add(c.riser(2.25, 250, 9000, 0.35, tonal=0.5), 33.0)
        for m in notes("F#3 C#4 F#4"):
            y = o.o["horns"].note(m, 2.2, 0.5, attack=1.6, release=0.08)
            o.T["brass"].add(y, 33.05, gain=0.5)
        # the held breath (35.3 - 36): a high harmonic and a reversed cymbal
        o.T["exempt_m"].add(o.o["strings"].note(nm("F#6"), 0.7, 0.2, attack=0.1, release=0.1), 35.3, gain=0.5)
        o.T["exempt_m"].add(mono_to_stereo(c.reverse(c.cymbal(0.75, 0.6))), 35.25, gain=0.9)

        # ================= ACT 3 — taking root (bars 13-18)
        # the shatter (36.0): orchestral hit
        for inst, ch, v in (("trumpets", "D5 F#5 A5", 0.9), ("horns_f", "D4 F#4 A4 D5", 0.9), ("trombones", "D3 A3 D4", 0.9), ("tuba", "D2", 0.9)):
            for m in notes(ch):
                y = o.o[inst].note(m, 1.2, v, attack=0.004, release=1.6)
                o.T["brass"].add(y, 36.0, gain=0.55, pan=RNG.uniform(-0.4, 0.4))
        o.chord("D2 D3 A3 F#4 A4 D5", 36.0, 1.8, 0.8, attack=0.004, release=2.2, inst="strings_fast", offset=0.5)  # hit
        o.T["perc"].add(mono_to_stereo(c.taiko(2.2, 1.0, 50)), 36.0)
        o.T["perc"].add(mono_to_stereo(c.taiko(2.0, 0.7, 62)), 36.03)
        o.T["perc"].add(mono_to_stereo(c.cymbal(4.5, 0.75)), 36.0)
        o.T["sub"].add(mono_to_stereo(c.sub_drop(3.0, 75, 28, 1.0)), 36.0)
        # suspended in slow motion
        o.chord("D3 A3 E4", 36.6, 3.2, 0.26, attack=1.0, release=2.0)
        o.T["choir"].add(c.choir(notes("D4 A4 E5"), 3.0, 0.18, attack=1.2), 36.6)
        # three streams run down (per cat), meeting at the collar (40.2)
        o.gliss(c.celesta, "A6 F#6 E6 D6 B5 A5", 38.65, 1.4, 0.3)
        o.gliss(c.celesta, "E6 D6 B5 A5 F#5 E5", 38.5, 1.5, 0.28)
        o.gliss(c.celesta, "F#6 E6 D6 B5 A5 F#5", 38.8, 1.3, 0.28)
        o.chord("D", 40.2, 1.8, 0.55, attack=0.25, release=1.0, top=1)
        o.T["choir"].add(c.choir(notes("D4 F#4 A4 D5"), 1.8, 0.28, attack=0.4), 40.2)
        o.gliss(c.harp, "D3 A3 D4 F#4 A4 D5 F#5 A5", 40.2, 0.6, 0.45)
        o.T["sub"].add(mono_to_stereo(c.sub_drop(2.0, 55, 35, 0.6)), 40.2)
        # the horn states the theme over the lit roots
        o.chord("D/F#", at(15), 3.0, 0.45, attack=0.6, release=0.8)
        o.chord("Bm7", at(16), 3.0, 0.45, attack=0.5, release=0.8)
        o.chord("G", at(17), 3.0, 0.47, attack=0.5, release=0.8)
        o.chord("A", at(18), 3.0, 0.5, attack=0.5, release=1.2)
        o.melody(line(at(15), T1), "horn_solo", "brass", 0.72, pan=-0.15, legato=1.05)
        o.T["choir"].add(c.choir(notes("B3 D4 F#4"), 3.0, 0.16, attack=1.0), at(16))
        o.T["choir"].add(c.choir(notes("G3 B3 D4"), 3.0, 0.16, attack=1.0), at(17))
        # the rings light (every 0.36 s from 45.75): crotales up the pentatonic
        ring_notes = notes("D5 E5 F#5 A5 B5 D6 E6 F#6 A6 B6 D7 E7")
        for k, m in enumerate(ring_notes):
            o.mallet(c.crotale, m, 45.75 + k * 0.36, 0.34 * (1 - k / 20), 5.0, track="bells", pan=np.sin(k * 1.3) * 0.6)
        o.gliss(c.harp, "A3 E4 A4 C#5 E5 A5 C#6", at(18, 2), 0.7, 0.4)

        # ================= ACT 4 — entrusting (bars 19-25)
        o.chord("G", at(19), 3.0, 0.32, attack=1.2, release=1.0)
        o.chord("D/F#", at(20), 3.0, 0.32, attack=0.9, release=1.0)
        o.chord("Em7", at(21), 3.0, 0.34, attack=0.9, release=1.0)
        o.chord("A", at(22), 3.0, 0.36, attack=0.9, release=1.0)
        flute = [("D5", 3), ("B4", 1), ("A4", 2), ("D5", 1), ("E5", 1), ("F#5", 3), ("E5", 1), ("E5", 2), ("D5", 1), ("C#5", 1)]
        o.melody(line(at(19), flute), "flute", "winds", 0.55, pan=0.2, legato=1.08, attack=0.1)
        o.melody(line(at(21), [("B3", 4), ("C#4", 4)]), "clarinet", "winds", 0.35, pan=-0.3)
        # the lanterns catch one by one
        for k, n in enumerate("B5 D6 E6 F#6 A6 B6".split()):
            o.mallet(c.celesta, nm(n), 60.0 + k * 0.4, 0.34, 3.0, pan=-0.5 + k * 0.2)
        # the relay: harp sweeps as the light passes
        o.gliss(c.harp, "E4 G4 B4 D5 E5 G5 B5", 61.5, 0.7, 0.35)
        o.gliss(c.harp, "E4 A4 C#5 E5 A5 C#6", 63.0, 0.7, 0.35)
        # the reach (64.5) and the chain (65.25): tension, then the dimming (one per beat)
        o.chord("B1 F#2 B2 C3", at(22, 2), 1.6, 0.3, attack=0.8, release=0.3)
        tension = ["B1", "F#2", "B2", "D3", "G3", "C4"]
        for m in notes(" ".join(tension)):
            y = o.o["strings"].note(m, 3.0, 0.38, attack=0.4, release=0.25)
            tr = 0.75 + 0.25 * np.sin(2 * np.pi * 9 * np.arange(len(y)) / SR)
            o.T["strings"].add(y * tr[:, None], at(23), gain=0.42)
        for k, n in enumerate("F#5 D5 B4 F#4".split()):
            o.mallet(c.celesta, nm(n), at(23, k), 0.42 - 0.05 * k, 2.2, pan=0.4)
        # the paw stops (69.0): silence but a harmonic; the vine (70.5); relight (71.25...)
        o.T["exempt_m"].add(o.o["strings"].note(nm("D6"), 1.6, 0.18, attack=0.2, release=0.6), 69.0, gain=0.5)
        o.chord("G2 D3 G3 B3 D4", 70.5, 1.5, 0.4, attack=0.7, release=0.6)
        o.T["choir"].add(c.choir(notes("G3 B3 D4 G4"), 1.6, 0.3, attack=0.6), 70.5)
        o.gliss(c.harp, "G3 B3 D4 G4 B4 D5 G5 B5", 70.5, 0.9, 0.42)
        for k, n in enumerate("A5 D6 F#6 A6".split()):
            o.mallet(c.celesta, nm(n), 71.25 + k * 0.35, 0.45, 3.0, pan=-0.2 + k * 0.2)
            o.mallet(c.crotale, nm(n), 71.25 + k * 0.35, 0.12, 4.0, track="bells")
        o.chord("D/A", at(25), 1.5, 0.45, attack=0.5, release=0.5)
        o.chord("A7", at(25, 2), 1.5, 0.5, attack=0.4, release=0.4)
        o.melody(line(at(25), [("F#4", 2), ("G4", 2)]), "horns", "brass", 0.45, pan=-0.2)
        o.gliss(c.celesta, "A4 D5 E5 F#5 A5 B5 D6 E6 F#6 A6", 73.5, 1.25, 0.34)
        o.T["sub"].add(c.riser(1.5, 500, 9000, 0.3, tonal=0.4), 73.5)
        o.T["perc"].add(mono_to_stereo(c.cymbal(1.5, 0.5, swell=True)), 73.5)

        # ================= ACT 5 — fruit (bars 26-33): the theme, full
        prog5 = [("D", 26), ("Bm7", 27), ("G", 28), ("A", 29), ("D/F#", 30), ("G", 31), ("Em7", 32)]
        for ch, b in prog5:
            o.chord(ch, at(b), 3.0, 0.55 + 0.03 * (b - 26), attack=0.35, release=0.9, top=1)
        o.chord("A", at(32, 2), 1.5, 0.72, attack=0.3, release=0.6, top=1)
        o.chord("D", at(33), 3.0, 0.62, attack=0.1, release=2.5, top=1)
        full = T1 + T2
        o.melody(line(at(26), full[:len(T1)]), "strings_fast", "strings", 0.66, octave=0, legato=1.06, attack=0.08)
        o.melody(line(at(26), full[:len(T1)]), "strings_fast", "strings", 0.5, octave=1, legato=1.06, attack=0.08, gain=0.55)
        o.melody(line(at(30), T2), "strings_fast", "strings", 0.72, octave=0, legato=1.06, attack=0.06)
        o.melody(line(at(30), T2), "strings_fast", "strings", 0.58, octave=1, legato=1.06, attack=0.06, gain=0.6)
        o.melody(line(at(26), T1), "horns", "brass", 0.5, octave=-1, pan=-0.2, gain=0.7)
        o.melody(line(at(30), T2), "horns_f", "brass", 0.6, octave=-1, pan=-0.2, gain=0.75)
        o.melody(line(at(30), T2[:8]), "flute", "winds", 0.5, octave=1, pan=0.25, gain=0.5)
        for b, names in ((26, "D4 F#4 A4 D5 F#5 A5"), (27, "B3 D4 F#4 A4 B4 D5"), (28, "G3 B3 D4 G4 B4 D5"), (29, "A3 C#4 E4 A4 C#5 E5"),
                         (30, "F#3 A3 D4 F#4 A4 D5"), (31, "G3 B3 D4 G4 B4 D5"), (32, "E3 G3 B3 D4 E4 G4")):
            o.arp(c.harp, names, at(b), 0.375, 8, vel=0.3)
        o.T["perc"].add(mono_to_stereo(c.cymbal(3.0, 0.5)), 75.0)
        o.T["perc"].add(mono_to_stereo(c.timpani(nm("D2"), 3.0, 0.6)), 75.0)
        # each fruit: a bell chord on the downbeat
        for t0, bell, cro, gl in ((78.0, "D5", "A6", "F#6"), (84.0, "A4", "E6", "C#6"), (90.0, "G4", "B6", "D6")):
            o.mallet(c.tubular_bell, nm(bell), t0, 0.5, 7.0, track="bells", pan=0.1)
            o.mallet(c.crotale, nm(cro), t0, 0.35, 5.0, track="bells", pan=0.35)
            o.mallet(c.glock, nm(gl), t0 + 0.01, 0.35, 2.5, pan=-0.3)
        o.T["perc"].add(mono_to_stereo(c.timpani(nm("G1"), 3.0, 0.65)), 90.0)
        o.chord("G3 B3 D4 G4", 90.0, 3.0, 0.5, attack=0.05, release=1.0, inst="horns_f", track="brass", spread=0.4)
        # the whole tree, heavy with fruit: plinks in a wave
        rng = np.random.default_rng(93)
        penta = notes("D6 E6 F#6 A6 B6 D7 E7 F#7")
        for k in range(46):
            tt = 93.0 + (k / 46) * 2.4 + rng.uniform(0, 0.3)
            o.mallet(c.celesta, int(rng.choice(penta)), tt, 0.14, 2.0, pan=rng.uniform(-0.9, 0.9))
        o.T["perc"].add(mono_to_stereo(c.timpani_roll(nm("A1"), 1.5, 0.2, 0.75)), 94.5)
        o.T["perc"].add(mono_to_stereo(c.cymbal(1.5, 0.55, swell=True)), 94.5)
        # the fruit falls (96.0 -> 96.75)
        o.gliss(c.celesta, "D7 B6 A6 F#6 E6 D6 B5 A5", 96.0, 0.7, 0.3)
        o.mallet(c.glock, nm("A5"), 98.3, 0.45, 2.5)
        o.mallet(c.glock, nm("D6"), 98.33, 0.4, 2.5)
        o.mallet(c.crotale, nm("F#6"), 98.3, 0.3, 4.0, track="bells")

        # ================= ACT 6 — forest (bars 34-40)
        prog6 = [("D", 34), ("G", 35), ("Em7", 36)]
        for ch, b in prog6:
            o.chord(ch, at(b), 3.0, 0.62, attack=0.5, release=1.2, top=1)
        o.chord("A", at(36, 2), 1.5, 0.6, attack=0.4, release=0.8, top=1)
        o.chord("Dadd9", at(37), 3.0, 0.45, attack=0.8, release=2.5)
        forest = [("A4", 1), ("D5", 1), ("E5", 1), ("F#5", 1), ("B5", 3), ("A5", 1), ("G5", 1), ("F#5", 1), ("E5", 1.5), ("D5", 0.5), ("D5", 4)]
        o.melody(line(at(34), forest), "strings_fast", "strings", 0.72, legato=1.06)
        o.melody(line(at(34), forest), "strings_fast", "strings", 0.6, octave=1, legato=1.06, gain=0.6)
        o.melody(line(at(34), forest[:6]), "horns_f", "brass", 0.62, octave=-1, pan=-0.2, gain=0.8)
        o.melody(line(at(34), forest[:6]), "trumpets", "brass", 0.42, octave=0, pan=0.2, gain=0.45)
        o.T["perc"].add(mono_to_stereo(c.timpani(nm("D2"), 3.0, 0.65)), at(34))
        o.T["perc"].add(mono_to_stereo(c.cymbal(3.5, 0.45)), at(34))
        for k, n in enumerate("D5 E5 F#5 A5 B5 D6 E6 F#6".split()):
            o.mallet(c.glock, nm(n), [99.6, 99.9, 100.3, 100.6, 101.0, 101.2, 101.5, 101.7][k], 0.28, 2.5, pan=[0.1, -0.5, 0.5, -0.7, 0.7, -0.85, 0.85, -0.95][k])
        o.gliss(c.celesta, "D5 E5 F#5 A5 B5 D6 E6 F#6 A6 B6 D7", 102.8, 1.4, 0.24)
        o.T["choir"].add(c.choir(notes("D4 A4 D5 E5"), 6.5, 0.28, attack=2.5, release=3.0), 104.0)
        for m in notes("A5 D6"):
            o.T["strings"].add(o.o["strings"].note(m, 6.0, 0.2, attack=2.0, release=2.0), 105.0, gain=0.4)
        o.arp(c.harp, "D3 A3 D4 E4 F#4 A4", at(36), 0.75, 8, vel=0.25)
        o.arp(c.harp, "D3 A3 D4 E4 F#4 A4", at(37), 0.75, 4, vel=0.2)
        # the stars gather (108.6 -> 111): a reversed shimmer into the mark
        sw = np.zeros(int(2.6 * SR))
        for k in range(26):
            y = c.crotale(int(RNG.choice(notes("D6 E6 F#6 A6 B6 D7"))), 2.0, 0.3)
            i = int(RNG.uniform(0, 0.6) * SR)
            sw[i : i + len(y)] += y[: len(sw) - i]
        o.T["bells"].add(mono_to_stereo(c.reverse(sw) * 0.7), 111.0 - 2.6)
        # the mark (111.0): a warm chord and the motif, alone, on a music box
        o.chord("D2 A2 D3 F#3 A3 E4", 111.0, 5.5, 0.34, attack=0.6, release=4.0)
        o.chord("D4 F#4 A4", 111.0, 4.0, 0.3, attack=0.5, release=3.0, inst="horns", track="brass", spread=0.3)
        o.T["choir"].add(c.choir(notes("D4 F#4 A4"), 5.0, 0.16, attack=1.5, release=4.0), 111.0)
        o.mallet(c.tubular_bell, nm("D5"), 111.0, 0.4, 7.0, track="bells")
        box = [("A4", 1), ("D5", 1), ("E5", 1), ("F#5", 1), ("A5", 3), ("F#5", 1), ("E5", 2), ("D5", 2)]
        for m, t, d in line(at(38), box):
            o.mallet(c.music_box, m, t, 0.55, 4.0, track="musicbox", pan=0.05)
        o.chord("G/D", at(39), 3.0, 0.22, attack=1.0, release=1.5)
        o.chord("D2 A2 D3 F#3 A3", at(40), 3.0, 0.2, attack=1.0, release=4.5)
        o.mallet(c.glock, nm("D6"), at(40, 2), 0.2, 4.0, track="musicbox")
        return self.T
