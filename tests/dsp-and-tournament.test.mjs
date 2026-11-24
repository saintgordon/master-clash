import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAudioFile,
  fisherYatesShuffle,
  formatTime,
  formatTimeRange,
  analyzeLoudness,
  computeLoudnessMatchGains,
  findLoudestWindow,
  computeWaveformPeaks,
  computeBinomialPValue,
  encodeAudioBufferToWavBuffer,
} from '../js/audio-dsp.js';
import {
  TournamentEngine,
  generateMarkdownReport,
  generateJsonReport,
} from '../js/tournament.js';

function makeSineChannels(freqHz, amplitude, durationSec, sampleRate = 48000, channels = 2) {
  const len = Math.floor(durationSec * sampleRate);
  const out = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    }
    out.push(arr);
  }
  return out;
}

function makeFakeTrack(id, filename, lufs = -14.0) {
  return {
    id,
    filename,
    formatDesc: 'WAV 48kHz Stereo',
    duration: 180,
    sampleRate: 48000,
    channels: 2,
    sizeMb: '30.00',
    lufs,
    rmsDb: lufs - 0.5,
    samplePeakDb: -0.8,
    crestDb: 13.7,
    clipStart: 82.5,
    clipDuration: 15,
    slicedBuffer: { duration: 15 },
    slicePeaks: [0.2, 0.6, 0.9],
  };
}

test('evaluateAudioFile filters MASTER / MASTERED and strictly excludes UNMASTERED', () => {
  assert.equal(evaluateAudioFile('Song_MASTER_v1.wav').accepted, true);
  assert.equal(evaluateAudioFile('Song_mastered_final.flac').accepted, true);
  assert.equal(evaluateAudioFile('Song_UNMASTERED.wav').accepted, false);
  assert.equal(evaluateAudioFile('Song_UNMASTERED.wav').reason, 'unmastered');
  assert.equal(evaluateAudioFile('Song_un-master_rough.wav').reason, 'unmastered');
  assert.equal(evaluateAudioFile('Song_un_mastered.mp3').reason, 'unmastered');
  assert.equal(evaluateAudioFile('Song_Rough_Mix.wav').reason, 'not_master');
  assert.equal(evaluateAudioFile('._Song_MASTER.wav').reason, 'hidden');
  assert.equal(evaluateAudioFile('notes_MASTER.txt').reason, 'not_audio');

  // With master filter disabled, non-master & unmastered audio files are allowed
  assert.equal(evaluateAudioFile('Song_UNMASTERED.wav', { filterOnlyMasters: false }).accepted, true);
  assert.equal(evaluateAudioFile('Song_Rough_Mix.wav', { filterOnlyMasters: false }).accepted, true);
});

test('formatTime and formatTimeRange roll over minute boundaries accurately', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(112), '1:52');
  assert.equal(formatTime(127), '2:07');
  assert.equal(formatTimeRange(112, 15), '1:52 – 2:07');
  assert.equal(formatTime(15.0, true), '00:15.0');
  assert.equal(formatTime(65.4, true), '01:05.4');
});

test('fisherYatesShuffle preserves items without mutating input', () => {
  const original = [1, 2, 3, 4, 5, 6];
  const copy = [...original];
  let seed = 42;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const shuffled = fisherYatesShuffle(original, rng);
  assert.deepEqual(original, copy);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), original);
  assert.notDeepEqual(shuffled, original);
});

test('analyzeLoudness measures ITU-R BS.1770 K-weighted LUFS accurately', () => {
  const quiet = makeSineChannels(1000, 0.1, 2.0, 48000, 2); // -20 dBFS peak
  const loud = makeSineChannels(1000, 0.2, 2.0, 48000, 2); // +6.02 dB louder
  const subBass = makeSineChannels(35, 0.2, 2.0, 48000, 2); // Heavy RLB attenuation

  const mQuiet = analyzeLoudness(quiet, 48000);
  const mLoud = analyzeLoudness(loud, 48000);
  const mSub = analyzeLoudness(subBass, 48000);

  // +6 dB gain should raise LUFS by ~6.0 LU
  assert.ok(Math.abs((mLoud.lufs - mQuiet.lufs) - 6.0) < 0.25, `Expected ~6 dB delta, got ${mLoud.lufs - mQuiet.lufs}`);
  // K-weighting attenuates 35 Hz significantly relative to 1 kHz at identical amplitude
  assert.ok(mSub.lufs < mLoud.lufs - 3.0, `Expected 35Hz (${mSub.lufs}) < 1kHz (${mLoud.lufs})`);
  // Sample peak of 0.2 amplitude is ~ -14.0 dBFS
  assert.ok(Math.abs(mLoud.samplePeakDb - (-14.0)) < 0.2);
});

test('computeLoudnessMatchGains attenuates louder track and never boosts above unity', () => {
  const res = computeLoudnessMatchGains(-8.0, -14.0);
  assert.equal(res.gainB, 1.0);
  assert.ok(res.gainA < 1.0 && res.gainA > 0.49 && res.gainA < 0.51);
  assert.equal(res.deltaDb, 6.0);
  assert.equal(res.targetLufs, -14.0);
});

test('findLoudestWindow detects loud chorus segment accurately', () => {
  const sr = 8000;
  const totalSec = 30;
  const ch = new Float32Array(sr * totalSec);
  // Quiet background everywhere, loud chorus from 16s to 24s
  for (let i = 0; i < ch.length; i++) {
    const t = i / sr;
    const amp = t >= 16 && t <= 24 ? 0.8 : 0.08;
    ch[i] = amp * Math.sin(2 * Math.PI * 440 * t);
  }
  const win = findLoudestWindow([ch, ch], sr, 8);
  assert.ok(win.startTime >= 15.5 && win.startTime <= 16.5, `Expected ~16s, got ${win.startTime}`);
});

test('computeWaveformPeaks normalizes to [0, 1]', () => {
  const ch = new Float32Array(1000);
  ch[500] = 0.5;
  const peaks = computeWaveformPeaks([ch], 50);
  assert.equal(peaks.length, 50);
  assert.equal(Math.max(...peaks), 1);
  assert.equal(Math.min(...peaks), 0);
});

test('computeBinomialPValue returns exact one-tailed ABX significance values', () => {
  assert.ok(Math.abs(computeBinomialPValue(8, 8) - 1 / 256) < 1e-9);
  assert.ok(Math.abs(computeBinomialPValue(7, 8) - 9 / 256) < 1e-9);
  assert.ok(Math.abs(computeBinomialPValue(4, 8) - 163 / 256) < 1e-9);
  assert.equal(computeBinomialPValue(0, 8), 1.0);
});

test('encodeAudioBufferToWavBuffer writes valid RIFF WAVE header', () => {
  const fakeBuf = {
    numberOfChannels: 2,
    sampleRate: 44100,
    length: 100,
    getChannelData: () => new Float32Array(100),
  };
  const wav = encodeAudioBufferToWavBuffer(fakeBuf);
  assert.equal(wav.byteLength, 44 + 100 * 2 * 2);
  const magic = String.fromCharCode(...new Uint8Array(wav, 0, 4));
  const wave = String.fromCharCode(...new Uint8Array(wav, 8, 4));
  assert.equal(magic, 'RIFF');
  assert.equal(wave, 'WAVE');
});

test('TournamentEngine King of the Hill supports voting, Undo, Blind Notes, and reports', () => {
  const engine = new TournamentEngine(() => 0.25);
  const tracks = [
    makeFakeTrack('t1', 'Track_MASTER_v1.wav', -14.0),
    makeFakeTrack('t2', 'Track_MASTER_v2.wav', -11.5),
    makeFakeTrack('t3', 'Track_MASTER_v3.wav', -9.0),
  ];

  const m1 = engine.start(tracks, { mode: 'koth' });
  assert.equal(m1.matchNumber, 1);
  assert.equal(m1.totalMatches, 2);
  assert.equal(m1.canUndo, false);

  // Add blind note & tag to side A
  engine.toggleTagForSide('A', 'Warm');
  engine.setNoteForSide('A', 'Nice punch in the low mids');

  const r1 = engine.vote('A');
  assert.equal(r1.completed, false);
  assert.equal(r1.match.matchNumber, 2);
  assert.equal(r1.match.canUndo, true);

  // Undo reverts back to match 1 with exact same blindMap
  const undone = engine.undo();
  assert.equal(undone.matchNumber, 1);
  assert.equal(undone.blindMap.A.id, m1.blindMap.A.id);
  assert.equal(undone.canUndo, false);

  // Vote through to completion
  engine.vote('A');
  const finalRes = engine.vote('B');
  assert.equal(finalRes.completed, true);
  assert.ok(finalRes.summary.winner);

  const md = generateMarkdownReport(finalRes.summary);
  assert.ok(md.includes('Saint Gordon Collective'));
  assert.ok(md.includes('Nice punch in the low mids'));

  const parsedJson = JSON.parse(generateJsonReport(finalRes.summary));
  assert.equal(parsedJson.mode, 'koth');
  assert.equal(parsedJson.rankings.length, 3);
});

test('TournamentEngine Round-Robin includes hidden consistency check and computes rankings', () => {
  const engine = new TournamentEngine(() => 0.4);
  const tracks = [
    makeFakeTrack('t1', 'Alpha_MASTER.wav', -14.0),
    makeFakeTrack('t2', 'Beta_MASTER.wav', -13.0),
    makeFakeTrack('t3', 'Gamma_MASTER.wav', -12.0),
  ];

  const first = engine.start(tracks, { mode: 'round-robin' });
  // 3 unique pairs + 1 hidden consistency check = 4 total matches
  assert.equal(first.totalMatches, 4);

  // Always pick track with lowest id to guarantee 100% consistency
  let res;
  for (let i = 0; i < 4; i++) {
    const cur = engine.getCurrentMatch();
    const pick = cur.blindMap.A.id < cur.blindMap.B.id ? 'A' : 'B';
    res = engine.vote(pick);
  }
  assert.equal(res.completed, true);
  assert.equal(res.summary.winner.id, 't1');
  assert.equal(res.summary.consistency.totalChecks, 1);
  assert.equal(res.summary.consistency.scorePct, 100);
  assert.equal(res.summary.rankings[0].track.id, 't1');
  assert.equal(res.summary.rankings[0].wins, 2);
});

test('TournamentEngine ABX enforces 2 tracks and computes exact significance', () => {
  const engine = new TournamentEngine(() => 0.2);
  const t1 = makeFakeTrack('a', 'RefA_MASTER.wav', -14);
  const t2 = makeFakeTrack('b', 'RefB_MASTER.wav', -14);
  const t3 = makeFakeTrack('c', 'RefC_MASTER.wav', -14);

  assert.throws(() => engine.start([t1, t2, t3], { mode: 'abx' }));

  engine.start([t1, t2], { mode: 'abx', abxTrials: 8 });
  let res;
  for (let i = 0; i < 8; i++) {
    const cur = engine.getCurrentMatch();
    const correctSide = cur.blindMap.X.id === cur.blindMap.A.id ? 'A' : 'B';
    res = engine.vote(correctSide);
  }
  assert.equal(res.completed, true);
  assert.equal(res.summary.abx.correct, 8);
  assert.equal(res.summary.abx.total, 8);
  assert.equal(res.summary.abx.significant, true);
  assert.ok(res.summary.abx.pValue < 0.01);

  const md = generateMarkdownReport(res.summary);
  assert.ok(md.includes('ABX Verdict'));
  assert.ok(md.includes('8 / 8'));
});
