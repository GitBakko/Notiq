import { useUIStore } from '../store/uiStore';

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (!audioContext) {
    try {
      audioContext = new AudioContext();
    } catch {
      console.warn('Web Audio API is not supported');
      return null;
    }
  }
  return audioContext;
}

export function playNotificationSound(): void {
  if (!useUIStore.getState().notificationSoundEnabled) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Tone 1: C5 (523.25 Hz), 150ms with exponential fade
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.value = 523.25;
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    // Tone 2: E5 (659.25 Hz), starts at +100ms, 200ms with fade
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 659.25;
    gain2.gain.setValueAtTime(0.3, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.3);
  } catch (err) {
    console.warn('Failed to play notification sound', err);
  }
}
