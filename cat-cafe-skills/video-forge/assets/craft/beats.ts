// Scene timing comes from the narration, not from guesses. Input is the JSON that
// scripts/video-forge/align.py writes: [{index, word, start_ms, end_ms}, ...].
export type AlignedWord = { index: number; word: string; start_ms: number; end_ms: number };
// A beat starts on the word that motivates it.
export type BeatCue = { id: string; cueWordIndex: number };
export type Beat = { id: string; from: number; durationInFrames: number };

// Picture leads the cue word by `leadFrames`, so the change is already readable when the
// word lands. The last beat runs to the end of the narration plus `tailFrames`.
// Throws instead of guessing when a cue is missing or beats are out of order.
export const beatsFromAlignment = (
  words: AlignedWord[],
  cues: BeatCue[],
  fps: number,
  { leadFrames = 4, tailFrames = 30 }: { leadFrames?: number; tailFrames?: number } = {},
): Beat[] => {
  if (words.length === 0 || cues.length === 0) {
    throw new Error('beatsFromAlignment: need at least one aligned word and one cue');
  }
  const byIndex = new Map(words.map((w) => [w.index, w]));
  const starts = cues.map((cue) => {
    const word = byIndex.get(cue.cueWordIndex);
    if (!word) throw new Error(`beat "${cue.id}": cue word ${cue.cueWordIndex} is not in the alignment`);
    return Math.max(0, Math.round((word.start_ms / 1000) * fps) - leadFrames);
  });
  const end = Math.round((Math.max(...words.map((w) => w.end_ms)) / 1000) * fps) + tailFrames;
  return cues.map((cue, i) => {
    const next = i + 1 < cues.length ? starts[i + 1] : end;
    const durationInFrames = next - starts[i];
    if (durationInFrames <= 0) throw new Error(`beat "${cue.id}" has no duration; cues must be in spoken order`);
    return { id: cue.id, from: starts[i], durationInFrames };
  });
};
