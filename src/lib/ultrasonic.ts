// Near-ultrasonic acoustic room-code transport (Web Audio API).
//
// Encodes the 6-digit room code as a short FSK (frequency-shift-keying) burst
// in the ~18.0–19.0 kHz band — above most adult hearing, audible to standard
// device microphones. Lets a guest "Listen and Join" the singer's iPad room
// without typing the code.
//
// ── HONEST SCOPE ──────────────────────────────────────────────────────────
// This is BEST-EFFORT, not a guaranteed channel. Acoustic data depends on
// proximity, volume, and ambient noise; ~18 kHz also sits at the edge of small
// speakers' output and of younger ears (some people DO faintly hear it). Use
// the QR code as the reliable path; this is the "tap and it just works" bonus
// for a quiet-ish stage at close range. iOS Safari needs a user gesture to open
// the AudioContext / mic (the buttons provide it) and HTTPS for getUserMedia.
//
// ── PROTOCOL ──────────────────────────────────────────────────────────────
// Symbols (each a steady sine burst SYMBOL_MS long, separated by GAP_MS of
// silence so REPEATED digits stay distinct — "112233" decodes as six bursts):
//   START  = 18000 Hz
//   digit d= 18150 + d*75 Hz   (0→18150 … 9→18825)
//   END    = 18975 Hz
// Frame: [START, d0,d1,d2,d3,d4,d5, END], looped continuously while broadcasting
// so a listener that starts mid-frame still catches a full one within ~2 cycles.
// The receiver bins the mic spectrum, segments tone-bursts from silence, maps
// each burst's dominant frequency to the nearest symbol, and reads the first
// well-formed START·6digits·END sequence.

const START_FREQ = 18000;
const END_FREQ = 18975;
const DIGIT_BASE = 18150;
const DIGIT_STEP = 75;
const TOL_HZ = 37; // half the step — nearest-symbol match window

const SYMBOL_MS = 160; // tone burst length
const GAP_MS = 60; // silence between bursts (also separates repeated digits)
const VOLUME = 0.2; // modest — high freqs distort / become audible if too hot

const BAND_LOW = START_FREQ - 60;
const BAND_HIGH = END_FREQ + 60;

const digitFreq = (d: number) => DIGIT_BASE + d * DIGIT_STEP;

/** Symbol → carrier frequency. 'S'=start, 'E'=end, '0'..'9'=digits. */
const SYMBOL_FREQS: ReadonlyArray<{ sym: string; freq: number }> = [
  { sym: "S", freq: START_FREQ },
  ...Array.from({ length: 10 }, (_, d) => ({ sym: String(d), freq: digitFreq(d) })),
  { sym: "E", freq: END_FREQ },
];

function getAudioContext(): AudioContext {
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API not supported");
  return new Ctor();
}

export function ultrasonicSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window.AudioContext ||
      (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

// ── Transmitter ────────────────────────────────────────────────────────────

export interface Broadcast {
  /** Stop transmitting and release the audio context. */
  stop: () => void;
  /** Resolves when the broadcast ends (max duration reached or stop() called). */
  done: Promise<void>;
}

/**
 * Broadcast the 6-digit `code` as a looped near-ultrasonic FSK burst. Runs for
 * up to `maxDurationMs` (default 15 s) or until `.stop()`. Returns immediately
 * with a handle. Must be called from a user gesture (iOS AudioContext policy).
 */
export function broadcastRoomCode(code: string, maxDurationMs = 15_000): Broadcast {
  if (!/^\d{6}$/.test(code)) throw new Error("room code must be 6 digits");
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  osc.type = "sine";
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);

  const symbols = ["S", ...code.split(""), "E"];
  const ATTACK = 0.006; // s — ramp the burst edges to kill clicks
  const onSec = SYMBOL_MS / 1000;
  const periodSec = (SYMBOL_MS + GAP_MS) / 1000;

  void ctx.resume();
  osc.start();

  // Schedule whole frames back-to-back until we've filled maxDurationMs.
  let t = ctx.currentTime + 0.06;
  const endBy = ctx.currentTime + maxDurationMs / 1000;
  while (t < endBy) {
    for (const sym of symbols) {
      const f = SYMBOL_FREQS.find((s) => s.sym === sym)!.freq;
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOLUME, t + ATTACK);
      gain.gain.setValueAtTime(VOLUME, t + onSec - ATTACK);
      gain.gain.linearRampToValueAtTime(0, t + onSec);
      t += periodSec;
    }
  }

  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      osc.stop(ctx.currentTime + 0.02);
    } catch {
      /* already stopped */
    }
    osc.onended = null;
    void ctx.close().catch(() => {});
    resolveDone();
  };
  const timer = window.setTimeout(cleanup, maxDurationMs + 100);
  return {
    stop: () => {
      window.clearTimeout(timer);
      cleanup();
    },
    done,
  };
}

// ── Receiver ─────────────────────────────────────────────────────────────

function nearestSymbol(freq: number): string | null {
  let best: string | null = null;
  let bestDiff = TOL_HZ;
  for (const { sym, freq: f } of SYMBOL_FREQS) {
    const d = Math.abs(freq - f);
    if (d <= bestDiff) {
      bestDiff = d;
      best = sym;
    }
  }
  return best;
}

// Pull the first well-formed START·(6 digits)·END out of an ordered burst list.
function decodeBursts(bursts: string[]): string | null {
  for (let i = 0; i < bursts.length; i++) {
    if (bursts[i] !== "S") continue;
    const digits: string[] = [];
    for (let j = i + 1; j < bursts.length; j++) {
      const b = bursts[j];
      if (b === "E") {
        return digits.length === 6 ? digits.join("") : null;
      }
      if (b === "S") break; // new frame started — abandon this one
      if (!/^\d$/.test(b)) break;
      digits.push(b);
      if (digits.length > 6) break;
    }
  }
  return null;
}

export interface ListenOptions {
  timeoutMs?: number;
  /** Called once with the live MediaStream so the UI can show a "listening" state. */
  signal?: AbortSignal;
}

/**
 * Listen on the microphone for a broadcast room code. Resolves with the decoded
 * 6-digit code, or null on timeout / no signal. Must be called from a user
 * gesture (mic permission + AudioContext). Cleans up the stream + context.
 */
export async function listenForRoomCode({
  timeoutMs = 4000,
  signal,
}: ListenOptions = {}): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // High-frequency data dies under these DSP stages — turn them off.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const ctx = getAudioContext();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const bins = new Float32Array(analyser.frequencyBinCount);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const lowBin = Math.max(0, Math.floor(BAND_LOW / binHz));
  const highBin = Math.min(bins.length - 1, Math.ceil(BAND_HIGH / binHz));

  const bursts: string[] = [];
  // Frames of the in-progress burst (one symbol guess per polled frame); a run
  // of silence closes the burst and pushes its majority symbol.
  let runSym: string | null = null;
  let runFrames = 0;
  let silence = 0;

  const closeBurst = () => {
    if (runSym && runFrames >= 2) bursts.push(runSym); // ≥2 frames → ignore blips
    runSym = null;
    runFrames = 0;
  };

  return new Promise<string | null>((resolve) => {
    let finished = false;
    let raf = 0;
    let timer = 0;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
    };
    const finish = (code: string | null) => {
      cleanup();
      resolve(code);
    };

    signal?.addEventListener("abort", () => finish(null), { once: true });
    timer = window.setTimeout(() => finish(null), timeoutMs);

    const tick = () => {
      if (finished) return;
      analyser.getFloatFrequencyData(bins); // dBFS, negative

      // Peak + adaptive noise floor within the band.
      let peakBin = -1;
      let peakDb = -Infinity;
      let sum = 0;
      let n = 0;
      for (let b = lowBin; b <= highBin; b++) {
        sum += bins[b];
        n++;
        if (bins[b] > peakDb) {
          peakDb = bins[b];
          peakBin = b;
        }
      }
      const floorDb = n ? sum / n : -120;

      // A real tone: clearly above the in-band average and not pure hiss.
      const isTone = peakBin >= 0 && peakDb > floorDb + 14 && peakDb > -78;
      if (isTone) {
        const sym = nearestSymbol(peakBin * binHz);
        if (sym) {
          if (sym === runSym) runFrames++;
          else {
            closeBurst();
            runSym = sym;
            runFrames = 1;
          }
          silence = 0;
        }
      } else {
        // Two silent frames in a row = burst boundary.
        if (++silence >= 2 && runSym) {
          closeBurst();
          const code = decodeBursts(bursts);
          if (code) return finish(code);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
