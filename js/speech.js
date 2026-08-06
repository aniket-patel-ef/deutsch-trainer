// Browser equivalents of audio/SpeechManager.kt and SpeechRecognizerController.kt.
// Both Web Speech APIs are optional: TTS is near-universal, recognition is not
// (Chrome and Edge have it; Firefox does not), so callers must handle absence.

export const SLOW_RATE = 0.6;

let germanVoice = null;

function pickGermanVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'de-DE')
    ?? voices.find((v) => v.lang?.startsWith('de'))
    ?? null;
}

if ('speechSynthesis' in window) {
  // Voices load asynchronously and the list is empty on first call in Chrome.
  germanVoice = pickGermanVoice();
  speechSynthesis.addEventListener('voiceschanged', () => { germanVoice = pickGermanVoice(); });
}

export const ttsAvailable = () => 'speechSynthesis' in window;
export const germanVoiceAvailable = () => !!(germanVoice ?? pickGermanVoice());

export function speak(text, { rate = 1 } = {}) {
  if (!text || !ttsAvailable()) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'de-DE';
  utter.rate = rate;
  const voice = germanVoice ?? pickGermanVoice();
  if (voice) utter.voice = voice;
  speechSynthesis.speak(utter);
}

export function stopSpeaking() {
  if (ttsAvailable()) speechSynthesis.cancel();
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const recognitionAvailable = () => !!Recognition;

/**
 * Starts one recognition pass and hands the recognizer back so the UI can stop
 * it on a second tap. One pass per tap — no continuous mode.
 */
export function startListening({ onResult, onError, onEnd }) {
  if (!Recognition) {
    onError?.(new Error('Speech recognition is not available in this browser. Chrome or Edge support it.'));
    return null;
  }
  const rec = new Recognition();
  rec.lang = 'de-DE';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  rec.continuous = false;

  let got = false;
  rec.onresult = (event) => {
    got = true;
    const transcript = event.results?.[0]?.[0]?.transcript ?? '';
    if (transcript.trim()) onResult?.(transcript);
    else onError?.(new Error("Didn't catch that — try again?"));
  };
  rec.onerror = (event) => { got = true; onError?.(new Error(describe(event.error))); };
  rec.onend = () => { if (!got) onError?.(new Error("Didn't hear anything.")); onEnd?.(); };

  try { rec.start(); } catch { onError?.(new Error('Could not start the microphone.')); return null; }
  return rec;
}

function describe(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed': return 'Microphone permission was denied.';
    case 'no-speech': return "Didn't hear anything.";
    case 'audio-capture': return 'No microphone found.';
    case 'network': return 'Network error during recognition.';
    case 'aborted': return 'Recognition cancelled.';
    case 'language-not-supported': return 'German recognition is not available in this browser.';
    default: return 'Speech recognition error.';
  }
}
