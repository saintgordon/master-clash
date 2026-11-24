/**
 * Pure Blind Tournament & Evaluation Engine for Master Clash.
 * Supports:
 *  - King of the Hill (koth): fast elimination ladder
 *  - Round-Robin (round-robin): full pairwise or balanced Swiss + hidden Ear Consistency rematch + Elo rankings
 *  - ABX Statistical Test (abx): 2-track A/B/X trials with exact binomial p-value
 *  - Full Undo stack & Blind Notes (notes keyed by track ID, never leaking filenames)
 *  - Markdown & JSON Shootout Report exporters
 */

import { fisherYatesShuffle, computeBinomialPValue, formatTime, formatTimeRange } from './audio-dsp.js';

export const QUICK_NOTE_TAGS = [
  'Punchy',
  'Warm',
  'Bright',
  'Open',
  'Wide',
  'Tight Low-End',
  'Harsh',
  'Squashed',
  'Muddy',
];

export class TournamentEngine {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.mode = 'koth'; // 'koth' | 'round-robin' | 'abx'
    this.tracks = [];
    this.tracksById = new Map();
    this.currentMatchIndex = 0;
    this.totalMatches = 0;
    this.status = 'idle'; // 'idle' | 'in_progress' | 'completed'

    // KOTH state
    this.currentKing = null;
    this.currentChallenger = null;
    this.queue = [];

    // Round-Robin state
    this.pairSchedule = []; // [{ idA, idB, isConsistencyCheck, originalMatchIndex }]

    // ABX state
    this.abxTrackA = null;
    this.abxTrackB = null;
    this.abxTrials = 8;
    this.abxCurrentX = 'A'; // 'A' or 'B'
    this.abxResults = []; // [{ trialNumber, actualX, guessed, correct }]

    // Shared match state
    this.blindMap = {}; // { A: track, B: track, X?: track }
    this.history = [];
    this.undoStack = [];
    this.notesByTrackId = new Map(); // trackId -> { tags: string[], text: string }
    this.winner = null;
    this.settings = {
      previewDuration: 15,
      regionMode: 'midpoint',
      lufsMatch: true,
      pureBlind: true,
    };
  }

  start(selectedTracks, {
    mode = 'koth',
    abxTrials = 8,
    previewDuration = 15,
    regionMode = 'midpoint',
    lufsMatch = true,
  } = {}) {
    if (!Array.isArray(selectedTracks) || selectedTracks.length < 2) {
      throw new Error('At least 2 tracks are required to start a shootout.');
    }
    if (mode === 'abx' && selectedTracks.length !== 2) {
      throw new Error('ABX statistical mode requires exactly 2 selected tracks.');
    }

    this.reset();
    this.mode = mode;
    this.tracks = [...selectedTracks];
    this.tracksById = new Map(this.tracks.map((t) => [t.id, t]));
    this.settings = { previewDuration, regionMode, lufsMatch, pureBlind: true };

    for (const t of this.tracks) {
      this.notesByTrackId.set(t.id, { tags: [], text: '' });
    }

    if (mode === 'koth') {
      const shuffled = fisherYatesShuffle(this.tracks, this.rng);
      this.currentKing = shuffled[0];
      this.currentChallenger = shuffled[1];
      this.queue = shuffled.slice(2);
      this.currentMatchIndex = 1;
      this.totalMatches = shuffled.length - 1;
      this.status = 'in_progress';
      this._assignBlindSides(this.currentKing, this.currentChallenger);
    } else if (mode === 'round-robin') {
      const pairs = this._buildRoundRobinSchedule(this.tracks);
      this.pairSchedule = pairs;
      this.currentMatchIndex = 1;
      this.totalMatches = pairs.length;
      this.status = 'in_progress';
      this._loadRoundRobinPair(0);
    } else if (mode === 'abx') {
      const shuffled = fisherYatesShuffle(this.tracks, this.rng);
      this.abxTrackA = shuffled[0];
      this.abxTrackB = shuffled[1];
      this.abxTrials = Math.max(4, Math.min(20, Number(abxTrials) || 8));
      this.currentMatchIndex = 1;
      this.totalMatches = this.abxTrials;
      this.status = 'in_progress';
      this._setupAbxTrial();
    }

    return this.getCurrentMatch();
  }

  _buildRoundRobinSchedule(tracks) {
    const shuffled = fisherYatesShuffle(tracks, this.rng);
    const allPairs = [];
    for (let i = 0; i < shuffled.length; i++) {
      for (let j = i + 1; j < shuffled.length; j++) {
        allPairs.push({
          idA: shuffled[i].id,
          idB: shuffled[j].id,
          isConsistencyCheck: false,
        });
      }
    }

    // For large batches (> 6 tracks, > 15 pairs), pick a balanced subset (3 matches per track)
    let schedule = fisherYatesShuffle(allPairs, this.rng);
    if (shuffled.length > 6) {
      const counts = new Map(shuffled.map((t) => [t.id, 0]));
      const targetPerTrack = 3;
      const selected = [];
      for (const pair of schedule) {
        if (counts.get(pair.idA) < targetPerTrack && counts.get(pair.idB) < targetPerTrack) {
          selected.push(pair);
          counts.set(pair.idA, counts.get(pair.idA) + 1);
          counts.set(pair.idB, counts.get(pair.idB) + 1);
        }
      }
      schedule = selected.length >= shuffled.length ? selected : schedule.slice(0, 15);
    }

    // Append 1 hidden consistency-check rematch (from an early pairing) when >= 3 tracks
    if (shuffled.length >= 3 && schedule.length >= 2) {
      const refPair = schedule[0];
      schedule.push({
        idA: refPair.idA,
        idB: refPair.idB,
        isConsistencyCheck: true,
      });
    }

    return schedule;
  }

  _loadRoundRobinPair(index) {
    const pair = this.pairSchedule[index];
    const trackA = this.tracksById.get(pair.idA);
    const trackB = this.tracksById.get(pair.idB);
    this._assignBlindSides(trackA, trackB);
  }

  _assignBlindSides(track1, track2) {
    const flip = this.rng() < 0.5;
    this.blindMap = {
      A: flip ? track1 : track2,
      B: flip ? track2 : track1,
    };
  }

  _setupAbxTrial() {
    this.abxCurrentX = this.rng() < 0.5 ? 'A' : 'B';
    this.blindMap = {
      A: this.abxTrackA,
      B: this.abxTrackB,
      X: this.abxCurrentX === 'A' ? this.abxTrackA : this.abxTrackB,
    };
  }

  getCurrentMatch() {
    if (this.status !== 'in_progress') return null;

    let stageTitle = 'King of the Hill Shootout';
    if (this.mode === 'koth') {
      stageTitle = this.currentMatchIndex === 1
        ? 'Opening Clash'
        : this.currentMatchIndex === this.totalMatches
          ? 'Championship Final'
          : 'King of the Hill';
    } else if (this.mode === 'round-robin') {
      // Never reveal to the listener that a match is the hidden consistency check!
      stageTitle = 'Round-Robin Evaluation';
    } else if (this.mode === 'abx') {
      stageTitle = 'ABX Discrimination Trial';
    }

    return {
      mode: this.mode,
      matchNumber: this.currentMatchIndex,
      totalMatches: this.totalMatches,
      stageTitle,
      canUndo: this.undoStack.length > 0,
      blindMap: { ...this.blindMap },
      notesA: this.getNoteForSide('A'),
      notesB: this.getNoteForSide('B'),
    };
  }

  getNoteForSide(side) {
    const track = this.blindMap[side];
    if (!track) return { tags: [], text: '' };
    const existing = this.notesByTrackId.get(track.id) || { tags: [], text: '' };
    return { tags: [...existing.tags], text: existing.text };
  }

  setNoteForSide(side, text) {
    const track = this.blindMap[side];
    if (!track) return;
    const entry = this.notesByTrackId.get(track.id) || { tags: [], text: '' };
    entry.text = String(text || '');
    this.notesByTrackId.set(track.id, entry);
  }

  toggleTagForSide(side, tag) {
    const track = this.blindMap[side];
    if (!track) return [];
    const entry = this.notesByTrackId.get(track.id) || { tags: [], text: '' };
    const idx = entry.tags.indexOf(tag);
    if (idx >= 0) {
      entry.tags.splice(idx, 1);
    } else {
      entry.tags.push(tag);
    }
    this.notesByTrackId.set(track.id, entry);
    return [...entry.tags];
  }

  _pushUndoSnapshot() {
    this.undoStack.push({
      currentMatchIndex: this.currentMatchIndex,
      status: this.status,
      currentKing: this.currentKing,
      currentChallenger: this.currentChallenger,
      queue: [...this.queue],
      abxCurrentX: this.abxCurrentX,
      abxResults: this.abxResults.map((r) => ({ ...r })),
      blindMap: { ...this.blindMap },
      history: this.history.map((h) => ({ ...h })),
      winner: this.winner,
    });
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    if (this.undoStack.length === 0) return null;
    const snap = this.undoStack.pop();
    this.currentMatchIndex = snap.currentMatchIndex;
    this.status = snap.status;
    this.currentKing = snap.currentKing;
    this.currentChallenger = snap.currentChallenger;
    this.queue = snap.queue;
    this.abxCurrentX = snap.abxCurrentX;
    this.abxResults = snap.abxResults;
    this.blindMap = snap.blindMap;
    this.history = snap.history;
    this.winner = snap.winner;
    return this.getCurrentMatch();
  }

  vote(chosenSide) {
    if (this.status !== 'in_progress') {
      throw new Error('No tournament is currently in progress.');
    }
    if (chosenSide !== 'A' && chosenSide !== 'B') {
      throw new Error("Vote side must be 'A' or 'B'.");
    }

    this._pushUndoSnapshot();

    if (this.mode === 'abx') {
      return this._voteAbx(chosenSide);
    }

    const winningTrack = this.blindMap[chosenSide];
    const losingSide = chosenSide === 'A' ? 'B' : 'A';
    const losingTrack = this.blindMap[losingSide];

    const isConsistencyCheck =
      this.mode === 'round-robin' &&
      Boolean(this.pairSchedule[this.currentMatchIndex - 1]?.isConsistencyCheck);

    this.history.push({
      matchNumber: this.currentMatchIndex,
      chosenSide,
      winnerId: winningTrack.id,
      winnerFilename: winningTrack.filename,
      loserId: losingTrack.id,
      loserFilename: losingTrack.filename,
      isConsistencyCheck,
    });

    if (this.mode === 'koth') {
      this.currentKing = winningTrack;
      if (this.queue.length > 0) {
        this.currentChallenger = this.queue.shift();
        this.currentMatchIndex++;
        this._assignBlindSides(this.currentKing, this.currentChallenger);
        return { completed: false, match: this.getCurrentMatch() };
      }
      this.status = 'completed';
      this.winner = this.currentKing;
      return { completed: true, summary: this.getSummary() };
    }

    // Round-Robin
    if (this.currentMatchIndex < this.pairSchedule.length) {
      this.currentMatchIndex++;
      this._loadRoundRobinPair(this.currentMatchIndex - 1);
      return { completed: false, match: this.getCurrentMatch() };
    }

    this.status = 'completed';
    const rankings = this.computeRankings();
    this.winner = rankings[0]?.track || winningTrack;
    return { completed: true, summary: this.getSummary() };
  }

  _voteAbx(guessedSide) {
    const correct = guessedSide === this.abxCurrentX;
    this.abxResults.push({
      trialNumber: this.currentMatchIndex,
      actualX: this.abxCurrentX,
      actualFilename: this.abxCurrentX === 'A' ? this.abxTrackA.filename : this.abxTrackB.filename,
      guessed: guessedSide,
      guessedFilename: guessedSide === 'A' ? this.abxTrackA.filename : this.abxTrackB.filename,
      correct,
    });

    if (this.currentMatchIndex < this.abxTrials) {
      this.currentMatchIndex++;
      this._setupAbxTrial();
      return { completed: false, match: this.getCurrentMatch() };
    }

    this.status = 'completed';
    this.winner = this.abxTrackA;
    return { completed: true, summary: this.getSummary() };
  }

  computeConsistency() {
    const checks = this.history.filter((h) => h.isConsistencyCheck);
    if (checks.length === 0) return null;

    let matched = 0;
    const details = [];

    for (const check of checks) {
      const pairKey = [check.winnerId, check.loserId].sort().join('::');
      const original = this.history.find(
        (h) => !h.isConsistencyCheck && [h.winnerId, h.loserId].sort().join('::') === pairKey
      );
      if (original) {
        const consistent = original.winnerId === check.winnerId;
        if (consistent) matched++;
        details.push({
          originalMatch: original.matchNumber,
          rematchNumber: check.matchNumber,
          consistent,
          firstWinner: original.winnerFilename,
          rematchWinner: check.winnerFilename,
        });
      }
    }

    return {
      totalChecks: details.length,
      consistentCount: matched,
      scorePct: details.length > 0 ? Math.round((matched / details.length) * 100) : 100,
      details,
    };
  }

  computeRankings() {
    const stats = new Map();
    for (const track of this.tracks) {
      stats.set(track.id, {
        track,
        wins: 0,
        losses: 0,
        elo: 1000,
        notes: this.notesByTrackId.get(track.id) || { tags: [], text: '' },
      });
    }

    // Standard K=32 Elo updates across all matches
    for (const match of this.history) {
      const w = stats.get(match.winnerId);
      const l = stats.get(match.loserId);
      if (!w || !l) continue;
      if (!match.isConsistencyCheck) {
        w.wins++;
        l.losses++;
      }
      const expectedW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
      const delta = Math.round(32 * (1 - expectedW));
      w.elo += delta;
      l.elo -= delta;
    }

    const headToHead = (idA, idB) => {
      let aWins = 0;
      let bWins = 0;
      for (const m of this.history) {
        if (m.isConsistencyCheck) continue;
        if (m.winnerId === idA && m.loserId === idB) aWins++;
        if (m.winnerId === idB && m.loserId === idA) bWins++;
      }
      return bWins - aWins;
    };

    const list = Array.from(stats.values()).map((entry) => {
      const played = entry.wins + entry.losses;
      return {
        ...entry,
        winRate: played > 0 ? Math.round((entry.wins / played) * 100) : 0,
      };
    });

    list.sort((a, b) => {
      // In KOTH, final winner is always #1
      if (this.mode === 'koth' && this.winner) {
        if (a.track.id === this.winner.id) return -1;
        if (b.track.id === this.winner.id) return 1;
      }
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.elo !== a.elo) return b.elo - a.elo;
      const h2h = headToHead(a.track.id, b.track.id);
      if (h2h !== 0) return h2h;
      return a.losses - b.losses;
    });

    return list.map((item, idx) => ({ rank: idx + 1, ...item }));
  }

  getAbxSummary() {
    if (this.mode !== 'abx') return null;
    const total = this.abxResults.length;
    const correct = this.abxResults.filter((r) => r.correct).length;
    const pValue = computeBinomialPValue(correct, total);
    const significant = pValue < 0.05;
    let verdict = 'No statistically significant difference detected (p ≥ 0.05).';
    if (pValue < 0.01) {
      verdict = 'Highly significant audible difference detected (p < 0.01).';
    } else if (significant) {
      verdict = 'Statistically significant audible difference detected (p < 0.05).';
    }

    return {
      trackA: this.abxTrackA,
      trackB: this.abxTrackB,
      correct,
      total,
      accuracyPct: total > 0 ? Math.round((correct / total) * 100) : 0,
      pValue,
      significant,
      verdict,
      trials: [...this.abxResults],
    };
  }

  getSummary() {
    const rankings = this.computeRankings();
    const consistency = this.computeConsistency();
    const abx = this.getAbxSummary();
    return {
      mode: this.mode,
      settings: { ...this.settings },
      winner: this.winner,
      rankings,
      consistency,
      abx,
      history: [...this.history],
      totalMatches: this.totalMatches,
      notesByTrackId: Object.fromEntries(
        Array.from(this.notesByTrackId.entries()).map(([k, v]) => [k, { tags: [...v.tags], text: v.text }])
      ),
    };
  }
}

/**
 * Generate a clean, client-ready Markdown shootout report.
 */
export function generateMarkdownReport(summary) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const modeLabel = {
    koth: 'King of the Hill',
    'round-robin': 'Round-Robin (Ranked + Consistency Check)',
    abx: 'ABX Statistical Discrimination Test',
  }[summary.mode] || summary.mode;

  const lines = [
    `# Saint Gordon Collective — Master Clash Shootout Report`,
    ``,
    `- **Date:** ${dateStr}`,
    `- **Format:** ${modeLabel}`,
    `- **Loop Duration:** ${summary.settings.previewDuration}s (${summary.settings.regionMode})`,
    `- **LUFS Loudness Matching:** ${summary.settings.lufsMatch ? 'Enabled (ITU-R BS.1770 K-weighted)' : 'Disabled'}`,
    ``,
  ];

  if (summary.mode === 'abx' && summary.abx) {
    const a = summary.abx;
    lines.push(
      `## ABX Verdict`,
      ``,
      `- **Track A:** \`${a.trackA.filename}\` (${formatSpecsInline(a.trackA)})`,
      `- **Track B:** \`${a.trackB.filename}\` (${formatSpecsInline(a.trackB)})`,
      `- **Score:** **${a.correct} / ${a.total}** (${a.accuracyPct}%)`,
      `- **One-Tailed Binomial p-value:** \`p = ${a.pValue.toFixed(4)}\``,
      `- **Conclusion:** ${a.verdict}`,
      ``,
      `### Trial Log`,
      ``,
      `| Trial | Actual X | Your Pick | Result |`,
      `|---:|---|---|---|`
    );
    for (const t of a.trials) {
      lines.push(`| ${t.trialNumber} | ${t.actualX} (\`${t.actualFilename}\`) | ${t.guessed} | ${t.correct ? 'Correct' : 'Miss'} |`);
    }
    return lines.join('\n') + '\n';
  }

  if (summary.winner) {
    lines.push(
      `## Champion`,
      ``,
      `**\`${summary.winner.filename}\`**`,
      `- Specs: ${formatSpecsInline(summary.winner)}`,
      `- Preview Window: ${formatTimeRange(summary.winner.clipStart, summary.winner.clipDuration)}`,
      ``
    );
  }

  if (summary.consistency) {
    lines.push(
      `## Ear Consistency Check`,
      ``,
      `- **Consistency Score:** ${summary.consistency.consistentCount}/${summary.consistency.totalChecks} (${summary.consistency.scorePct}%)`,
      ``
    );
  }

  lines.push(
    `## Final Rankings & Loudness Specs`,
    ``,
    `| Rank | Track | W–L | Elo | Integrated LUFS | Sample Peak | Crest | Blind Notes |`,
    `|---:|---|---|---:|---:|---:|---:|---|`
  );

  for (const r of summary.rankings) {
    const t = r.track;
    const noteParts = [];
    if (r.notes?.tags?.length) noteParts.push(r.notes.tags.join(', '));
    if (r.notes?.text?.trim()) noteParts.push(r.notes.text.trim());
    const notesStr = noteParts.join(' — ').replace(/\|/g, '/') || '—';
    const lufsStr = Number.isFinite(t.lufs) ? `${t.lufs.toFixed(1)} LUFS` : '—';
    const peakStr = Number.isFinite(t.samplePeakDb) ? `${t.samplePeakDb.toFixed(1)} dBFS` : '—';
    const crestStr = Number.isFinite(t.crestDb) ? `${t.crestDb.toFixed(1)} dB` : '—';
    lines.push(
      `| #${r.rank} | \`${t.filename}\` | ${r.wins}–${r.losses} | ${r.elo} | ${lufsStr} | ${peakStr} | ${crestStr} | ${notesStr} |`
    );
  }

  lines.push(
    ``,
    `## Matchup History`,
    ``,
    `| Match | Winner | Defeated | Type |`,
    `|---:|---|---|---|`
  );

  for (const m of summary.history) {
    const tag = m.isConsistencyCheck ? 'Consistency Check' : 'Match';
    lines.push(`| ${m.matchNumber} | \`${m.winnerFilename}\` | \`${m.loserFilename}\` | ${tag} |`);
  }

  lines.push(``, `---`, `*Generated locally by Master Clash — Saint Gordon Collective*`);
  return lines.join('\n') + '\n';
}

export function generateJsonReport(summary) {
  const sanitized = {
    generatedAt: new Date().toISOString(),
    generator: 'Master Clash — Saint Gordon Collective',
    mode: summary.mode,
    settings: summary.settings,
    winner: summary.winner ? serializeTrackMeta(summary.winner) : null,
    consistency: summary.consistency,
    abx: summary.abx
      ? {
          ...summary.abx,
          trackA: serializeTrackMeta(summary.abx.trackA),
          trackB: serializeTrackMeta(summary.abx.trackB),
        }
      : null,
    rankings: summary.rankings.map((r) => ({
      rank: r.rank,
      wins: r.wins,
      losses: r.losses,
      winRate: r.winRate,
      elo: r.elo,
      notes: r.notes,
      track: serializeTrackMeta(r.track),
    })),
    history: summary.history,
  };
  return JSON.stringify(sanitized, null, 2);
}

function serializeTrackMeta(t) {
  return {
    id: t.id,
    filename: t.filename,
    formatDesc: t.formatDesc,
    duration: Number((t.duration || 0).toFixed(2)),
    sampleRate: t.sampleRate,
    channels: t.channels,
    sizeMb: t.sizeMb,
    lufs: t.lufs,
    rmsDb: t.rmsDb,
    samplePeakDb: t.samplePeakDb,
    crestDb: t.crestDb,
    clipStart: t.clipStart,
    clipDuration: t.clipDuration,
  };
}

function formatSpecsInline(t) {
  const parts = [t.formatDesc, formatTime(t.duration)];
  if (Number.isFinite(t.lufs)) parts.push(`${t.lufs.toFixed(1)} LUFS`);
  if (Number.isFinite(t.samplePeakDb)) parts.push(`Peak ${t.samplePeakDb.toFixed(1)} dBFS`);
  return parts.join(' · ');
}
