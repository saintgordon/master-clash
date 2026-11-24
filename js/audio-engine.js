/**
 * Studio-Grade Web Audio Engine for Master Clash.
 * - Sample-locked A / B (/ X) parallel playback with clickless 8 ms crossfades to exact 0.0
 * - ITU-R BS.1770 K-weighted LUFS loudness matching (pure attenuation, never clips)
 * - Real-time Stereo / Mono Sum / Side (L - R) monitoring matrix
 * - True dual-channel Left / Right peak & RMS metering via ChannelSplitterNode
 * - Per-side ±50 ms micro time-alignment trim (compensates WAV vs MP3/AAC encoder padding)
 * - Zero per-frame TypedArray allocations
 */

import { computeLoudnessMatchGains } from './audio-dsp.js';

export function decodeAudioDataSafe(audioCtx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const copy = arrayBuffer.slice(0);
    let isDone = false;
    const done = (fn, arg) => {
      if (!isDone) {
        isDone = true;
        fn(arg);
      }
    };
    try {
      const ret = audioCtx.decodeAudioData(
        copy,
        (decoded) => done(resolve, decoded),
        (err) => done(reject, err || new Error('decodeAudioData failed'))
      );
      if (ret && typeof ret.then === 'function') {
        ret.then((buf) => done(resolve, buf)).catch((err) => done(reject, err));
      }
    } catch (e) {
      done(reject, e);
    }
  });
}

export class AudioEngine {
  constructor() {
    this.ctx = null;

    // Buffers for current match
    this.bufferA = null;
    this.bufferB = null;
    this.bufferX = null; // Optional 3rd reference for ABX mode

    this.sourceA = null;
    this.sourceB = null;
    this.sourceX = null;

    this.gainA = null;
    this.gainB = null;
    this.gainX = null;

    // Master bus + Stereo/Mono/Side Matrix + True L/R Metering
    this.sumBus = null;
    this.matrixSplitter = null;
    this.matrixMerger = null;
    this.mLL = null;
    this.mLR = null;
    this.mRL = null;
    this.mRR = null;
    this.masterGain = null;

    this.meterSplitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.analyserFft = null;

    // Pre-allocated metering buffers
    this.timeDataL = null;
    this.timeDataR = null;
    this.fftData = null;
    this.peakHoldL = -100;
    this.peakHoldR = -100;
    this.clipHoldL = 0;
    this.clipHoldR = 0;

    // Playback state
    this.isPlaying = false;
    this.activeSide = 'A'; // 'A' | 'B' | 'X'
    this.duration = 15.0;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.volume = 0.9;
    this.monitorMode = 'stereo'; // 'stereo' | 'mono' | 'side'

    // Loudness matching
    this.autoLufsMatch = true;
    this.lufsGainA = 1.0;
    this.lufsGainB = 1.0;
    this.lufsGainX = 1.0;
    this.lastMatchMeta = null;

    // Micro time-alignment trim in milliseconds (-50 .. +50) for Option B relative to A
    this.offsetMsB = 0;

    // Auto A/B flip
    this.autoFlipEnabled = false;
    this.autoFlipTimer = null;
    this.onAutoFlip = null;

    // Single-track table audition
    this.auditionSource = null;
    this.activeAuditionBtn = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();

      // Sum bus receiving Option I / Option II (/ Option X)
      this.sumBus = this.ctx.createGain();
      this.sumBus.gain.value = 1.0;

      // Stereo / Mono / Side matrix:
      // sumBus -> splitter(L, R) -> [mLL, mLR, mRL, mRR] -> merger(L, R) -> masterGain
      this.matrixSplitter = this.ctx.createChannelSplitter(2);
      this.matrixMerger = this.ctx.createChannelMerger(2);

      this.mLL = this.ctx.createGain();
      this.mLR = this.ctx.createGain();
      this.mRL = this.ctx.createGain();
      this.mRR = this.ctx.createGain();

      this.sumBus.connect(this.matrixSplitter);
      this.matrixSplitter.connect(this.mLL, 0);
      this.matrixSplitter.connect(this.mRL, 0);
      this.matrixSplitter.connect(this.mLR, 1);
      this.matrixSplitter.connect(this.mRR, 1);

      this.mLL.connect(this.matrixMerger, 0, 0);
      this.mLR.connect(this.matrixMerger, 0, 0);
      this.mRL.connect(this.matrixMerger, 0, 1);
      this.mRR.connect(this.matrixMerger, 0, 1);

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;

      this.matrixMerger.connect(this.masterGain);

      // True stereo L/R metering + FFT spectrum analyser
      this.meterSplitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserFft = this.ctx.createAnalyser();

      this.analyserL.fftSize = 1024;
      this.analyserR.fftSize = 1024;
      this.analyserFft.fftSize = 256;
      this.analyserFft.smoothingTimeConstant = 0.78;

      this.timeDataL = new Float32Array(this.analyserL.fftSize);
      this.timeDataR = new Float32Array(this.analyserR.fftSize);
      this.fftData = new Uint8Array(this.analyserFft.frequencyBinCount);

      this.masterGain.connect(this.meterSplitter);
      this.meterSplitter.connect(this.analyserL, 0);
      this.meterSplitter.connect(this.analyserR, 1);

      this.masterGain.connect(this.analyserFft);
      this.masterGain.connect(this.ctx.destination);

      this.setMonitorMode(this.monitorMode, true);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, Number(val)));
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(this.volume, now + 0.015);
    }
  }

  setMonitorMode(mode, immediate = false) {
    if (!['stereo', 'mono', 'side'].includes(mode)) return;
    this.monitorMode = mode;
    if (!this.ctx || !this.mLL) return;

    let ll = 1;
    let lr = 0;
    let rl = 0;
    let rr = 1;
    if (mode === 'mono') {
      ll = 0.5;
      lr = 0.5;
      rl = 0.5;
      rr = 0.5;
    } else if (mode === 'side') {
      // L - R on left, R - L on right
      ll = 0.5;
      lr = -0.5;
      rl = -0.5;
      rr = 0.5;
    }

    const now = this.ctx.currentTime;
    const ramp = immediate ? 0 : 0.008;
    const pairs = [
      [this.mLL, ll],
      [this.mLR, lr],
      [this.mRL, rl],
      [this.mRR, rr],
    ];
    for (const [node, target] of pairs) {
      node.gain.cancelScheduledValues(now);
      if (immediate) {
        node.gain.setValueAtTime(target, now);
      } else {
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(target, now + ramp);
      }
    }
  }

  setMatchBuffers(trackA, trackB, requestedDuration = 15.0, trackX = null) {
    this.stop();
    this.bufferA = trackA.slicedBuffer;
    this.bufferB = trackB.slicedBuffer;
    this.bufferX = trackX ? trackX.slicedBuffer : null;

    // Clamp synchronized loop duration to the shortest loaded slice so A and B never drift
    const durations = [requestedDuration, this.bufferA.duration, this.bufferB.duration];
    if (this.bufferX) durations.push(this.bufferX.duration);
    this.duration = Math.max(0.5, Math.min(...durations));
    this.pauseOffset = 0;
    this.offsetMsB = 0;
    this.resetPeakHold();

    // ITU-R BS.1770 K-weighted LUFS matching (pure attenuation)
    const match = computeLoudnessMatchGains(trackA.lufs, trackB.lufs);
    this.lufsGainA = match.gainA;
    this.lufsGainB = match.gainB;
    if (trackX) {
      this.lufsGainX = trackX.id === trackA.id ? match.gainA : match.gainB;
    } else {
      this.lufsGainX = 1.0;
    }
    this.lastMatchMeta = match;
  }

  setAlignmentOffsetMs(offsetMs) {
    const clamped = Math.max(-50, Math.min(50, Math.round(Number(offsetMs) || 0)));
    if (clamped === this.offsetMsB) return;
    this.offsetMsB = clamped;
    if (this.isPlaying) {
      const currentPos = this.getCurrentPlayhead();
      this.pause();
      this.pauseOffset = currentPos;
      this.play();
    }
  }

  async play() {
    if (!this.bufferA || !this.bufferB) return false;

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Ignore resume rejection if browser requires another gesture
      }
    }

    if (this.isPlaying) return true;

    this.cleanupSources();

    const loopEnd = this.duration;
    this.sourceA = this._createLoopSource(ctx, this.bufferA, loopEnd);
    this.sourceB = this._createLoopSource(ctx, this.bufferB, loopEnd);

    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();
    this.sourceA.connect(this.gainA);
    this.sourceB.connect(this.gainB);
    this.gainA.connect(this.sumBus);
    this.gainB.connect(this.sumBus);

    if (this.bufferX) {
      this.sourceX = this._createLoopSource(ctx, this.bufferX, loopEnd);
      this.gainX = ctx.createGain();
      this.sourceX.connect(this.gainX);
      this.gainX.connect(this.sumBus);
    }

    this.applyGains(true);

    const offset = ((this.pauseOffset % this.duration) + this.duration) % this.duration;
    const now = ctx.currentTime + 0.01;
    this.startTime = now - offset;

    // Apply micro-alignment trim safely (wrapped inside loop duration)
    const offsetB = (((offset + this.offsetMsB / 1000) % this.duration) + this.duration) % this.duration;

    try {
      this.sourceA.start(now, offset);
      this.sourceB.start(now, offsetB);
      if (this.sourceX) {
        const offsetX = this.bufferX === this.bufferB ? offsetB : offset;
        this.sourceX.start(now, offsetX);
      }
      this.isPlaying = true;

      if (this.autoFlipEnabled) {
        this.scheduleAutoFlip();
      }
      return true;
    } catch (err) {
      console.error('Playback start error:', err);
      this.isPlaying = false;
      return false;
    }
  }

  _createLoopSource(ctx, buffer, loopEnd) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = Math.min(loopEnd, buffer.duration);
    return src;
  }

  pause() {
    if (!this.isPlaying) return;
    if (this.ctx) {
      const elapsed = Math.max(0, this.ctx.currentTime - this.startTime);
      this.pauseOffset = elapsed % this.duration;
    }
    this.cleanupSources();
    this.isPlaying = false;
    clearTimeout(this.autoFlipTimer);
  }

  stop() {
    this.pause();
    this.pauseOffset = 0;
  }

  cleanupSources() {
    for (const key of ['sourceA', 'sourceB', 'sourceX']) {
      const src = this[key];
      if (src) {
        try { src.stop(); } catch { /* noop */ }
        try { src.disconnect(); } catch { /* noop */ }
        this[key] = null;
      }
    }
    for (const key of ['gainA', 'gainB', 'gainX']) {
      const g = this[key];
      if (g) {
        try { g.disconnect(); } catch { /* noop */ }
        this[key] = null;
      }
    }
  }

  async seek(targetSeconds) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.pauseOffset = Math.max(0, Math.min(targetSeconds, Math.max(0, this.duration - 0.01)));
    if (wasPlaying) await this.play();
  }

  async switchSide(newSide) {
    if (newSide === 'X' && !this.bufferX) return;
    this.activeSide = newSide;
    if (this.isPlaying) {
      this.applyGains(false);
    } else {
      await this.play();
    }
  }

  applyGains(immediate = false) {
    if (!this.gainA || !this.gainB || !this.ctx) return;

    const multA = this.autoLufsMatch ? this.lufsGainA : 1.0;
    const multB = this.autoLufsMatch ? this.lufsGainB : 1.0;
    const multX = this.autoLufsMatch ? this.lufsGainX : 1.0;

    const targetA = this.activeSide === 'A' ? multA : 0.0;
    const targetB = this.activeSide === 'B' ? multB : 0.0;
    const targetX = this.activeSide === 'X' ? multX : 0.0;

    const now = this.ctx.currentTime;
    const fadeSec = 0.008; // 8 ms clickless crossfade to exact 0.0

    const applyNode = (node, target) => {
      if (!node) return;
      node.gain.cancelScheduledValues(now);
      if (immediate) {
        node.gain.setValueAtTime(target, now);
      } else {
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(target, now + fadeSec);
      }
    };

    applyNode(this.gainA, targetA);
    applyNode(this.gainB, targetB);
    applyNode(this.gainX, targetX);
  }

  getCurrentPlayhead() {
    if (!this.isPlaying) return this.pauseOffset;
    if (!this.ctx) return 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startTime);
    return elapsed % this.duration;
  }

  scheduleAutoFlip() {
    clearTimeout(this.autoFlipTimer);
    if (!this.autoFlipEnabled || !this.isPlaying) return;

    const current = this.getCurrentPlayhead();
    const remainingMs = Math.max(400, (this.duration - current) * 1000);

    this.autoFlipTimer = setTimeout(() => {
      if (this.isPlaying && this.autoFlipEnabled) {
        const nextSide = this.activeSide === 'A' ? 'B' : 'A';
        this.switchSide(nextSide);
        if (typeof this.onAutoFlip === 'function') {
          this.onAutoFlip(nextSide);
        }
        this.scheduleAutoFlip();
      }
    }, remainingMs);
  }

  resetPeakHold() {
    this.peakHoldL = -100;
    this.peakHoldR = -100;
    this.clipHoldL = 0;
    this.clipHoldR = 0;
  }

  /**
   * Read true dual-channel stereo peak & RMS levels (in dBFS) and FFT spectrum.
   * Zero allocations per frame.
   */
  getMeterReadings() {
    if (!this.analyserL || !this.analyserR || !this.analyserFft || !this.isPlaying) {
      this.peakHoldL = Math.max(-100, this.peakHoldL - 1.2);
      this.peakHoldR = Math.max(-100, this.peakHoldR - 1.2);
      return {
        peakLDb: -100,
        peakRDb: -100,
        rmsLDb: -100,
        rmsRDb: -100,
        peakHoldLDb: this.peakHoldL,
        peakHoldRDb: this.peakHoldR,
        clipL: this.clipHoldL > 0,
        clipR: this.clipHoldR > 0,
        fftData: null,
      };
    }

    this.analyserL.getFloatTimeDomainData(this.timeDataL);
    this.analyserR.getFloatTimeDomainData(this.timeDataR);
    this.analyserFft.getByteFrequencyData(this.fftData);

    const left = computeFrameMetrics(this.timeDataL);
    const right = computeFrameMetrics(this.timeDataR);

    this.peakHoldL = left.peakDb >= this.peakHoldL ? left.peakDb : Math.max(-100, this.peakHoldL - 0.35);
    this.peakHoldR = right.peakDb >= this.peakHoldR ? right.peakDb : Math.max(-100, this.peakHoldR - 0.35);

    if (left.peakDb >= -0.1) this.clipHoldL = 60;
    else if (this.clipHoldL > 0) this.clipHoldL--;

    if (right.peakDb >= -0.1) this.clipHoldR = 60;
    else if (this.clipHoldR > 0) this.clipHoldR--;

    return {
      peakLDb: left.peakDb,
      peakRDb: right.peakDb,
      rmsLDb: left.rmsDb,
      rmsRDb: right.rmsDb,
      peakHoldLDb: this.peakHoldL,
      peakHoldRDb: this.peakHoldR,
      clipL: this.clipHoldL > 0,
      clipR: this.clipHoldR > 0,
      fftData: this.fftData,
    };
  }

  previewBuffer(buffer, btn) {
    const ctx = this.ensureContext();
    if (this.auditionSource && this.activeAuditionBtn === btn) {
      this.stopAudition();
      return;
    }

    this.stopAudition();
    this.activeAuditionBtn = btn;
    btn.textContent = '■ Stop';
    btn.setAttribute('aria-pressed', 'true');

    try {
      this.auditionSource = ctx.createBufferSource();
      this.auditionSource.buffer = buffer;
      this.auditionSource.connect(this.masterGain);
      this.auditionSource.onended = () => this.stopAudition();
      this.auditionSource.start(0);
    } catch (e) {
      console.error(e);
      this.stopAudition();
    }
  }

  stopAudition() {
    if (this.auditionSource) {
      try { this.auditionSource.stop(); } catch { /* noop */ }
      try { this.auditionSource.disconnect(); } catch { /* noop */ }
      this.auditionSource = null;
    }
    if (this.activeAuditionBtn) {
      this.activeAuditionBtn.textContent = '▶ Preview';
      this.activeAuditionBtn.setAttribute('aria-pressed', 'false');
      this.activeAuditionBtn = null;
    }
  }
}

function computeFrameMetrics(samples) {
  let sumSq = 0;
  let peak = 0;
  const len = samples.length;
  for (let i = 0; i < len; i++) {
    const s = samples[i];
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / len);
  return {
    peakDb: peak > 1e-6 ? 20 * Math.log10(peak) : -100,
    rmsDb: rms > 1e-6 ? 20 * Math.log10(rms) : -100,
  };
}
