/**
 * Zero-Bloat Client-Side Demo Shootout Synthesizer.
 * Synthesizes a 16-second stereo moody studio instrumental via OfflineAudioContext
 * and processes it through 4 distinct mastering chains (Balanced, Warm Analog,
 * Bright Air, Loud Squashed) so visitors on GitHub Pages can test the full
 * blind console immediately — with 0 bytes of audio committed to git.
 */

import { encodeAudioBufferToWavBuffer } from './audio-dsp.js';

const DEMO_SAMPLE_RATE = 44100;
const DEMO_DURATION = 16.0;

/**
 * Render the base unmastered stereo instrumental mix (120 BPM, 8 bars, A minor).
 */
async function renderBaseMix() {
  const length = Math.floor(DEMO_SAMPLE_RATE * DEMO_DURATION);
  const ctx = new OfflineAudioContext(2, length, DEMO_SAMPLE_RATE);

  const bpm = 120;
  const beat = 60 / bpm; // 0.5s

  // Stereo mix bus
  const mixBus = ctx.createGain();
  mixBus.gain.value = 0.72;
  mixBus.connect(ctx.destination);

  // Subtle stereo reverb tail (generated noise impulse)
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulseResponse(ctx, 1.4, 2.8);
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.22;
  reverbSend.connect(convolver);
  convolver.connect(mixBus);

  // Shared noise buffer for snare & hi-hats
  const noiseBuf = createWhiteNoiseBuffer(ctx, 0.5);

  // Chord progression: Am9 -> Fmaj7 -> Dm9 -> E7sus4 (4 beats each, twice)
  const chords = [
    [220.0, 261.63, 329.63, 392.0, 493.88],
    [174.61, 220.0, 261.63, 329.63, 392.0],
    [146.83, 220.0, 261.63, 329.63, 349.23],
    [164.81, 220.0, 246.94, 329.63, 392.0],
  ];
  const bassNotes = [55.0, 43.65, 36.71, 41.2];
  const arpScale = [440.0, 523.25, 659.25, 587.33, 493.88, 392.0, 440.0, 659.25];

  for (let bar = 0; bar < 8; bar++) {
    const barStart = bar * 4 * beat;
    const chord = chords[bar % chords.length];
    const bassFreq = bassNotes[bar % bassNotes.length];

    // Warm wide stereo pad / electric piano chord
    chord.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, barStart);
      osc.detune.setValueAtTime((idx - 2) * 5.5, barStart);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400 + idx * 240, barStart);
      filter.frequency.exponentialRampToValueAtTime(680, barStart + 3.9 * beat);

      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(((idx / (chord.length - 1)) * 2 - 1) * 0.65, barStart);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, barStart);
      env.gain.linearRampToValueAtTime(0.085, barStart + 0.045);
      env.gain.exponentialRampToValueAtTime(0.032, barStart + 3.6 * beat);
      env.gain.linearRampToValueAtTime(0.0001, barStart + 3.95 * beat);

      osc.connect(filter);
      filter.connect(pan);
      pan.connect(env);
      env.connect(mixBus);
      env.connect(reverbSend);

      osc.start(barStart);
      osc.stop(barStart + 4 * beat);
    });

    // Sub-bass line (root + octave bounce)
    [0, 1.5, 2.5].forEach((bOff, nIdx) => {
      const t = barStart + bOff * beat;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(nIdx === 2 ? bassFreq * 2 : bassFreq, t);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(210, t);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.24, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.9 * beat);

      osc.connect(lp);
      lp.connect(env);
      env.connect(mixBus);
      osc.start(t);
      osc.stop(t + 1.0 * beat);
    });

    // Drums: Kick (1, 2.5, 3), Snare (2, 4), stereo Hats (8ths)
    [0, 1.5, 2.0].forEach((bOff) => {
      scheduleKick(ctx, mixBus, barStart + bOff * beat);
    });
    [1, 3].forEach((bOff) => {
      scheduleSnare(ctx, mixBus, reverbSend, noiseBuf, barStart + bOff * beat);
    });
    for (let eigth = 0; eigth < 8; eigth++) {
      const accent = eigth % 2 === 0 ? 0.075 : 0.042;
      const panVal = eigth % 2 === 0 ? -0.35 : 0.35;
      scheduleHat(ctx, mixBus, noiseBuf, barStart + eigth * 0.5 * beat, accent, panVal);
    }

    // Melodic plucked motif (enters from bar 2 onward for musical dynamics)
    if (bar >= 1) {
      for (let step = 0; step < 4; step++) {
        const t = barStart + step * beat + 0.25 * beat;
        const freq = arpScale[(bar * 2 + step) % arpScale.length];
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);

        const pan = ctx.createStereoPanner();
        pan.pan.setValueAtTime(step % 2 === 0 ? 0.52 : -0.48, t);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(0.08, t + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0008, t + 0.42);

        osc.connect(pan);
        pan.connect(env);
        env.connect(mixBus);
        env.connect(reverbSend);
        osc.start(t);
        osc.stop(t + 0.45);
      }
    }
  }

  return ctx.startRendering();
}

function scheduleKick(ctx, dest, time) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(145, time);
  osc.frequency.exponentialRampToValueAtTime(42, time + 0.11);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.55, time);
  env.gain.exponentialRampToValueAtTime(0.001, time + 0.32);

  osc.connect(env);
  env.connect(dest);
  osc.start(time);
  osc.stop(time + 0.35);
}

function scheduleSnare(ctx, dest, reverbSend, noiseBuf, time) {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const hp = ctx.createBiquadFilter();
  hp.type = 'bandpass';
  hp.frequency.setValueAtTime(2200, time);
  hp.Q.setValueAtTime(0.8, time);

  const nEnv = ctx.createGain();
  nEnv.gain.setValueAtTime(0.24, time);
  nEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.19);

  noise.connect(hp);
  hp.connect(nEnv);
  nEnv.connect(dest);
  nEnv.connect(reverbSend);
  noise.start(time);
  noise.stop(time + 0.22);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(195, time);
  body.frequency.exponentialRampToValueAtTime(115, time + 0.07);

  const bEnv = ctx.createGain();
  bEnv.gain.setValueAtTime(0.18, time);
  bEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

  body.connect(bEnv);
  bEnv.connect(dest);
  body.start(time);
  body.stop(time + 0.14);
}

function scheduleHat(ctx, dest, noiseBuf, time, level, panVal) {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(7500, time);

  const pan = ctx.createStereoPanner();
  pan.pan.setValueAtTime(panVal, time);

  const env = ctx.createGain();
  env.gain.setValueAtTime(level, time);
  env.gain.exponentialRampToValueAtTime(0.0008, time + 0.055);

  noise.connect(hp);
  hp.connect(pan);
  pan.connect(env);
  env.connect(dest);
  noise.start(time);
  noise.stop(time + 0.065);
}

function createWhiteNoiseBuffer(ctx, duration) {
  const len = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic PRNG so demo masters are reproducible
  let seed = 1337;
  for (let i = 0; i < len; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 1073741823.5) - 1;
  }
  return buf;
}

function createImpulseResponse(ctx, duration, decay) {
  const len = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 9001;
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      const n = (seed / 1073741823.5) - 1;
      ch[i] = n * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function createSoftClipCurve(drive = 1.5) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

/**
 * Process the base mix through a specific mastering chain profile.
 */
async function renderMasterVariant(baseBuffer, variant) {
  const ctx = new OfflineAudioContext(2, baseBuffer.length, baseBuffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = baseBuffer;

  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = variant.lowFreq || 110;
  lowShelf.gain.value = variant.lowGain || 0;

  const midPeak = ctx.createBiquadFilter();
  midPeak.type = 'peaking';
  midPeak.frequency.value = variant.midFreq || 320;
  midPeak.Q.value = 0.9;
  midPeak.gain.value = variant.midGain || 0;

  const highShelf = ctx.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = variant.highFreq || 7200;
  highShelf.gain.value = variant.highGain || 0;

  const preDrive = ctx.createGain();
  preDrive.gain.value = variant.driveGain || 1.0;

  const shaper = ctx.createWaveShaper();
  shaper.curve = createSoftClipCurve(variant.clipDrive || 1.05);
  shaper.oversample = '2x';

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = variant.compThreshold ?? -12;
  comp.knee.value = variant.compKnee ?? 12;
  comp.ratio.value = variant.compRatio ?? 2.5;
  comp.attack.value = variant.compAttack ?? 0.015;
  comp.release.value = variant.compRelease ?? 0.14;

  const outGain = ctx.createGain();
  outGain.gain.value = variant.outGain || 0.95;

  src.connect(lowShelf);
  lowShelf.connect(midPeak);
  midPeak.connect(highShelf);
  highShelf.connect(preDrive);
  preDrive.connect(shaper);
  shaper.connect(comp);
  comp.connect(outGain);
  outGain.connect(ctx.destination);

  src.start(0);
  return ctx.startRendering();
}

const DEMO_VARIANTS = [
  {
    filename: 'SaintGordon_Fragment01_MASTER_v1_Balanced.wav',
    lowGain: 0.6,
    midGain: -0.4,
    highGain: 0.8,
    driveGain: 1.05,
    clipDrive: 1.15,
    compThreshold: -14,
    compRatio: 2.2,
    compAttack: 0.018,
    outGain: 0.92,
  },
  {
    filename: 'SaintGordon_Fragment01_MASTER_v2_Warm_Tape.wav',
    lowFreq: 130,
    lowGain: 3.4,
    midFreq: 350,
    midGain: 1.2,
    highFreq: 6800,
    highGain: -3.2,
    driveGain: 1.28,
    clipDrive: 2.1,
    compThreshold: -16,
    compRatio: 3.0,
    compAttack: 0.012,
    outGain: 0.92,
  },
  {
    filename: 'SaintGordon_Fragment01_MASTER_v3_Bright_Air.wav',
    lowFreq: 95,
    lowGain: -1.4,
    midFreq: 300,
    midGain: -2.0,
    highFreq: 6500,
    highGain: 4.5,
    driveGain: 1.05,
    clipDrive: 1.1,
    compThreshold: -13,
    compRatio: 2.0,
    compAttack: 0.025,
    outGain: 0.94,
  },
  {
    filename: 'SaintGordon_Fragment01_MASTER_v4_Loud_Squashed.wav',
    lowFreq: 110,
    lowGain: 1.8,
    midFreq: 1200,
    midGain: 1.4,
    highFreq: 8000,
    highGain: 1.6,
    driveGain: 2.1,
    clipDrive: 3.8,
    compThreshold: -24,
    compKnee: 4,
    compRatio: 10.0,
    compAttack: 0.003,
    compRelease: 0.08,
    outGain: 1.38,
  },
];

/**
 * Synthesize 4 distinct demo mastering File objects directly in memory.
 */
export async function generateDemoMasterFiles(onProgress = () => {}) {
  onProgress(10, 'Synthesizing studio mix...');
  const baseMix = await renderBaseMix();

  const files = [];
  for (let i = 0; i < DEMO_VARIANTS.length; i++) {
    const v = DEMO_VARIANTS[i];
    const pct = Math.round(25 + ((i + 1) / DEMO_VARIANTS.length) * 70);
    onProgress(pct, `Printing demo master ${i + 1} of ${DEMO_VARIANTS.length}...`);
    const rendered = await renderMasterVariant(baseMix, v);
    const wavBuf = encodeAudioBufferToWavBuffer(rendered);
    const file = new File([wavBuf], v.filename, { type: 'audio/wav' });
    files.push(file);
  }

  onProgress(100, 'Demo masters ready.');
  return files;
}
