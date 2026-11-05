// Mandarin audio through the Web Speech API. On-device voices are preferred so audio works offline.
import { pref, setPref } from './db';

let voices: SpeechSynthesisVoice[] = [];

function load() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices().filter((v) => /^zh[-_](CN|Hans)|^cmn/i.test(v.lang) || v.lang === 'zh');
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  load();
  speechSynthesis.addEventListener?.('voiceschanged', load);
}

export function chineseVoices(): SpeechSynthesisVoice[] {
  load();
  return [...voices].sort((a, b) => Number(b.localService) - Number(a.localService));
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const list = chineseVoices();
  const wanted = pref<string>('voice', '');
  return list.find((v) => v.voiceURI === wanted) ?? list.find((v) => v.localService) ?? list[0];
}

export function setVoice(uri: string) {
  setPref('voice', uri);
}

export function speechRate(): number {
  return pref<number>('rate', 0.85);
}

export function speak(text: string, rate = speechRate()): void {
  if (!speechAvailable() || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = rate;
  speechSynthesis.speak(u);
}
