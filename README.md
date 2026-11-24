# Master Clash — Saint Gordon Collective

> **Blind Mastering Shootout & A/B Console** — 100% client-side in your browser, built in the editorial monochrome studio style of [Saint Gordon Collective](https://saintgordon.vercel.app).

**Live App:** [https://saintgordon.github.io/master-clash/](https://saintgordon.github.io/master-clash/)

---

## What It Does

Drop a batch of master renders (or a whole folder) into your browser and judge them strictly by ear — with zero server uploads, true ITU-R BS.1770 K-weighted LUFS loudness matching, zero-latency clickless A/B switching, Stereo/Mono/Side monitoring, and full blind reveal reports.

### Core Capabilities

- **100% Client-Side & Private:** Audio is decoded and compared locally via the Web Audio API. Nothing leaves your machine.
- **Always-On Pure Blind Mode:** Filenames, formats, sample rates, file sizes, and upload order are sealed and randomized immediately on drop — nothing is revealed until the final Verdict.
- **ITU-R BS.1770 K-Weighted LUFS Loudness Matching:** Levels contenders by attenuating the louder track (preventing digital clipping) without leaking *which* option was trimmed during the blind shootout. Exact LUFS, sample peak (dBFS), and crest/dynamic range numbers are revealed only at the end.
- **Selectable Loop Region & Waveform Scrubber:** Compare the exact midpoint ($T/2$), auto-detect the **Loudest Chorus**, jump to Intro/Outro, or drag the loop window anywhere on the track waveform (10s / 15s / 20s / 30s), plus optional ±50 ms micro-alignment trim for WAV vs MP3/AAC encoder padding.
- **Three Blind Formats + Undo:**
  - **King of the Hill:** Fast elimination ladder with Undo (`Z`) so a stray keypress never kills a master.
  - **Round-Robin (Ranked + Consistency Check):** Full 1st–Nth rankings with W–L record, Elo rating, and a hidden verification rematch to measure your **Ear Consistency Score**.
  - **ABX Statistical Test:** Classic A / B / X trials (6, 8, 10, or 12 rounds) with exact one-tailed binomial $p$-value calculation.
- **Mastering Monitor Matrix & Real Stereo Metering:**
  - Instant clickless `STEREO` / `MONO (M)` / `SIDE (S)` auditioning.
  - True dual-channel Left/Right peak + RMS VU meters (`ChannelSplitterNode`) with clip indicator and 48-band monochrome FFT spectrum.
- **Blind Notes & Report Export:** Tag/write notes for Option I & Option II mid-round without knowing which file is which, and export a Markdown (`.md`) shootout report upon reveal.
- **Smart Master Filtering & Recursive Folder Drop:** Filters for `MASTER` / `MASTERED` while excluding `UNMASTERED`, supports live re-filtering, recursive drag-and-drop folders, and optional local CLI `ffmpeg` companion mode.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause synchronized loop |
| `1` | Instant switch to **Option I** (or **A** in ABX) |
| `2` | Instant switch to **Option II** (or **B** in ABX) |
| `3` | Instant switch to **Option X** (ABX mode) |
| `←` or `Shift + 1` | Pick **Option I** / **X is A** |
| `→` or `Shift + 2` | Pick **Option II** / **X is B** |
| `Z` | Undo last vote |
| `M` | Toggle **Mono Sum** monitor |
| `S` | Toggle **Side (L − R)** monitor |
| `L` | Toggle **LUFS Loudness Match** |
| `R` | Restart loop from `00:00.0` |

---

## Local CLI & Companion Server (Optional)

Need `ffmpeg`-backed transcoding (for AIFF/CAF/32-bit float WAVs on browsers without native decoders) or instant folder pre-loading from your terminal? Run the single-source local server:

```bash
# Launch the console locally
python3 master_ab.py

# Pre-load a folder of masters directly into the browser console
python3 master_ab.py ~/Music/Album_Masters

# Include all audio files (disable MASTER/MASTERED filename filter)
python3 master_ab.py --all-audio ~/Music/Mixes
```

*(macOS users can also double-click `MasterTournament.command`.)*

---

## Development & Tests

No build step required — pure static HTML, CSS, and ES modules served directly from the repository root.

```bash
# Run JavaScript DSP & Tournament unit tests (Node 20+)
node --test tests/*.test.mjs

# Run Python companion server unit tests
python3 -m unittest discover -s tests -p "test_*.py" -v
```

---

## Brand & License

- Built by **[Saint Gordon Collective](https://saintgordon.vercel.app)** — *Independent sound. Imperfect by design.*
- Code licensed under the [MIT License](LICENSE). Bundled display fonts follow the notes in [assets/fonts/ENGRAVERS-LICENSE-NOTES.md](assets/fonts/ENGRAVERS-LICENSE-NOTES.md) and [assets/fonts/OFL.txt](assets/fonts/OFL.txt).
