/**
 * Pure DSP, Loudness (ITU-R BS.1770-4 K-weighted LUFS), Waveform,
 * Filtering, Time Formatting, and Statistical Utilities.
 * Zero DOM dependencies — runs identically in browsers and Node.js tests.
 */

export const VALID_AUDIO_EXTENSIONS = [
  '.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.webm'
];

export const MASTER_REGEX = /master(?:ed)?/i;
export const UNMASTERED_REGEX = /un[\W_]?master(?:ed)?/i;

/**
 * Evaluate whether a filename passes audio extension, MASTER/UNMASTERED, and search filters.
 */
export function evaluateAudioFile(filename, { filterOnlyMasters = true, searchQuery = '' } = {}) {
  const name = String(filename || '');
  const lower = name.toLowerCase();

  if (name.startsWith('.') || name.startsWith('._')) {
    return { accepted: false, reason: 'hidden' };
  }

  const hasAudioExt = VALID_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!hasAudioExt) {
    return { accepted: false, reason: 'not_audio' };
  }

  if (filterOnlyMasters) {
    if (UNMASTERED_REGEX.test(lower)) {
      return { accepted: false, reason: 'unmastered' };
    }
    if (!MASTER_REGEX.test(lower)) {
      return { accepted: false, reason: 'not_master' };
    }
  }

  const q = String(searchQuery || '').trim().toLowerCase();
  if (q && !lower.includes(q)) {
    return { accepted: false, reason: 'search_mismatch' };
  }

  return { accepted: true, reason: 'ok' };
}

/**
 * Unbiased Fisher-Yates shuffle returning a new array.
 */
export function fisherYatesShuffle(items, rng = Math.random) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Format seconds cleanly as MM:SS or MM:SS.t, properly rolling over minutes.
 */
export function formatTime(seconds, showTenths = false) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (showTenths) {
    const totalTenths = Math.round(safe * 10);
    const tenths = totalTenths % 10;
    const totalSeconds = Math.floor(totalTenths / 10);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
  }
  const totalSeconds = Math.floor(safe);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format a time range like "1:52 – 2:07" safely across minute boundaries.
 */
export function formatTimeRange(startSec, durationSec) {
  const start = Math.max(0, Number(startSec) || 0);
  const end = start + Math.max(0, Number(durationSec) || 0);
  return `${formatTime(start)} – ${formatTime(end)}`;
}

/**
 * Compute ITU-R BS.1770-4 K-weighting two-stage biquad filter coefficients
 * for any sample rate via the bilinear transform.
 */
export function computeKWeightingCoeffs(sampleRate) {
  const fs = Math.max(8000, Number(sampleRate) || 48000);

  // Stage 1: Acoustic head-effect high-shelf pre-filter (+4 dB above ~1.68 kHz)
  const f0Shelf = 1681.974450955533;
  const gShelf = 3.999843853973347;
  const qShelf = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * f0Shelf) / fs);
  const vh = Math.pow(10, gShelf / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a01 = 1 + k1 / qShelf + k1 * k1;

  const stage1 = {
    b0: (vh + (vb * k1) / qShelf + k1 * k1) / a01,
    b1: (2 * (k1 * k1 - vh)) / a01,
    b2: (vh - (vb * k1) / qShelf + k1 * k1) / a01,
    a1: (2 * (k1 * k1 - 1)) / a01,
    a2: (1 - k1 / qShelf + k1 * k1) / a01,
  };

  // Stage 2: RLB (Revised Low-frequency B-curve) 2nd-order high-pass (~38 Hz)
  const f0Hp = 38.13547087602444;
  const qHp = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f0Hp) / fs);
  const a02 = 1 + k2 / qHp + k2 * k2;

  const stage2 = {
    b0: 1 / a02,
    b1: -2 / a02,
    b2: 1 / a02,
    a1: (2 * (k2 * k2 - 1)) / a02,
    a2: (1 - k2 / qHp + k2 * k2) / a02,
  };

  return { stage1, stage2 };
}

/**
 * Apply a single Direct Form II Transposed biquad filter to a Float32Array.
 */
function applyBiquad(samples, { b0, b1, b2, a1, a2 }) {
  const out = new Float32Array(samples.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * Compute ITU-R BS.1770-4 gated integrated LUFS, sample peak (dBFS),
 * unweighted RMS (dBFS), and crest factor (peak - RMS in dB).
 *
 * @param {Float32Array[]} channelDataList Array of channel sample arrays
 * @param {number} sampleRate Sample rate in Hz
 * @returns {{ lufs: number, rmsDb: number, samplePeakDb: number, crestDb: number }}
 */
export function analyzeLoudness(channelDataList, sampleRate = 48000) {
  if (!channelDataList || channelDataList.length === 0 || channelDataList[0].length === 0) {
    return { lufs: -Infinity, rmsDb: -Infinity, samplePeakDb: -Infinity, crestDb: 0 };
  }

  const numChannels = channelDataList.length;
  const length = channelDataList[0].length;
  const { stage1, stage2 } = computeKWeightingCoeffs(sampleRate);

  let maxAbs = 0;
  let rawSumSq = 0;
  const kWeightedChannels = [];

  for (let c = 0; c < numChannels; c++) {
    const data = channelDataList[c];
    for (let i = 0; i < length; i++) {
      const s = data[i];
      const a = s < 0 ? -s : s;
      if (a > maxAbs) maxAbs = a;
      rawSumSq += s * s;
    }
    const s1 = applyBiquad(data, stage1);
    const s2 = applyBiquad(s1, stage2);
    kWeightedChannels.push(s2);
  }

  const rmsLinear = Math.sqrt(rawSumSq / (length * numChannels));
  const rmsDb = rmsLinear > 1e-9 ? 20 * Math.log10(rmsLinear) : -120;
  const samplePeakDb = maxAbs > 1e-9 ? 20 * Math.log10(maxAbs) : -120;
  const crestDb = Math.max(0, samplePeakDb - rmsDb);

  // ITU-R BS.1770-4 400 ms gating blocks with 75% overlap (100 ms hop)
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4));
  const hopSize = Math.max(1, Math.round(sampleRate * 0.1));

  // Channel weights: 1.0 for L/R/C, 1.41 for surround (indices 3, 4), 0 for LFE (index 3 in 5.1)
  const channelWeight = (idx) => {
    if (numChannels <= 2) return 1.0;
    if (idx === 3 && numChannels >= 6) return 0.0;
    if (idx >= 3) return 1.41;
    return 1.0;
  };

  if (length < blockSize) {
    let meanSq = 0;
    for (let c = 0; c < numChannels; c++) {
      const kData = kWeightedChannels[c];
      let sum = 0;
      for (let i = 0; i < length; i++) sum += kData[i] * kData[i];
      meanSq += channelWeight(c) * (sum / length);
    }
    const lufs = meanSq > 1e-12 ? -0.691 + 10 * Math.log10(meanSq) : -120;
    return {
      lufs: round1(lufs),
      rmsDb: round1(rmsDb),
      samplePeakDb: round1(samplePeakDb),
      crestDb: round1(crestDb),
    };
  }

  const blockEnergies = [];
  for (let start = 0; start + blockSize <= length; start += hopSize) {
    let zSum = 0;
    for (let c = 0; c < numChannels; c++) {
      const kData = kWeightedChannels[c];
      let sum = 0;
      const end = start + blockSize;
      for (let i = start; i < end; i++) {
        const v = kData[i];
        sum += v * v;
      }
      zSum += channelWeight(c) * (sum / blockSize);
    }
    blockEnergies.push(zSum);
  }

  // Absolute gate at -70 LUFS
  const absThreshold = Math.pow(10, (-70 + 0.691) / 10);
  const aboveAbs = blockEnergies.filter((z) => z > absThreshold);
  if (aboveAbs.length === 0) {
    return {
      lufs: -70,
      rmsDb: round1(rmsDb),
      samplePeakDb: round1(samplePeakDb),
      crestDb: round1(crestDb),
    };
  }

  const ungatedMean = aboveAbs.reduce((acc, v) => acc + v, 0) / aboveAbs.length;
  const ungatedLufs = -0.691 + 10 * Math.log10(ungatedMean);

  // Relative gate at -10 LU below ungated loudness
  const relThreshold = Math.pow(10, (ungatedLufs - 10 + 0.691) / 10);
  const aboveRel = aboveAbs.filter((z) => z > relThreshold);
  const finalPool = aboveRel.length > 0 ? aboveRel : aboveAbs;
  const gatedMean = finalPool.reduce((acc, v) => acc + v, 0) / finalPool.length;
  const integratedLufs = -0.691 + 10 * Math.log10(gatedMean);

  return {
    lufs: round1(integratedLufs),
    rmsDb: round1(rmsDb),
    samplePeakDb: round1(samplePeakDb),
    crestDb: round1(crestDb),
  };
}

/**
 * Convenience wrapper for Web Audio AudioBuffer.
 */
export function analyzeAudioBuffer(audioBuffer) {
  if (!audioBuffer) {
    return { lufs: -Infinity, rmsDb: -Infinity, samplePeakDb: -Infinity, crestDb: 0 };
  }
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  return analyzeLoudness(channels, audioBuffer.sampleRate);
}

/**
 * Compute pure-attenuation linear gain ratios to match two tracks in LUFS
 * (never boosts above unity so digital clipping cannot occur).
 */
export function computeLoudnessMatchGains(lufsA, lufsB, maxTrimDb = 24) {
  if (!Number.isFinite(lufsA) || !Number.isFinite(lufsB) || lufsA <= -110 || lufsB <= -110) {
    return { gainA: 1.0, gainB: 1.0, deltaDb: 0, targetLufs: null, trimADb: 0, trimBDb: 0 };
  }

  const targetLufs = Math.min(lufsA, lufsB);
  const rawTrimA = targetLufs - lufsA; // <= 0
  const rawTrimB = targetLufs - lufsB; // <= 0
  const trimADb = Math.max(-maxTrimDb, rawTrimA);
  const trimBDb = Math.max(-maxTrimDb, rawTrimB);

  return {
    gainA: Math.pow(10, trimADb / 20),
    gainB: Math.pow(10, trimBDb / 20),
    deltaDb: round1(lufsA - lufsB),
    targetLufs: round1(targetLufs),
    trimADb: round1(trimADb),
    trimBDb: round1(trimBDb),
  };
}

/**
 * Auto-detect the loudest contiguous window (typically the chorus/drop)
 * by sliding a sum over 250 ms RMS energy frames.
 */
export function findLoudestWindow(channelDataList, sampleRate, windowDuration = 15) {
  if (!channelDataList || channelDataList.length === 0) {
    return { startTime: 0, duration: windowDuration };
  }
  const totalSamples = channelDataList[0].length;
  const totalDuration = totalSamples / sampleRate;
  const effectiveDur = Math.min(windowDuration, totalDuration);

  if (effectiveDur >= totalDuration - 0.1) {
    return { startTime: 0, duration: totalDuration };
  }

  const frameSec = 0.25;
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameSec));
  const numFrames = Math.floor(totalSamples / frameSamples);
  const windowFrames = Math.max(1, Math.round(effectiveDur / frameSec));

  if (numFrames <= windowFrames) {
    return { startTime: 0, duration: effectiveDur };
  }

  const frameEnergies = new Float64Array(numFrames);
  const numCh = channelDataList.length;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples;
    const end = Math.min(totalSamples, start + frameSamples);
    let sum = 0;
    // Stride of 4 for fast energy scanning over long WAV files
    const step = 4;
    let count = 0;
    for (let c = 0; c < numCh; c++) {
      const ch = channelDataList[c];
      for (let i = start; i < end; i += step) {
        sum += ch[i] * ch[i];
        count++;
      }
    }
    frameEnergies[f] = count > 0 ? sum / count : 0;
  }

  let runningSum = 0;
  for (let i = 0; i < windowFrames; i++) {
    runningSum += frameEnergies[i];
  }

  let bestSum = runningSum;
  let bestFrame = 0;

  for (let i = windowFrames; i < numFrames; i++) {
    runningSum += frameEnergies[i] - frameEnergies[i - windowFrames];
    if (runningSum > bestSum) {
      bestSum = runningSum;
      bestFrame = i - windowFrames + 1;
    }
  }

  const maxStart = Math.max(0, totalDuration - effectiveDur);
  const startTime = Math.min(maxStart, bestFrame * frameSec);

  return {
    startTime: round2(startTime),
    duration: round2(effectiveDur),
  };
}

/**
 * Compute lightweight normalized peak envelope [0..1] for waveform visualization.
 */
export function computeWaveformPeaks(channelDataList, numBins = 160) {
  const peaks = new Array(numBins).fill(0);
  if (!channelDataList || channelDataList.length === 0 || channelDataList[0].length === 0) {
    return peaks;
  }

  const totalSamples = channelDataList[0].length;
  const samplesPerBin = Math.max(1, Math.floor(totalSamples / numBins));
  const numCh = channelDataList.length;
  let globalMax = 0;

  for (let b = 0; b < numBins; b++) {
    const start = Math.floor((b * totalSamples) / numBins);
    const end = Math.min(totalSamples, start + samplesPerBin);
    const stride = Math.max(1, Math.floor((end - start) / 128));
    let binPeak = 0;
    for (let c = 0; c < numCh; c++) {
      const ch = channelDataList[c];
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(ch[i]);
        if (v > binPeak) binPeak = v;
      }
    }
    peaks[b] = binPeak;
    if (binPeak > globalMax) globalMax = binPeak;
  }

  const norm = globalMax > 1e-6 ? globalMax : 1;
  return peaks.map((p) => Number((p / norm).toFixed(3)));
}

/**
 * Extract a safe slice from an AudioBuffer without out-of-bounds failures.
 */
export function sliceAudioBuffer(audioCtx, fullBuffer, startTime, duration) {
  const sampleRate = fullBuffer.sampleRate;
  const maxStart = Math.max(0, fullBuffer.duration - 0.1);
  const safeStart = Math.max(0, Math.min(startTime, maxStart));
  const startSample = Math.floor(safeStart * sampleRate);
  const remainingSamples = Math.max(1, fullBuffer.length - startSample);
  const numSamples = Math.max(1, Math.min(Math.floor(duration * sampleRate), remainingSamples));

  const sliced = audioCtx.createBuffer(fullBuffer.numberOfChannels, numSamples, sampleRate);
  for (let ch = 0; ch < fullBuffer.numberOfChannels; ch++) {
    const channelData = fullBuffer.getChannelData(ch);
    sliced.copyToChannel(channelData.subarray(startSample, startSample + numSamples), ch);
  }
  return sliced;
}

/**
 * Exact one-tailed binomial p-value P(X >= correct) for p = 0.5 (ABX testing).
 */
export function computeBinomialPValue(correct, total) {
  if (total <= 0) return 1.0;
  if (correct <= 0) return 1.0;
  if (correct > total) return 0.0;

  // Use log-gamma / log-factorial for exact numerical stability at any n
  const logFact = new Float64Array(total + 1);
  for (let i = 2; i <= total; i++) {
    logFact[i] = logFact[i - 1] + Math.log(i);
  }

  let prob = 0;
  const logHalfN = total * Math.log(0.5);
  for (let k = correct; k <= total; k++) {
    const logChoose = logFact[total] - logFact[k] - logFact[total - k];
    prob += Math.exp(logChoose + logHalfN);
  }
  return Math.min(1.0, Math.max(0.0, prob));
}

/**
 * Encode a Web Audio AudioBuffer into a standard 16-bit PCM WAV Blob/ArrayBuffer.
 */
export function encodeAudioBufferToWavBuffer(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}
