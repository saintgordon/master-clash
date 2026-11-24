/**
 * Master Clash — Saint Gordon Collective
 * Main Client-Side Controller (100% In-Browser + Optional Local CLI Companion Mode)
 */

import {
  evaluateAudioFile,
  formatTime,
  formatTimeRange,
  analyzeAudioBuffer,
  findLoudestWindow,
  computeWaveformPeaks,
  sliceAudioBuffer,
} from './audio-dsp.js';
import {
  TournamentEngine,
  QUICK_NOTE_TAGS,
  generateMarkdownReport,
  generateJsonReport,
} from './tournament.js';
import { AudioEngine, decodeAudioDataSafe } from './audio-engine.js';
import { generateDemoMasterFiles } from './demo-synth.js';

const audio = new AudioEngine();
const tournament = new TournamentEngine();

const App = {
  state: {
    allFileEntries: [], // [{ key, file, source: 'browser'|'local', localMeta?, track? }]
    tracks: [], // Currently active filtered & decoded tracks
    selectedTrackIds: new Set(),
    searchQuery: '',
    previewDuration: 15,
    regionMode: 'midpoint', // 'midpoint' | 'loudest' | 'intro' | 'outro' | 'custom'
    customStartRatio: 0.5, // Normalized start position [0..1] for custom region
    formatMode: 'koth', // 'koth' | 'round-robin' | 'abx'
    abxTrials: 8,
    pureBlind: false,
    activePanel: 'scan',
    lastSummary: null,
    activeWinnerBlobUrl: null,
    localServer: {
      connected: false,
      hasFfmpeg: false,
      folder: '',
      platform: '',
    },
    isDraggingSetupWave: false,
    isDraggingArenaScrub: false,
  },

  els: {},
  rafId: null,
  spectrumGradient: null,
  vuDecayL: 0,
  vuDecayR: 0,

  init() {
    this.cacheElements();
    this.setFooterYear();
    this.renderBlindTagChips();
    this.bindEvents();
    this.detectLocalServer();
  },

  cacheElements() {
    const id = (x) => document.getElementById(x);
    this.els = {
      // Panels & Navigation
      phaseScan: id('phase-scan'),
      phaseArena: id('phase-arena'),
      phaseVictory: id('phase-victory'),
      brandHomeLink: id('brand-home-link'),
      btnHeaderNew: id('btn-header-new'),
      modeStatusText: id('mode-status-text'),
      phaseSteps: document.querySelectorAll('.phase-step'),

      // Local Server Banner
      localServerBanner: id('local-server-banner'),
      localServerFolder: id('local-server-folder'),
      btnLocalBrowse: id('btn-local-browse'),
      btnLocalRescan: id('btn-local-rescan'),

      // Upload & Setup
      btnTryDemo: id('btn-try-demo'),
      uploadDropzone: id('upload-dropzone'),
      dropzoneClickTarget: id('dropzone-click-target'),
      fileUploadInput: id('file-upload-input'),
      folderUploadInput: id('folder-upload-input'),
      btnSelectFiles: id('btn-select-files'),
      btnSelectFolder: id('btn-select-folder'),
      toggleMasterFilter: id('toggle-master-filter'),
      togglePureBlind: id('toggle-pure-blind'),
      decodeProgressContainer: id('decode-progress-container'),
      decodeProgressText: id('decode-progress-text'),
      decodeProgressPct: id('decode-progress-pct'),
      decodeProgressBar: id('decode-progress-bar'),
      decodeErrorsBanner: id('decode-errors-banner'),
      decodeErrorsTitle: id('decode-errors-title'),
      decodeErrorsList: id('decode-errors-list'),
      btnDismissErrors: id('btn-dismiss-errors'),

      // Track Table & Setup Controls
      scanResults: id('scan-results-container'),
      resultsCountText: id('results-count-text'),
      resultsSubText: id('results-sub-text'),
      trackSearchInput: id('track-search-input'),
      btnAddMoreFiles: id('btn-add-more-files'),
      btnToggleAll: id('btn-toggle-all'),
      btnClearFiles: id('btn-clear-files'),
      trackListBody: id('track-list-body'),

      // Waveform Picker
      regionPresetButtons: id('region-preset-buttons'),
      setupWaveformWrap: id('setup-waveform-wrap'),
      setupWaveformCanvas: id('setup-waveform-canvas'),
      setupWindowBox: id('setup-window-box'),
      setupWindowLabel: id('setup-window-label'),
      setupWaveStart: id('setup-wave-start'),
      setupWaveEnd: id('setup-wave-end'),

      // Launch Settings
      durationSelector: id('duration-selector'),
      formatSelector: id('format-selector'),
      formatHint: id('format-hint'),
      abxTrialsSetting: id('abx-trials-setting'),
      abxTrialsSelector: id('abx-trials-selector'),
      toggleLufsMatch: id('toggle-lufs-match'),
      btnStartTournament: id('btn-start-tournament'),
      startBtnLabel: id('start-btn-label'),

      // Arena (Fragment Deck)
      studioDeck: id('studio-deck'),
      arenaMatchBadge: id('arena-match-badge'),
      arenaStageTitle: id('arena-stage-title'),
      arenaLadderProgress: id('arena-ladder-progress'),
      btnUndoVote: id('btn-undo-vote'),
      deckModeReadout: id('deck-mode-readout'),
      deckStatePill: id('deck-state-pill'),
      cardCandA: id('card-cand-a'),
      cardCandB: id('card-cand-b'),
      labelCandA: id('label-cand-a'),
      labelCandB: id('label-cand-b'),
      emblemCandA: id('emblem-cand-a'),
      emblemCandB: id('emblem-cand-b'),
      listenLabelA: id('listen-label-a'),
      listenLabelB: id('listen-label-b'),
      voteLabelA: id('vote-label-a'),
      voteLabelB: id('vote-label-b'),
      playingPillA: id('playing-pill-a'),
      playingPillB: id('playing-pill-b'),
      btnListenA: id('btn-listen-a'),
      btnListenB: id('btn-listen-b'),
      btnListenX: id('btn-listen-x'),
      btnPickA: id('btn-pick-a'),
      btnPickB: id('btn-pick-b'),
      btnToggleToA: id('btn-toggle-to-a'),
      btnToggleToX: id('btn-toggle-to-x'),
      btnToggleToB: id('btn-toggle-to-b'),
      abxMysteryBox: id('abx-mystery-box'),
      centerVsSeal: id('center-vs-seal'),
      shortcutXHint: id('shortcut-x-hint'),
      notesDrawerA: id('notes-drawer-a'),
      notesDrawerB: id('notes-drawer-b'),
      tagsCandA: id('tags-cand-a'),
      tagsCandB: id('tags-cand-b'),
      noteInputA: id('note-input-a'),
      noteInputB: id('note-input-b'),

      // Meters & Transport
      clipLedL: id('clip-led-l'),
      clipLedR: id('clip-led-r'),
      vuMeterL: id('vu-meter-l'),
      vuMeterR: id('vu-meter-r'),
      vuPeakL: id('vu-peak-l'),
      vuPeakR: id('vu-peak-r'),
      visualizerCanvas: id('audio-visualizer-canvas'),
      spectrumModeTag: id('spectrum-mode-tag'),
      timelineScrubber: id('timeline-scrubber'),
      arenaLoopWaveCanvas: id('arena-loop-wave-canvas'),
      timelineProgressBar: id('timeline-progress-bar'),
      timelinePlayhead: id('timeline-playhead'),
      timelineCurrentTime: id('timeline-current-time'),
      timelineTotalTime: id('timeline-total-time'),
      btnPlayPause: id('btn-play-pause'),
      playBtnGlyph: id('play-btn-glyph'),
      playBtnText: id('play-btn-text'),
      btnRestartLoop: id('btn-restart-loop'),
      btnAutoFlip: id('btn-auto-flip'),
      monitorMatrixBtns: document.querySelectorAll('.monitor-matrix .deck-seg-btn'),
      btnArenaLufs: id('btn-arena-lufs'),
      gainTrimDisplay: id('gain-trim-display'),
      masterVolumeSlider: id('master-volume-slider'),
      alignOffsetSlider: id('align-offset-slider'),
      alignOffsetReadout: id('align-offset-readout'),
      btnResetAlign: id('btn-reset-align'),

      // Victory
      verdictFormatTag: id('verdict-format-tag'),
      victoryBadge: id('victory-badge'),
      verdictConsistencyBadge: id('verdict-consistency-badge'),
      victoryTitle: id('victory-title'),
      victorySubtitle: id('victory-subtitle'),
      winnerFilename: id('winner-filename'),
      winnerSpecsRow: id('winner-specs-row'),
      abxVerdictBox: id('abx-verdict-box'),
      winnerPlayerWrap: id('winner-player-wrap'),
      winnerAudioPlayer: id('winner-audio-player'),
      btnCopyWinnerName: id('btn-copy-winner-name'),
      btnDownloadWinner: id('btn-download-winner'),
      btnRevealFinder: id('btn-reveal-finder'),
      btnExportMd: id('btn-export-md'),
      btnExportJson: id('btn-export-json'),
      btnCopyReport: id('btn-copy-report'),
      btnNewTournament: id('btn-new-tournament'),
      rankingsCard: id('rankings-card'),
      rankingsTableBody: id('rankings-table-body'),
      historyCardTitle: id('history-card-title'),
      tournamentHistoryList: id('tournament-history-list'),

      // Toast & Footer
      toastContainer: id('toast-container'),
      footerYear: id('footer-year'),
    };
  },

  setFooterYear() {
    if (this.els.footerYear) {
      this.els.footerYear.textContent = String(new Date().getFullYear());
    }
  },

  renderBlindTagChips() {
    const buildChips = (container, side) => {
      container.innerHTML = '';
      for (const tag of QUICK_NOTE_TAGS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag-chip';
        btn.dataset.tag = tag;
        btn.textContent = tag;
        btn.addEventListener('click', () => {
          const activeTags = tournament.toggleTagForSide(side, tag);
          btn.classList.toggle('active', activeTags.includes(tag));
        });
        container.appendChild(btn);
      }
    };
    buildChips(this.els.tagsCandA, 'A');
    buildChips(this.els.tagsCandB, 'B');
  },

  bindEvents() {
    // Auto-flip callback from AudioEngine
    audio.onAutoFlip = (nextSide) => {
      this.updateActiveSideUI(nextSide);
      this.drawArenaLoopWaveform();
    };

    // Header navigation
    const handleReturnToScan = (e) => {
      if (e) e.preventDefault();
      if (this.state.activePanel === 'arena' && tournament.status === 'in_progress') {
        const ok = window.confirm('Leave the active blind shootout and return to setup?');
        if (!ok) return;
      }
      this.switchPanel('scan');
    };
    this.els.brandHomeLink.addEventListener('click', handleReturnToScan);
    this.els.btnHeaderNew.addEventListener('click', handleReturnToScan);

    // Demo Shootout
    this.els.btnTryDemo.addEventListener('click', () => this.loadDemoShootout());

    // Local Server Actions
    this.els.btnLocalBrowse.addEventListener('click', () => this.browseLocalFolder());
    this.els.btnLocalRescan.addEventListener('click', () => {
      if (this.state.localServer.folder) {
        this.scanLocalFolder(this.state.localServer.folder);
      }
    });

    // Dropzone click & file inputs
    this.els.dropzoneClickTarget.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      audio.ensureContext();
      this.els.fileUploadInput.click();
    });

    this.els.btnSelectFiles.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.ensureContext();
      this.els.fileUploadInput.click();
    });

    this.els.btnAddMoreFiles.addEventListener('click', () => {
      audio.ensureContext();
      this.els.fileUploadInput.click();
    });

    this.els.btnSelectFolder.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.ensureContext();
      this.els.folderUploadInput.click();
    });

    this.els.fileUploadInput.addEventListener('change', (e) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = ''; // Allow re-selecting the same file later
      if (files.length > 0) this.ingestFiles(files, { append: this.state.tracks.length > 0 });
    });

    this.els.folderUploadInput.addEventListener('change', (e) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      if (files.length > 0) this.ingestFiles(files, { append: false });
    });

    // Drag & Drop with recursive folder entry traversal
    const dz = this.els.uploadDropzone;
    ['dragenter', 'dragover'].forEach((evt) => {
      dz.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dz.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.remove('drag-over');
      });
    });
    dz.addEventListener('drop', async (e) => {
      audio.ensureContext();
      const files = await extractDroppedFiles(e.dataTransfer);
      if (files.length > 0) {
        this.ingestFiles(files, { append: this.state.tracks.length > 0 });
      }
    });

    // Dismiss decode errors
    this.els.btnDismissErrors.addEventListener('click', () => {
      this.els.decodeErrorsBanner.classList.add('hidden');
    });

    // Live filter toggles & search
    this.els.toggleMasterFilter.addEventListener('change', () => {
      this.reapplyFiltersAndSync();
    });

    this.els.togglePureBlind.addEventListener('change', (e) => {
      this.state.pureBlind = e.target.checked;
      this.renderTrackList();
    });

    this.els.trackSearchInput.addEventListener('input', (e) => {
      this.state.searchQuery = e.target.value;
      this.renderTrackList();
    });

    this.els.btnToggleAll.addEventListener('click', () => this.toggleAllVisibleTracks());
    this.els.btnClearFiles.addEventListener('click', () => this.clearAllTracks());

    // Region Presets & Interactive Setup Waveform
    this.els.regionPresetButtons.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.regionPresetButtons.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.regionMode = btn.dataset.region;
        this.resliceAllTracks();
      });
    });

    const waveWrap = this.els.setupWaveformWrap;
    const handleWavePointer = (clientX) => {
      const refTrack = this.getReferenceTrack();
      if (!refTrack) return;
      const rect = waveWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const clipDur = Math.min(this.state.previewDuration, refTrack.duration);
      const maxStart = Math.max(0, refTrack.duration - clipDur);
      const centeredStart = Math.max(0, Math.min(maxStart, pct * refTrack.duration - clipDur / 2));
      this.state.regionMode = 'custom';
      this.state.customStartRatio = refTrack.duration > 0 ? centeredStart / refTrack.duration : 0;
      this.els.regionPresetButtons.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      this.updateSetupWaveformOverlay(refTrack, centeredStart, clipDur);
    };

    waveWrap.addEventListener('pointerdown', (e) => {
      if (!this.getReferenceTrack()) return;
      this.state.isDraggingSetupWave = true;
      waveWrap.setPointerCapture(e.pointerId);
      handleWavePointer(e.clientX);
    });
    waveWrap.addEventListener('pointermove', (e) => {
      if (!this.state.isDraggingSetupWave) return;
      handleWavePointer(e.clientX);
    });
    const finishWaveDrag = () => {
      if (!this.state.isDraggingSetupWave) return;
      this.state.isDraggingSetupWave = false;
      this.resliceAllTracks();
    };
    waveWrap.addEventListener('pointerup', finishWaveDrag);
    waveWrap.addEventListener('pointercancel', finishWaveDrag);

    // Duration Selector
    this.els.durationSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.durationSelector.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.previewDuration = parseFloat(btn.dataset.sec);
        this.resliceAllTracks();
      });
    });

    // Format Selector
    const formatHints = {
      koth: 'Fast elimination ladder with Undo. Best for narrowing large batches quickly.',
      'round-robin': 'Every pair faces off for full 1st–Nth Elo rankings + a hidden Ear Consistency rematch.',
      abx: 'Select exactly 2 tracks. Identify whether mystery sample X matches A or B with binomial p-value.',
    };
    this.els.formatSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.formatSelector.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.formatMode = btn.dataset.mode;
        this.els.formatHint.textContent = formatHints[this.state.formatMode] || '';
        this.els.abxTrialsSetting.classList.toggle('hidden', this.state.formatMode !== 'abx');
        this.updateStartButtonState();
      });
    });

    this.els.abxTrialsSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.abxTrialsSelector.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.abxTrials = parseInt(btn.dataset.trials, 10);
      });
    });

    // Loudness Match Setup Toggle
    this.els.toggleLufsMatch.addEventListener('change', (e) => {
      audio.autoLufsMatch = e.target.checked;
      this.syncLufsButtonUI();
    });

    // Start Tournament
    this.els.btnStartTournament.addEventListener('click', () => {
      audio.ensureContext();
      this.startTournament();
    });

    // Arena Side Switching
    const bindSwitch = (el, side) => {
      el.addEventListener('click', async () => {
        audio.ensureContext();
        await audio.switchSide(side);
        this.updateActiveSideUI(side);
        this.updatePlayPauseBtn(audio.isPlaying);
        this.drawArenaLoopWaveform();
        this.startMeterLoop();
      });
    };
    bindSwitch(this.els.btnListenA, 'A');
    bindSwitch(this.els.btnListenB, 'B');
    bindSwitch(this.els.btnListenX, 'X');
    bindSwitch(this.els.btnToggleToA, 'A');
    bindSwitch(this.els.btnToggleToB, 'B');
    bindSwitch(this.els.btnToggleToX, 'X');

    // Arena Voting & Undo
    this.els.btnPickA.addEventListener('click', () => this.castVote('A'));
    this.els.btnPickB.addEventListener('click', () => this.castVote('B'));
    this.els.btnUndoVote.addEventListener('click', () => this.undoVote());

    // Blind Note Textareas
    this.els.noteInputA.addEventListener('input', (e) => {
      tournament.setNoteForSide('A', e.target.value);
    });
    this.els.noteInputB.addEventListener('input', (e) => {
      tournament.setNoteForSide('B', e.target.value);
    });

    // Transport Controls
    this.els.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    this.els.btnRestartLoop.addEventListener('click', () => this.restartLoop());
    this.els.btnAutoFlip.addEventListener('click', () => this.toggleAutoFlip());

    // Monitor Matrix (Stereo / Mono / Side)
    this.els.monitorMatrixBtns.forEach((btn) => {
      btn.addEventListener('click', () => this.setMonitorMode(btn.dataset.monitor));
    });

    // Arena Live LUFS Toggle
    this.els.btnArenaLufs.addEventListener('click', () => this.toggleLufsLive());

    // Master Volume Slider (persists even before AudioContext is created)
    this.els.masterVolumeSlider.addEventListener('input', (e) => {
      audio.setVolume(parseFloat(e.target.value));
    });

    // Micro Time Alignment Trim
    this.els.alignOffsetSlider.addEventListener('input', (e) => {
      const ms = parseInt(e.target.value, 10);
      this.els.alignOffsetReadout.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
      audio.setAlignmentOffsetMs(ms);
    });
    this.els.btnResetAlign.addEventListener('click', () => {
      this.els.alignOffsetSlider.value = '0';
      this.els.alignOffsetReadout.textContent = '0 ms';
      audio.setAlignmentOffsetMs(0);
    });

    // Arena Interactive Loop Scrubber (click + drag + keyboard)
    const scrubber = this.els.timelineScrubber;
    const seekFromClientX = async (clientX) => {
      const rect = scrubber.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      await audio.seek(pct * audio.duration);
      this.updatePlayheadVisuals(audio.getCurrentPlayhead(), audio.duration);
    };
    scrubber.addEventListener('pointerdown', (e) => {
      audio.ensureContext();
      this.state.isDraggingArenaScrub = true;
      scrubber.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    });
    scrubber.addEventListener('pointermove', (e) => {
      if (!this.state.isDraggingArenaScrub) return;
      seekFromClientX(e.clientX);
    });
    const endScrub = () => {
      this.state.isDraggingArenaScrub = false;
    };
    scrubber.addEventListener('pointerup', endScrub);
    scrubber.addEventListener('pointercancel', endScrub);
    scrubber.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1.0 : -1.0;
        await audio.seek(audio.getCurrentPlayhead() + delta);
        this.updatePlayheadVisuals(audio.getCurrentPlayhead(), audio.duration);
      }
    });

    // Verdict Screen Actions
    this.els.btnCopyWinnerName.addEventListener('click', () => {
      const winner = this.state.lastSummary?.winner;
      if (!winner) return;
      copyTextSafe(winner.filename)
        .then(() => this.showToast('Copied winner filename.'))
        .catch(() => this.showToast('Clipboard unavailable in this browser context.', true));
    });

    this.els.btnRevealFinder.addEventListener('click', async () => {
      const winner = this.state.lastSummary?.winner;
      if (!winner?.localId) return;
      try {
        await fetch('/api/reveal_in_finder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track_id: winner.localId }),
        });
      } catch {
        this.showToast('Could not reveal file on local server.', true);
      }
    });

    this.els.btnExportMd.addEventListener('click', () => {
      if (!this.state.lastSummary) return;
      const md = generateMarkdownReport(this.state.lastSummary);
      downloadTextFile(md, `master-clash-report-${new Date().toISOString().slice(0, 10)}.md`, 'text/markdown');
      this.showToast('Exported Markdown report.');
    });

    this.els.btnExportJson.addEventListener('click', () => {
      if (!this.state.lastSummary) return;
      const json = generateJsonReport(this.state.lastSummary);
      downloadTextFile(json, `master-clash-report-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      this.showToast('Exported JSON report.');
    });

    this.els.btnCopyReport.addEventListener('click', () => {
      if (!this.state.lastSummary) return;
      const md = generateMarkdownReport(this.state.lastSummary);
      copyTextSafe(md)
        .then(() => this.showToast('Copied Markdown report to clipboard.'))
        .catch(() => this.showToast('Clipboard unavailable — use Export Report (.md).', true));
    });

    this.els.btnNewTournament.addEventListener('click', () => {
      if (this.els.winnerAudioPlayer) this.els.winnerAudioPlayer.pause();
      this.switchPanel('scan');
    });

    // Global Arena Keyboard Shortcuts (international layout safe via e.code)
    window.addEventListener('keydown', async (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (this.state.activePanel !== 'arena') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if ((e.code === 'Digit1' || e.key === '1') && !e.shiftKey) {
        e.preventDefault();
        audio.ensureContext();
        await audio.switchSide('A');
        this.updateActiveSideUI('A');
        this.updatePlayPauseBtn(audio.isPlaying);
        this.drawArenaLoopWaveform();
        this.startMeterLoop();
      } else if ((e.code === 'Digit2' || e.key === '2') && !e.shiftKey) {
        e.preventDefault();
        audio.ensureContext();
        await audio.switchSide('B');
        this.updateActiveSideUI('B');
        this.updatePlayPauseBtn(audio.isPlaying);
        this.drawArenaLoopWaveform();
        this.startMeterLoop();
      } else if ((e.code === 'Digit3' || e.key === '3') && !e.shiftKey && tournament.mode === 'abx') {
        e.preventDefault();
        audio.ensureContext();
        await audio.switchSide('X');
        this.updateActiveSideUI('X');
        this.updatePlayPauseBtn(audio.isPlaying);
        this.drawArenaLoopWaveform();
        this.startMeterLoop();
      } else if (e.code === 'ArrowLeft' || (e.shiftKey && e.code === 'Digit1')) {
        e.preventDefault();
        this.castVote('A');
      } else if (e.code === 'ArrowRight' || (e.shiftKey && e.code === 'Digit2')) {
        e.preventDefault();
        this.castVote('B');
      } else if (e.code === 'KeyZ') {
        e.preventDefault();
        this.undoVote();
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        this.restartLoop();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        this.setMonitorMode(audio.monitorMode === 'mono' ? 'stereo' : 'mono');
      } else if (e.code === 'KeyS') {
        e.preventDefault();
        this.setMonitorMode(audio.monitorMode === 'side' ? 'stereo' : 'side');
      } else if (e.code === 'KeyL') {
        e.preventDefault();
        this.toggleLufsLive();
      }
    });
  },

  /* ========================================================================
     Local CLI Companion Server Integration
     ======================================================================== */

  async detectLocalServer() {
    const marker = document.querySelector('meta[name="mc-local-server"]');
    if (!marker || marker.getAttribute('content') !== '1') return;

    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.server_mode) return;

      this.state.localServer = {
        connected: true,
        hasFfmpeg: Boolean(data.has_ffmpeg),
        folder: data.folder || '',
        platform: data.platform || '',
      };

      this.els.modeStatusText.textContent = data.has_ffmpeg
        ? 'Local CLI · ffmpeg'
        : 'Local CLI Server';
      this.els.localServerBanner.classList.remove('hidden');
      this.els.localServerFolder.textContent = data.folder || 'No folder pre-loaded yet';
      this.els.btnLocalBrowse.classList.toggle('hidden', data.platform !== 'Darwin');

      if (Array.isArray(data.tracks) && data.tracks.length > 0) {
        await this.ingestLocalServerTracks(data.tracks);
      }
    } catch {
      // Pure GitHub Pages / static file mode
    }
  },

  async browseLocalFolder() {
    try {
      const res = await fetch('/api/browse_folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter_only_masters: this.els.toggleMasterFilter.checked }),
      });
      const payload = await res.json();
      if (payload.success && payload.data) {
        this.state.localServer.folder = payload.folder;
        this.els.localServerFolder.textContent = payload.folder;
        await this.ingestLocalServerTracks(payload.data.tracks || []);
      }
    } catch {
      this.showToast('Native folder picker unavailable.', true);
    }
  },

  async scanLocalFolder(folder) {
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder,
          filter_only_masters: this.els.toggleMasterFilter.checked,
        }),
      });
      const data = await res.json();
      await this.ingestLocalServerTracks(data.tracks || []);
    } catch {
      this.showToast('Could not rescan local folder.', true);
    }
  },

  async ingestLocalServerTracks(serverTracks) {
    if (!serverTracks.length) {
      this.showToast('No matching audio tracks found in local folder.', true);
      return;
    }

    const ctx = audio.ensureContext();
    this.showProgress(0, `Loading ${serverTracks.length} local tracks...`);
    const loaded = [];
    const errors = [];

    for (let i = 0; i < serverTracks.length; i++) {
      const st = serverTracks[i];
      const pct = Math.round(((i + 1) / serverTracks.length) * 100);
      this.showProgress(pct, `Decoding local track: ${st.filename} (${i + 1}/${serverTracks.length})`);

      try {
        const useTranscode = this.state.localServer.hasFfmpeg && ['.aif', '.aiff', '.caf', '.wma'].includes(st.extension);
        const url = `/api/audio/full?track_id=${encodeURIComponent(st.id)}${useTranscode ? '&transcode=1' : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const file = new File([blob], st.filename, { type: blob.type || 'audio/wav' });
        const track = await this.decodeAndAnalyzeFile(ctx, file, st);
        loaded.push(track);
      } catch (err) {
        errors.push(`${st.filename}: ${err.message || 'decode failed'}`);
      }
    }

    this.hideProgress();
    if (errors.length) this.showDecodeErrors(errors);

    if (loaded.length > 0) {
      this.state.allFileEntries = loaded.map((t) => ({
        key: t.localId || t.id,
        file: t.file,
        track: t,
      }));
      this.state.tracks = loaded;
      this.state.selectedTrackIds = new Set(loaded.map((t) => t.id));
      this.renderTrackList();
      this.showToast(`Loaded ${loaded.length} local master track${loaded.length > 1 ? 's' : ''}.`);
    }
  },

  /* ========================================================================
     Demo Shootout Loader (Zero-Bloat Client-Side Synth)
     ======================================================================== */

  async loadDemoShootout() {
    audio.ensureContext();
    this.els.btnTryDemo.disabled = true;
    this.showProgress(5, 'Preparing synthetic studio masters...');

    try {
      const demoFiles = await generateDemoMasterFiles((pct, msg) => {
        this.showProgress(pct, msg);
      });
      await this.ingestFiles(demoFiles, { append: false, bypassMasterToast: true });
      this.showToast('Demo loaded — 4 distinct mastering chains ready!');
      this.els.scanResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      this.showToast('Could not synthesize demo shootout in this browser.', true);
    } finally {
      this.hideProgress();
      this.els.btnTryDemo.disabled = false;
    }
  },

  /* ========================================================================
     Client-Side File Ingestion, Live Filtering & Memory-Efficient Slicing
     ======================================================================== */

  async ingestFiles(files, { append = false, bypassMasterToast = false } = {}) {
    if (!append) {
      this.state.allFileEntries = [];
      this.state.tracks = [];
      this.state.selectedTrackIds.clear();
    }

    const existingKeys = new Set(this.state.allFileEntries.map((e) => e.key));
    for (const file of files) {
      const key = `${file.name}__${file.size}__${file.lastModified}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        this.state.allFileEntries.push({ key, file, track: null });
      }
    }

    await this.reapplyFiltersAndSync({ bypassMasterToast });
  },

  async reapplyFiltersAndSync({ bypassMasterToast = false } = {}) {
    const filterOnlyMasters = this.els.toggleMasterFilter.checked;
    const ctx = audio.ensureContext();

    const acceptedEntries = [];
    let excludedUnmastered = 0;
    let excludedNonMaster = 0;

    for (const entry of this.state.allFileEntries) {
      const verdict = evaluateAudioFile(entry.file.name, { filterOnlyMasters });
      if (verdict.accepted) {
        acceptedEntries.push(entry);
      } else if (verdict.reason === 'unmastered') {
        excludedUnmastered++;
      } else if (verdict.reason === 'not_master') {
        excludedNonMaster++;
      }
    }

    if (acceptedEntries.length === 0) {
      this.state.tracks = [];
      this.state.selectedTrackIds.clear();
      this.renderTrackList(excludedUnmastered);
      if (this.state.allFileEntries.length > 0 && !bypassMasterToast) {
        if (excludedUnmastered > 0) {
          this.showToast(
            `Excluded ${excludedUnmastered} UNMASTERED file(s). Toggle filter off to compare all audio.`,
            true
          );
        } else if (excludedNonMaster > 0) {
          this.showToast(
            `${excludedNonMaster} audio file(s) hidden by MASTER/MASTERED filter. Toggle filter off to include them.`,
            true
          );
        } else {
          this.showToast('No supported audio files found.', true);
        }
      }
      return;
    }

    const toDecode = acceptedEntries.filter((e) => !e.track);
    const decodeErrors = [];

    if (toDecode.length > 0) {
      this.showProgress(0, `Decoding ${toDecode.length} track(s)...`);
      for (let i = 0; i < toDecode.length; i++) {
        const entry = toDecode[i];
        const pct = Math.round(((i + 1) / toDecode.length) * 100);
        this.showProgress(pct, `Analyzing ${entry.file.name} (${i + 1} of ${toDecode.length})...`);
        try {
          entry.track = await this.decodeAndAnalyzeFile(ctx, entry.file);
        } catch (err) {
          console.error(`Failed to decode ${entry.file.name}:`, err);
          const lower = entry.file.name.toLowerCase();
          if (lower.endsWith('.aif') || lower.endsWith('.aiff')) {
            decodeErrors.push(
              `${entry.file.name} — Browser lacks native AIFF decoder. Convert to WAV/FLAC or run local "python3 master_ab.py" (ffmpeg).`
            );
          } else {
            decodeErrors.push(`${entry.file.name} — Could not decode audio (${err?.message || 'unsupported codec'}).`);
          }
        }
      }
      this.hideProgress();
    }

    if (decodeErrors.length > 0) {
      this.showDecodeErrors(decodeErrors);
    } else {
      this.els.decodeErrorsBanner.classList.add('hidden');
    }

    const validTracks = acceptedEntries.map((e) => e.track).filter(Boolean);
    const prevSelected = new Set(this.state.selectedTrackIds);
    const isFreshLoad = this.state.tracks.length === 0;

    this.state.tracks = validTracks;
    this.state.selectedTrackIds = new Set();
    for (const t of validTracks) {
      if (isFreshLoad || prevSelected.has(t.id) || toDecode.some((e) => e.track?.id === t.id)) {
        this.state.selectedTrackIds.add(t.id);
      }
    }

    this.renderTrackList(excludedUnmastered);
    if (!bypassMasterToast && toDecode.length > 0 && validTracks.length > 0) {
      this.showToast(`Ready: ${validTracks.length} track${validTracks.length > 1 ? 's' : ''} analyzed.`);
    }
  },

  async decodeAndAnalyzeFile(ctx, file, localMeta = null) {
    const arrayBuf = await file.arrayBuffer();
    const fullBuffer = await decodeAudioDataSafe(ctx, arrayBuf);

    const channels = [];
    for (let c = 0; c < fullBuffer.numberOfChannels; c++) {
      channels.push(fullBuffer.getChannelData(c));
    }

    const duration = fullBuffer.duration;
    const fullPeaks = computeWaveformPeaks(channels, 180);
    const loudest = findLoudestWindow(channels, fullBuffer.sampleRate, this.state.previewDuration);

    const { clipStart, clipDuration } = this.computeClipWindow(duration, loudest.startTime);
    const sliced = sliceAudioBuffer(ctx, fullBuffer, clipStart, clipDuration);
    const metrics = analyzeAudioBuffer(sliced);
    const sliceChannels = [];
    for (let c = 0; c < sliced.numberOfChannels; c++) {
      sliceChannels.push(sliced.getChannelData(c));
    }
    const slicePeaks = computeWaveformPeaks(sliceChannels, 120);

    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    const srKhz = `${(fullBuffer.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;
    const chStr = fullBuffer.numberOfChannels === 2
      ? 'Stereo'
      : fullBuffer.numberOfChannels === 1
        ? 'Mono'
        : `${fullBuffer.numberOfChannels}ch`;
    const ext = (file.name.split('.').pop() || 'AUDIO').toUpperCase();
    const formatDesc = localMeta?.format_desc || `${ext} ${srKhz} ${chStr}`;

    // NOTE: fullBuffer is intentionally NOT stored to prevent multi-GB RAM bloat on large WAV batches.
    return {
      id: `trk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      localId: localMeta?.id || null,
      filename: file.name,
      duration,
      sampleRate: fullBuffer.sampleRate,
      channels: fullBuffer.numberOfChannels,
      formatDesc,
      sizeMb,
      file,
      fullPeaks,
      loudestStart: loudest.startTime,
      clipStart,
      clipDuration,
      slicedBuffer: sliced,
      slicePeaks,
      lufs: metrics.lufs,
      rmsDb: metrics.rmsDb,
      samplePeakDb: metrics.samplePeakDb,
      crestDb: metrics.crestDb,
    };
  },

  computeClipWindow(trackDuration, loudestStart = 0) {
    const clipDuration = Math.min(this.state.previewDuration, Math.max(0.5, trackDuration));
    const maxStart = Math.max(0, trackDuration - clipDuration);
    let clipStart = 0;

    if (this.state.regionMode === 'midpoint') {
      clipStart = Math.max(0, Math.min(maxStart, trackDuration / 2 - clipDuration / 2));
    } else if (this.state.regionMode === 'loudest') {
      clipStart = Math.max(0, Math.min(maxStart, loudestStart));
    } else if (this.state.regionMode === 'intro') {
      clipStart = 0;
    } else if (this.state.regionMode === 'outro') {
      clipStart = maxStart;
    } else if (this.state.regionMode === 'custom') {
      clipStart = Math.max(0, Math.min(maxStart, this.state.customStartRatio * trackDuration));
    }

    return { clipStart, clipDuration };
  },

  async resliceAllTracks() {
    if (this.state.tracks.length === 0) return;
    audio.stopAudition();
    const ctx = audio.ensureContext();
    this.showProgress(0, 'Updating loop window...');

    for (let i = 0; i < this.state.tracks.length; i++) {
      const track = this.state.tracks[i];
      const pct = Math.round(((i + 1) / this.state.tracks.length) * 100);
      this.showProgress(pct, `Slicing ${this.state.pureBlind ? `Track #${i + 1}` : track.filename}...`);

      try {
        const arrayBuf = await track.file.arrayBuffer();
        const fullBuffer = await decodeAudioDataSafe(ctx, arrayBuf);
        if (this.state.regionMode === 'loudest') {
          const channels = [];
          for (let c = 0; c < fullBuffer.numberOfChannels; c++) {
            channels.push(fullBuffer.getChannelData(c));
          }
          track.loudestStart = findLoudestWindow(channels, fullBuffer.sampleRate, this.state.previewDuration).startTime;
        }
        const { clipStart, clipDuration } = this.computeClipWindow(track.duration, track.loudestStart);
        const sliced = sliceAudioBuffer(ctx, fullBuffer, clipStart, clipDuration);
        const metrics = analyzeAudioBuffer(sliced);
        const sliceChannels = [];
        for (let c = 0; c < sliced.numberOfChannels; c++) {
          sliceChannels.push(sliced.getChannelData(c));
        }

        track.clipStart = clipStart;
        track.clipDuration = clipDuration;
        track.slicedBuffer = sliced;
        track.slicePeaks = computeWaveformPeaks(sliceChannels, 120);
        track.lufs = metrics.lufs;
        track.rmsDb = metrics.rmsDb;
        track.samplePeakDb = metrics.samplePeakDb;
        track.crestDb = metrics.crestDb;
      } catch (err) {
        console.error('Reslice error:', err);
      }
    }

    this.hideProgress();
    this.renderTrackList();
  },

  getReferenceTrack() {
    const selected = this.state.tracks.find((t) => this.state.selectedTrackIds.has(t.id));
    return selected || this.state.tracks[0] || null;
  },

  renderTrackList(excludedUnmastered = 0) {
    const allTracks = this.state.tracks;
    const hasTracks = allTracks.length > 0;

    this.els.scanResults.classList.toggle('hidden', !hasTracks);
    this.els.btnHeaderNew.classList.toggle('hidden', !hasTracks && this.state.activePanel === 'scan');

    if (!hasTracks) {
      return;
    }

    const q = this.state.searchQuery.trim().toLowerCase();
    const visibleTracks = q
      ? allTracks.filter((t) => t.filename.toLowerCase().includes(q))
      : allTracks;

    this.els.resultsCountText.textContent = `${allTracks.length} Track${allTracks.length === 1 ? '' : 's'} Ready`;
    let sub = `${this.state.selectedTrackIds.size} selected for shootout.`;
    if (excludedUnmastered > 0) {
      sub += ` (${excludedUnmastered} UNMASTERED file${excludedUnmastered > 1 ? 's' : ''} excluded.)`;
    }
    this.els.resultsSubText.textContent = sub;

    const body = this.els.trackListBody;
    body.innerHTML = '';

    visibleTracks.forEach((track, idx) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.setAttribute('role', 'listitem');

      const displayName = this.state.pureBlind ? `Blinded Track #${idx + 1}` : track.filename;
      const displayFmt = this.state.pureBlind ? 'HIDDEN' : track.formatDesc;
      const displaySize = this.state.pureBlind ? '—' : `${track.sizeMb} MB`;

      // Checkbox column
      const colCheck = document.createElement('div');
      colCheck.className = 'col-check';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = this.state.selectedTrackIds.has(track.id);
      chk.setAttribute('aria-label', `Select ${displayName}`);
      chk.addEventListener('change', (e) => {
        if (e.target.checked) this.state.selectedTrackIds.add(track.id);
        else this.state.selectedTrackIds.delete(track.id);
        this.updateStartButtonState();
        this.drawSetupWaveform();
      });
      colCheck.appendChild(chk);

      // Name column (strictly textContent — XSS safe)
      const colName = document.createElement('div');
      colName.className = 'col-name track-name-cell text-truncate';
      colName.title = displayName;
      colName.textContent = displayName;

      // Format column
      const colFmt = document.createElement('div');
      colFmt.className = 'col-fmt';
      const badge = document.createElement('span');
      badge.className = 'track-badge';
      badge.textContent = displayFmt;
      colFmt.appendChild(badge);

      // Duration column
      const colDur = document.createElement('div');
      colDur.className = 'col-dur mono-cell';
      colDur.textContent = formatTime(track.duration);

      // Loop window column (properly handles minute rollover!)
      const colMid = document.createElement('div');
      colMid.className = 'col-mid mono-cell';
      colMid.textContent = formatTimeRange(track.clipStart, track.clipDuration);

      // Size column
      const colSize = document.createElement('div');
      colSize.className = 'col-size mono-cell';
      colSize.textContent = displaySize;

      // Action column (Preview + Remove)
      const colAction = document.createElement('div');
      colAction.className = 'col-action';
      const btnPrev = document.createElement('button');
      btnPrev.type = 'button';
      btnPrev.className = 'sg-btn sg-btn-outline sg-btn-sm';
      btnPrev.textContent = '▶ Preview';
      btnPrev.setAttribute('aria-pressed', 'false');
      btnPrev.addEventListener('click', () => audio.previewBuffer(track.slicedBuffer, btnPrev));

      const btnRem = document.createElement('button');
      btnRem.type = 'button';
      btnRem.className = 'btn-remove-track';
      btnRem.title = 'Remove track';
      btnRem.setAttribute('aria-label', `Remove ${displayName}`);
      btnRem.textContent = '×';
      btnRem.addEventListener('click', () => this.removeTrack(track.id));

      colAction.appendChild(btnPrev);
      colAction.appendChild(btnRem);

      row.append(colCheck, colName, colFmt, colDur, colMid, colSize, colAction);
      body.appendChild(row);
    });

    const allChecked = visibleTracks.length > 0 && visibleTracks.every((t) => this.state.selectedTrackIds.has(t.id));
    this.els.btnToggleAll.textContent = allChecked ? 'Deselect All' : 'Select All';

    this.updateStartButtonState();
    this.drawSetupWaveform();
  },

  removeTrack(trackId) {
    audio.stopAudition();
    this.state.tracks = this.state.tracks.filter((t) => t.id !== trackId);
    this.state.allFileEntries = this.state.allFileEntries.filter((e) => e.track?.id !== trackId);
    this.state.selectedTrackIds.delete(trackId);
    this.renderTrackList();
  },

  toggleAllVisibleTracks() {
    const q = this.state.searchQuery.trim().toLowerCase();
    const visible = q
      ? this.state.tracks.filter((t) => t.filename.toLowerCase().includes(q))
      : this.state.tracks;
    const allChecked = visible.every((t) => this.state.selectedTrackIds.has(t.id));
    for (const t of visible) {
      if (allChecked) this.state.selectedTrackIds.delete(t.id);
      else this.state.selectedTrackIds.add(t.id);
    }
    this.renderTrackList();
  },

  clearAllTracks() {
    audio.stopAudition();
    this.state.allFileEntries = [];
    this.state.tracks = [];
    this.state.selectedTrackIds.clear();
    this.state.searchQuery = '';
    this.els.trackSearchInput.value = '';
    this.els.decodeErrorsBanner.classList.add('hidden');
    this.renderTrackList();
  },

  updateStartButtonState() {
    const count = this.state.selectedTrackIds.size;
    const mode = this.state.formatMode;
    let disabled = count < 2;
    let label = `Start Blind Shootout (${count})`;

    if (mode === 'abx') {
      disabled = count !== 2;
      label = count === 2 ? `Start ABX Test (${this.state.abxTrials} Trials)` : `Select Exactly 2 Tracks for ABX (${count} selected)`;
    } else if (count < 2) {
      label = 'Select At Least 2 Tracks';
    } else if (mode === 'round-robin') {
      label = `Start Round-Robin (${count} Tracks)`;
    }

    this.els.btnStartTournament.disabled = disabled;
    this.els.startBtnLabel.textContent = label;
    this.els.resultsSubText.textContent = `${count} of ${this.state.tracks.length} selected for shootout.`;
  },

  drawSetupWaveform() {
    const track = this.getReferenceTrack();
    if (!track || !this.els.setupWaveformCanvas) return;

    const canvas = this.els.setupWaveformCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Center rule
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const peaks = track.fullPeaks || [];
    if (peaks.length > 0) {
      const barW = w / peaks.length;
      ctx.fillStyle = '#8c8c8c';
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.max(2, peaks[i] * (h * 0.42));
        const x = i * barW;
        ctx.fillRect(x, h / 2 - amp, Math.max(1, barW - 1.5), amp * 2);
      }
    }

    this.els.setupWaveStart.textContent = '0:00';
    this.els.setupWaveEnd.textContent = formatTime(track.duration);
    this.updateSetupWaveformOverlay(track, track.clipStart, track.clipDuration);
  },

  updateSetupWaveformOverlay(track, startSec, clipDur) {
    if (!track || track.duration <= 0) return;
    const leftPct = (startSec / track.duration) * 100;
    const widthPct = Math.min(100 - leftPct, (clipDur / track.duration) * 100);
    this.els.setupWindowBox.style.left = `${leftPct}%`;
    this.els.setupWindowBox.style.width = `${Math.max(2, widthPct)}%`;
    this.els.setupWindowLabel.textContent = formatTimeRange(startSec, clipDur);
  },

  /* ========================================================================
     Phase II: Blind Shootout Arena (Fragment Deck)
     ======================================================================== */

  startTournament() {
    audio.stopAudition();
    const selected = this.state.tracks.filter((t) => this.state.selectedTrackIds.has(t.id));

    try {
      tournament.start(selected, {
        mode: this.state.formatMode,
        abxTrials: this.state.abxTrials,
        previewDuration: this.state.previewDuration,
        regionMode: this.state.regionMode,
        lufsMatch: this.els.toggleLufsMatch.checked,
        pureBlind: this.state.pureBlind,
      });
    } catch (err) {
      this.showToast(err.message, true);
      return;
    }

    audio.autoLufsMatch = this.els.toggleLufsMatch.checked;
    audio.autoFlipEnabled = false;
    this.els.btnAutoFlip.classList.remove('deck-pill-active');
    this.els.btnAutoFlip.setAttribute('aria-pressed', 'false');
    this.setMonitorMode('stereo');
    this.switchPanel('arena');
    this.renderCurrentMatch();
  },

  renderCurrentMatch() {
    const match = tournament.getCurrentMatch();
    if (!match) return;

    const isAbx = match.mode === 'abx';
    const modeLabelMap = {
      koth: 'KING OF THE HILL',
      'round-robin': 'ROUND-ROBIN · RANKED',
      abx: 'ABX STATISTICAL TEST',
    };

    this.els.arenaMatchBadge.textContent = isAbx
      ? `TRIAL ${match.matchNumber} OF ${match.totalMatches}`
      : `MATCH ${match.matchNumber} OF ${match.totalMatches}`;
    this.els.arenaStageTitle.textContent = match.stageTitle;
    this.els.deckModeReadout.textContent = modeLabelMap[match.mode] || '';
    this.els.btnUndoVote.disabled = !match.canUndo;

    // Progress dots
    this.els.arenaLadderProgress.innerHTML = '';
    for (let i = 1; i <= match.totalMatches; i++) {
      const dot = document.createElement('span');
      dot.className = 'ladder-dot';
      if (i < match.matchNumber) dot.classList.add('done');
      else if (i === match.matchNumber) dot.classList.add('current');
      this.els.arenaLadderProgress.appendChild(dot);
    }

    // Standard vs ABX labeling
    this.els.labelCandA.textContent = isAbx ? 'REFERENCE A' : 'OPTION I';
    this.els.labelCandB.textContent = isAbx ? 'REFERENCE B' : 'OPTION II';
    this.els.emblemCandA.textContent = isAbx ? 'A' : 'I';
    this.els.emblemCandB.textContent = isAbx ? 'B' : 'II';
    this.els.listenLabelA.textContent = isAbx ? 'A' : 'Option I';
    this.els.listenLabelB.textContent = isAbx ? 'B' : 'Option II';
    this.els.voteLabelA.textContent = isAbx ? 'X Matches A' : 'Pick Option I as Winner';
    this.els.voteLabelB.textContent = isAbx ? 'X Matches B' : 'Pick Option II as Winner';
    this.els.btnToggleToA.textContent = isAbx ? 'A' : 'I';
    this.els.btnToggleToB.textContent = isAbx ? 'B' : 'II';
    this.els.btnToggleToX.classList.toggle('hidden', !isAbx);
    this.els.abxMysteryBox.classList.toggle('hidden', !isAbx);
    this.els.centerVsSeal.classList.toggle('hidden', isAbx);
    this.els.shortcutXHint.classList.toggle('hidden', !isAbx);
    this.els.notesDrawerA.classList.toggle('hidden', isAbx);
    this.els.notesDrawerB.classList.toggle('hidden', isAbx);

    // Sync blind notes for randomized A/B sides without leaking identity
    this.syncNotesDrawerUI('A', match.notesA);
    this.syncNotesDrawerUI('B', match.notesB);

    // Load buffers into Web Audio Engine
    audio.setMatchBuffers(
      match.blindMap.A,
      match.blindMap.B,
      this.state.previewDuration,
      isAbx ? match.blindMap.X : null
    );

    // Reset alignment UI for new match
    this.els.alignOffsetSlider.value = '0';
    this.els.alignOffsetReadout.textContent = '0 ms';

    // Timeline total time & ARIA max
    this.els.timelineTotalTime.textContent = formatTime(audio.duration, true);
    this.els.timelineScrubber.setAttribute('aria-valuemax', String(Math.round(audio.duration)));
    this.updatePlayheadVisuals(0, audio.duration);

    // Default active side (X in ABX so user hears mystery first, or Option I)
    audio.activeSide = isAbx ? 'X' : 'A';
    this.updateActiveSideUI(audio.activeSide);
    this.updatePlayPauseBtn(false);
    this.syncLufsButtonUI();
    this.drawArenaLoopWaveform();
    this.clearSpectrumCanvas();

    this.showToast(
      isAbx
        ? `Trial ${match.matchNumber} ready — press Space, then compare A (1), B (2), X (3).`
        : `Match ${match.matchNumber} ready — press Space to play, 1 / 2 to switch.`
    );
  },

  syncNotesDrawerUI(side, noteObj) {
    const textarea = side === 'A' ? this.els.noteInputA : this.els.noteInputB;
    const tagBox = side === 'A' ? this.els.tagsCandA : this.els.tagsCandB;
    textarea.value = noteObj?.text || '';
    const activeSet = new Set(noteObj?.tags || []);
    tagBox.querySelectorAll('.tag-chip').forEach((chip) => {
      chip.classList.toggle('active', activeSet.has(chip.dataset.tag));
    });
  },

  syncLufsButtonUI() {
    // Strictly NEVER reveal which option was attenuated during blind testing!
    const on = audio.autoLufsMatch;
    this.els.gainTrimDisplay.textContent = on ? 'LUFS: MATCHED' : 'LUFS: OFF';
    this.els.btnArenaLufs.classList.toggle('deck-pill-active', on);
    this.els.btnArenaLufs.setAttribute('aria-pressed', String(on));
  },

  toggleLufsLive() {
    audio.autoLufsMatch = !audio.autoLufsMatch;
    this.els.toggleLufsMatch.checked = audio.autoLufsMatch;
    audio.applyGains(false);
    this.syncLufsButtonUI();
    this.showToast(audio.autoLufsMatch ? 'LUFS loudness match enabled.' : 'LUFS loudness match bypassed.');
  },

  setMonitorMode(mode) {
    audio.ensureContext();
    audio.setMonitorMode(mode);
    this.els.monitorMatrixBtns.forEach((btn) => {
      const active = btn.dataset.monitor === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const labels = {
      stereo: 'STEREO · 48-BAND FFT',
      mono: 'MONO SUM (L+R) · 48-BAND FFT',
      side: 'SIDE DIFF (L−R) · 48-BAND FFT',
    };
    this.els.spectrumModeTag.textContent = labels[mode] || labels.stereo;
  },

  updateActiveSideUI(side) {
    const isA = side === 'A';
    const isB = side === 'B';
    const isX = side === 'X';
    this.els.cardCandA.classList.toggle('active-play', isA);
    this.els.cardCandB.classList.toggle('active-play', isB);
    this.els.abxMysteryBox.classList.toggle('active-play', isX);

    this.els.playingPillA.classList.toggle('visible', isA && audio.isPlaying);
    this.els.playingPillB.classList.toggle('visible', isB && audio.isPlaying);

    this.els.btnToggleToA.classList.toggle('active', isA);
    this.els.btnToggleToB.classList.toggle('active', isB);
    this.els.btnToggleToX.classList.toggle('active', isX);
  },

  async togglePlayPause() {
    audio.ensureContext();
    if (audio.isPlaying) {
      audio.pause();
      this.updatePlayPauseBtn(false);
      this.updateActiveSideUI(audio.activeSide);
    } else {
      const started = await audio.play();
      this.updatePlayPauseBtn(started);
      this.updateActiveSideUI(audio.activeSide);
      if (started) this.startMeterLoop();
    }
  },

  async restartLoop() {
    audio.ensureContext();
    await audio.seek(0);
    if (!audio.isPlaying) await audio.play();
    this.updatePlayPauseBtn(audio.isPlaying);
    this.updateActiveSideUI(audio.activeSide);
    if (audio.isPlaying) this.startMeterLoop();
  },

  toggleAutoFlip() {
    audio.autoFlipEnabled = !audio.autoFlipEnabled;
    this.els.btnAutoFlip.classList.toggle('deck-pill-active', audio.autoFlipEnabled);
    this.els.btnAutoFlip.setAttribute('aria-pressed', String(audio.autoFlipEnabled));
    if (audio.autoFlipEnabled) {
      audio.scheduleAutoFlip();
      this.showToast(`Auto A/B enabled (flips every ${Math.round(audio.duration)}s).`);
    } else {
      clearTimeout(audio.autoFlipTimer);
      this.showToast('Auto A/B disabled.');
    }
  },

  updatePlayPauseBtn(playing) {
    this.els.playBtnGlyph.textContent = playing ? '❚❚' : '▶';
    this.els.playBtnText.textContent = playing ? 'Pause' : 'Play Loop';
    this.els.studioDeck.dataset.state = playing ? 'playing' : 'paused';
    this.els.deckStatePill.textContent = playing ? 'PLAYING' : 'STANDBY';
  },

  castVote(chosenSide) {
    audio.stop();
    this.updatePlayPauseBtn(false);

    let result;
    try {
      result = tournament.vote(chosenSide);
    } catch (err) {
      this.showToast(err.message, true);
      return;
    }

    if (result.completed) {
      this.state.lastSummary = result.summary;
      this.showVictoryScreen(result.summary);
    } else {
      const label = tournament.mode === 'abx'
        ? `Recorded: X = ${chosenSide}. Next trial.`
        : `Option ${chosenSide === 'A' ? 'I' : 'II'} selected — press Z to undo.`;
      this.showToast(label);
      this.renderCurrentMatch();
    }
  },

  undoVote() {
    if (!tournament.canUndo()) return;
    audio.stop();
    this.updatePlayPauseBtn(false);
    tournament.undo();
    this.renderCurrentMatch();
    this.showToast('Reverted previous vote.');
  },

  drawArenaLoopWaveform() {
    const match = tournament.getCurrentMatch();
    const canvas = this.els.arenaLoopWaveCanvas;
    if (!match || !canvas) return;
    const activeTrack = match.blindMap[audio.activeSide] || match.blindMap.A;
    const peaks = activeTrack?.slicePeaks || [];

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (peaks.length === 0) return;
    const barW = w / peaks.length;
    ctx.fillStyle = '#666666';
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(2, peaks[i] * (h * 0.44));
      ctx.fillRect(i * barW, h / 2 - amp, Math.max(1, barW - 1), amp * 2);
    }
  },

  updatePlayheadVisuals(curSec, totalSec) {
    const pct = totalSec > 0 ? Math.max(0, Math.min(100, (curSec / totalSec) * 100)) : 0;
    this.els.timelineProgressBar.style.width = `${pct}%`;
    this.els.timelinePlayhead.style.left = `${pct}%`;
    this.els.timelineCurrentTime.textContent = formatTime(curSec, true);
    this.els.timelineScrubber.setAttribute('aria-valuenow', curSec.toFixed(1));
  },

  /* ========================================================================
     On-Demand Zero-Idle Metering & Monochrome FFT Loop
     ======================================================================== */

  startMeterLoop() {
    if (this.rafId !== null) return;
    const canvas = this.els.visualizerCanvas;
    const ctx = canvas.getContext('2d');
    if (!this.spectrumGradient) {
      const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
      grad.addColorStop(0, '#555555');
      grad.addColorStop(0.65, '#cccccc');
      grad.addColorStop(1, '#ffffff');
      this.spectrumGradient = grad;
    }

    const tick = () => {
      if (this.state.activePanel !== 'arena') {
        this.rafId = null;
        return;
      }

      const m = audio.getMeterReadings();
      const targetL = dbToMeterPct(m.rmsLDb);
      const targetR = dbToMeterPct(m.rmsRDb);

      this.vuDecayL = Math.max(targetL, this.vuDecayL * 0.86);
      this.vuDecayR = Math.max(targetR, this.vuDecayR * 0.86);

      this.els.vuMeterL.style.height = `${this.vuDecayL.toFixed(1)}%`;
      this.els.vuMeterR.style.height = `${this.vuDecayR.toFixed(1)}%`;

      const peakPctL = dbToMeterPct(m.peakHoldLDb);
      const peakPctR = dbToMeterPct(m.peakHoldRDb);
      this.els.vuPeakL.style.bottom = `${Math.min(98, peakPctL).toFixed(1)}%`;
      this.els.vuPeakL.style.opacity = peakPctL > 1 ? '1' : '0';
      this.els.vuPeakR.style.bottom = `${Math.min(98, peakPctR).toFixed(1)}%`;
      this.els.vuPeakR.style.opacity = peakPctR > 1 ? '1' : '0';

      this.els.clipLedL.classList.toggle('clipping', m.clipL);
      this.els.clipLedR.classList.toggle('clipping', m.clipR);

      this.drawSpectrum(ctx, canvas.width, canvas.height, m.fftData);

      if (audio.bufferA) {
        this.updatePlayheadVisuals(audio.getCurrentPlayhead(), audio.duration);
      }

      // Stop animation loop automatically once paused and meters have settled to 0!
      if (!audio.isPlaying && this.vuDecayL < 0.3 && this.vuDecayR < 0.3 && peakPctL < 1 && peakPctR < 1) {
        this.vuDecayL = 0;
        this.vuDecayR = 0;
        this.els.vuMeterL.style.height = '0%';
        this.els.vuMeterR.style.height = '0%';
        this.els.vuPeakL.style.opacity = '0';
        this.els.vuPeakR.style.opacity = '0';
        this.clearSpectrumCanvas();
        this.rafId = null;
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  },

  drawSpectrum(ctx, width, height, fftData) {
    ctx.clearRect(0, 0, width, height);

    // Subtle monochrome hairline grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    for (let y = 18; y < height; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (!fftData) return;

    const numBars = 48;
    const gap = 2;
    const barW = (width - gap * (numBars - 1)) / numBars;
    ctx.fillStyle = this.spectrumGradient;

    for (let i = 0; i < numBars; i++) {
      const bin = Math.min(fftData.length - 1, Math.floor(Math.pow(i / numBars, 1.75) * fftData.length));
      const val = fftData[bin] || 0;
      const barH = (val / 255) * (height - 8);
      if (barH < 1) continue;
      const x = i * (barW + gap);
      ctx.fillRect(x, height - barH, barW, barH);
    }
  },

  clearSpectrumCanvas() {
    const canvas = this.els.visualizerCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    this.drawSpectrum(ctx, canvas.width, canvas.height, null);
  },

  /* ========================================================================
     Phase III: Verdict & Grand Reveal
     ======================================================================== */

  showVictoryScreen(summary) {
    this.switchPanel('victory');
    this.revokeWinnerBlobUrl();

    const isAbx = summary.mode === 'abx' && summary.abx;
    const winner = summary.winner;

    this.els.verdictFormatTag.textContent = `SAINT GORDON / ${summary.mode.toUpperCase()} VERDICT`;

    // Consistency badge (Round-Robin)
    if (summary.consistency) {
      const c = summary.consistency;
      this.els.verdictConsistencyBadge.textContent =
        `EAR CONSISTENCY: ${c.scorePct}% (${c.consistentCount}/${c.totalChecks} REMATCH)`;
      this.els.verdictConsistencyBadge.classList.remove('hidden');
    } else {
      this.els.verdictConsistencyBadge.classList.add('hidden');
    }

    if (isAbx) {
      const a = summary.abx;
      this.els.victoryBadge.textContent = a.significant ? '✳ STATISTICALLY SIGNIFICANT' : '✳ INDISTINGUISHABLE RESULT';
      this.els.victoryTitle.textContent = `${a.correct} / ${a.total} Correct.`;
      this.els.victorySubtitle.textContent = a.verdict;
      this.els.winnerFilename.textContent = `A: ${a.trackA.filename}  vs  B: ${a.trackB.filename}`;

      this.els.winnerSpecsRow.innerHTML = '';
      this.appendSpecPill(this.els.winnerSpecsRow, `A: ${formatLufs(a.trackA.lufs)}`);
      this.appendSpecPill(this.els.winnerSpecsRow, `B: ${formatLufs(a.trackB.lufs)}`);
      this.appendSpecPill(this.els.winnerSpecsRow, `p = ${a.pValue.toFixed(4)}`);

      this.els.abxVerdictBox.classList.remove('hidden');
      this.els.abxVerdictBox.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'abx-stat-grid';
      [
        ['ACCURACY', `${a.accuracyPct}%`],
        ['SCORE', `${a.correct} / ${a.total}`],
        ['BINOMIAL P-VALUE', `p = ${a.pValue.toFixed(4)}`],
        ['SIGNIFICANCE (α=0.05)', a.significant ? 'YES' : 'NO'],
      ].forEach(([label, val]) => {
        const box = document.createElement('div');
        box.className = 'abx-stat';
        const span = document.createElement('span');
        span.className = 'micro';
        span.textContent = label;
        const strong = document.createElement('strong');
        strong.textContent = val;
        box.append(span, strong);
        grid.appendChild(box);
      });
      this.els.abxVerdictBox.appendChild(grid);

      this.els.rankingsCard.classList.add('hidden');
      this.els.winnerPlayerWrap.classList.add('hidden');
      this.els.btnDownloadWinner.classList.add('hidden');
      this.els.btnCopyWinnerName.classList.add('hidden');
      this.els.btnRevealFinder.classList.add('hidden');

      // Render ABX Trial Log
      this.els.historyCardTitle.textContent = 'Trial-by-Trial ABX Log';
      this.els.tournamentHistoryList.innerHTML = '';
      for (const t of a.trials) {
        const item = document.createElement('div');
        item.className = 'history-item';

        const badge = document.createElement('span');
        badge.className = 'history-match-badge';
        badge.textContent = `TRIAL ${t.trialNumber}`;

        const duel = document.createElement('div');
        duel.className = 'history-duel';

        const actual = document.createElement('span');
        actual.textContent = `Actual X: ${t.actualX} (${t.actualFilename})`;
        const picked = document.createElement('span');
        picked.className = 'micro';
        picked.textContent = `Picked ${t.guessed} · ${t.correct ? 'CORRECT' : 'MISS'}`;

        duel.append(actual, picked);
        item.append(badge, duel);
        this.els.tournamentHistoryList.appendChild(item);
      }
    } else if (winner) {
      this.els.abxVerdictBox.classList.add('hidden');
      this.els.rankingsCard.classList.remove('hidden');
      this.els.winnerPlayerWrap.classList.remove('hidden');
      this.els.btnDownloadWinner.classList.remove('hidden');
      this.els.btnCopyWinnerName.classList.remove('hidden');
      this.els.btnRevealFinder.classList.toggle('hidden', !winner.localId);

      this.els.victoryBadge.textContent = '✳ UNDISPUTED CHAMPION';
      this.els.victoryTitle.textContent = 'Winner Crowned.';
      this.els.victorySubtitle.textContent = 'The blind seal is broken. Here is the master chosen strictly by ear:';
      this.els.winnerFilename.textContent = winner.filename;

      this.els.winnerSpecsRow.innerHTML = '';
      this.appendSpecPill(this.els.winnerSpecsRow, winner.formatDesc);
      this.appendSpecPill(this.els.winnerSpecsRow, `${formatTime(winner.duration)} full`);
      this.appendSpecPill(this.els.winnerSpecsRow, `${winner.sizeMb} MB`);
      this.appendSpecPill(this.els.winnerSpecsRow, formatLufs(winner.lufs));
      this.appendSpecPill(this.els.winnerSpecsRow, `Peak ${formatDb(winner.samplePeakDb)} dBFS`);
      this.appendSpecPill(this.els.winnerSpecsRow, `Crest ${formatDb(winner.crestDb)} dB`);

      // Full track player & download (safely tracked for revocation)
      const blobUrl = URL.createObjectURL(winner.file);
      this.state.activeWinnerBlobUrl = blobUrl;
      this.els.winnerAudioPlayer.src = blobUrl;
      this.els.btnDownloadWinner.href = blobUrl;
      this.els.btnDownloadWinner.download = winner.filename;

      // Render Full Rankings Table (XSS-safe textContent)
      this.els.rankingsTableBody.innerHTML = '';
      for (const r of summary.rankings) {
        const t = r.track;
        const item = document.createElement('div');
        item.className = `ranking-item${r.rank === 1 ? ' rank-first' : ''}`;

        const rankEl = document.createElement('div');
        rankEl.className = 'rank-num';
        rankEl.textContent = `#${r.rank}`;

        const mainEl = document.createElement('div');
        const nameEl = document.createElement('div');
        nameEl.className = 'ranking-name';
        nameEl.textContent = t.filename;

        const metricsEl = document.createElement('div');
        metricsEl.className = 'ranking-metrics';
        [
          t.formatDesc,
          formatLufs(t.lufs),
          `Peak ${formatDb(t.samplePeakDb)} dBFS`,
          `Crest ${formatDb(t.crestDb)} dB`,
        ].forEach((txt) => {
          const pill = document.createElement('span');
          pill.className = 'ranking-pill';
          pill.textContent = txt;
          metricsEl.appendChild(pill);
        });

        mainEl.append(nameEl, metricsEl);

        const noteParts = [];
        if (r.notes?.tags?.length) noteParts.push(r.notes.tags.join(' · '));
        if (r.notes?.text?.trim()) noteParts.push(`“${r.notes.text.trim()}”`);
        if (noteParts.length > 0) {
          const noteEl = document.createElement('div');
          noteEl.className = 'ranking-notes';
          noteEl.textContent = `Blind notes: ${noteParts.join(' — ')}`;
          mainEl.appendChild(noteEl);
        }

        const recEl = document.createElement('div');
        recEl.className = 'ranking-record';
        recEl.textContent = `${r.wins}W – ${r.losses}L · ELO ${r.elo}`;

        item.append(rankEl, mainEl, recEl);
        this.els.rankingsTableBody.appendChild(item);
      }

      // Render Round-by-Round Match History (XSS-safe)
      this.els.historyCardTitle.textContent = 'Round-by-Round Matchup History';
      this.els.tournamentHistoryList.innerHTML = '';
      for (const m of summary.history) {
        const item = document.createElement('div');
        item.className = 'history-item';

        const badge = document.createElement('span');
        badge.className = 'history-match-badge';
        badge.textContent = m.isConsistencyCheck
          ? `MATCH ${m.matchNumber} · CONSISTENCY`
          : `MATCH ${m.matchNumber}`;

        const duel = document.createElement('div');
        duel.className = 'history-duel';

        const winEl = document.createElement('span');
        winEl.className = 'history-winner';
        winEl.textContent = m.winnerFilename;

        const vsEl = document.createElement('span');
        vsEl.className = 'micro';
        vsEl.textContent = 'DEFEATED';

        const loseEl = document.createElement('span');
        loseEl.className = 'history-loser';
        loseEl.textContent = m.loserFilename;

        duel.append(winEl, vsEl, loseEl);
        item.append(badge, duel);
        this.els.tournamentHistoryList.appendChild(item);
      }
    }

    launchMonochromeSparks();
  },

  appendSpecPill(container, text) {
    const pill = document.createElement('span');
    pill.className = 'spec-pill';
    pill.textContent = text;
    container.appendChild(pill);
  },

  revokeWinnerBlobUrl() {
    if (this.state.activeWinnerBlobUrl) {
      URL.revokeObjectURL(this.state.activeWinnerBlobUrl);
      this.state.activeWinnerBlobUrl = null;
    }
  },

  /* ========================================================================
     Panel Switching & UI Helpers
     ======================================================================== */

  switchPanel(panelName) {
    audio.stop();
    audio.stopAudition();
    this.updatePlayPauseBtn(false);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.els.toastContainer) {
      this.els.toastContainer.innerHTML = '';
    }

    this.state.activePanel = panelName;
    this.els.phaseScan.classList.toggle('active', panelName === 'scan');
    this.els.phaseArena.classList.toggle('active', panelName === 'arena');
    this.els.phaseVictory.classList.toggle('active', panelName === 'victory');

    this.els.phaseSteps.forEach((step) => {
      step.classList.toggle('active', step.dataset.step === panelName);
    });

    const showNewBtn = panelName !== 'scan' || this.state.tracks.length > 0;
    this.els.btnHeaderNew.classList.toggle('hidden', !showNewBtn);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  showProgress(pct, text) {
    this.els.decodeProgressContainer.classList.remove('hidden');
    this.els.decodeProgressText.textContent = text;
    this.els.decodeProgressPct.textContent = `${pct}%`;
    this.els.decodeProgressBar.style.width = `${pct}%`;
  },

  hideProgress() {
    this.els.decodeProgressContainer.classList.add('hidden');
  },

  showDecodeErrors(errors) {
    this.els.decodeErrorsTitle.textContent = `${errors.length} file${errors.length > 1 ? 's' : ''} could not be decoded`;
    this.els.decodeErrorsList.innerHTML = '';
    for (const msg of errors) {
      const li = document.createElement('li');
      li.textContent = msg;
      this.els.decodeErrorsList.appendChild(li);
    }
    this.els.decodeErrorsBanner.classList.remove('hidden');
  },

  showToast(message, isError = false) {
    const container = this.els.toastContainer;
    while (container.children.length >= 2) {
      container.firstElementChild.remove();
    }
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' toast-error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 260);
    }, 2400);
  },
};

/* ==========================================================================
   Utility Helpers
   ========================================================================== */

function dbToMeterPct(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;
  return ((db + 60) / 60) * 100;
}

function formatLufs(val) {
  return Number.isFinite(val) ? `${val.toFixed(1)} LUFS` : '— LUFS';
}

function formatDb(val) {
  return Number.isFinite(val) ? val.toFixed(1) : '—';
}

async function copyTextSafe(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copy failed');
}

function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Recursively extract dropped files including nested directories via webkitGetAsEntry.
 */
async function extractDroppedFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const hasEntries = items.some((item) => typeof item.webkitGetAsEntry === 'function');

  if (!hasEntries) {
    return dataTransfer.files ? Array.from(dataTransfer.files) : [];
  }

  const collected = [];
  const walkEntry = (entry, depth = 0) =>
    new Promise((resolve) => {
      if (!entry || depth > 4) {
        resolve();
        return;
      }
      if (entry.isFile) {
        entry.file(
          (file) => {
            collected.push(file);
            resolve();
          },
          () => resolve()
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(
            async (entries) => {
              if (!entries.length) {
                resolve();
                return;
              }
              for (const child of entries) {
                await walkEntry(child, depth + 1);
              }
              readAll();
            },
            () => resolve()
          );
        };
        readAll();
      } else {
        resolve();
      }
    });

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walkEntry(entry, 0);
  }
  return collected;
}

/**
 * Minimal monochrome print-spark celebration respecting prefers-reduced-motion.
 */
function launchMonochromeSparks() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const shades = ['#101010', '#303030', '#777777', '#cccccc', '#ffffff'];
  const particles = Array.from({ length: 84 }, () => ({
    x: canvas.width / 2,
    y: canvas.height * 0.28,
    vx: (Math.random() - 0.5) * 16,
    vy: (Math.random() - 0.72) * 15,
    w: Math.random() * 8 + 4,
    h: Math.random() * 4 + 2,
    color: shades[Math.floor(Math.random() * shades.length)],
    rot: Math.random() * Math.PI * 2,
    vRot: (Math.random() - 0.5) * 0.2,
    alpha: 1,
  }));

  const frame = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.32;
      p.rot += p.vRot;
      p.alpha -= 0.01;
      if (p.alpha > 0) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    if (alive) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  requestAnimationFrame(frame);
}

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
