/**
 * Web Audio API-based siren alarm.
 * No external audio files needed — works offline and is instant.
 */

let audioCtx: AudioContext | null = null;
let sirenTimeout: ReturnType<typeof setTimeout> | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Play a rising-falling siren sweep for `cycles` repetitions.
 * Each cycle sweeps from `lowHz` → `highHz` → `lowHz`.
 */
export function playSiren(cycles = 3, lowHz = 400, highHz = 900, cycleDurationMs = 600) {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const totalDuration = cycles * cycleDurationMs / 1000;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(lowHz, ctx.currentTime);

    // Schedule sweep cycles
    for (let i = 0; i < cycles; i++) {
      const cycleStart = ctx.currentTime + (i * cycleDurationMs) / 1000;
      const cycleMid = cycleStart + cycleDurationMs / 2000;
      const cycleEnd = cycleStart + cycleDurationMs / 1000;

      oscillator.frequency.linearRampToValueAtTime(highHz, cycleMid);
      oscillator.frequency.linearRampToValueAtTime(lowHz, cycleEnd);
    }

    // Envelope: fade in, hold, fade out
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.15, ctx.currentTime + totalDuration - 0.1);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + totalDuration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + totalDuration);
  } catch {
    // Audio may be blocked by browser autoplay policy — fail silently
  }
}

/**
 * Play siren with debounce — won't re-trigger if already playing.
 */
export function playSirenDebounced(cooldownMs = 4000) {
  if (sirenTimeout) return;
  playSiren();
  sirenTimeout = setTimeout(() => {
    sirenTimeout = null;
  }, cooldownMs);
}
