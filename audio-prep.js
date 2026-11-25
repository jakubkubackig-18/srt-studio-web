/**
 * Przeglądarkowe przygotowanie audio / wideo dla Groq Whisper API:
 * - Małe pliki audio (<= 18 MB: MP3, WAV, M4A, OGG, FLAC, WEBM audio) wysyła bezpośrednio (0 ms narzutu).
 * - Pliki wideo (MP4, MOV, MKV, WEBM) oraz duże pliki audio (> 18 MB) dekoduje w przeglądarce
 *   przez Web Audio API, konwertuje do lekkiego 16 kHz mono WAV (~1.9 MB/min) i automatycznie dzieli
 *   na 8-minutowe fragmenty (~15 MB każdy), dzięki czemu działają nawet 30-minutowe nagrania bez serwera FFmpeg!
 */

const DIRECT_AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus"]);
const MAX_DIRECT_BYTES = 18 * 1024 * 1024; // 18 MB (bezpiecznie poniżej limitu 25 MB free tier Groq)
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_SEC = 480; // 8 minut -> ~15.3 MB jako 16 kHz 16-bit mono WAV

function getExt(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function encodeWavMono16Bit(float32Samples, sampleRate) {
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Zwraca listę fragmentów gotowych do wysłania do Groq API:
 * [{ blob, filename, offsetSec }]
 */
export async function prepareAudioChunks(file, onProgress = () => {}) {
  const ext = getExt(file.name);
  const isDirectAudio =
    DIRECT_AUDIO_EXTS.has(ext) &&
    !file.type.startsWith("video/") &&
    file.size <= MAX_DIRECT_BYTES;

  if (isDirectAudio) {
    return [{ blob: file, filename: file.name, offsetSec: 0 }];
  }

  onProgress("Wyciąganie lekkiej ścieżki audio w przeglądarce (16 kHz mono)…", 14);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Twoja przeglądarka nie obsługuje Web Audio API. Prześlij plik MP3 poniżej 18 MB.");
  }

  let decoded;
  const ctx = new AudioCtx();
  try {
    const arrayBuf = await file.arrayBuffer();
    decoded = await ctx.decodeAudioData(arrayBuf);
  } catch (err) {
    throw new Error(
      "Przeglądarka nie potrafi zdekodować tego formatu wideo/audio (np. MKV/ProRes). Wyeksportuj sam dźwięk jako MP3 lub M4A i wrzuć ponownie."
    );
  } finally {
    await ctx.close().catch(() => {});
  }

  const totalDur = decoded.duration;
  const totalSamples16k = Math.max(1, Math.ceil(totalDur * TARGET_SAMPLE_RATE));

  onProgress("Konwersja do 16 kHz mono WAV…", 26);

  const offline = new OfflineAudioContext(1, totalSamples16k, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);

  const rendered = await offline.startRendering();
  const mono = rendered.getChannelData(0);

  const samplesPerChunk = CHUNK_DURATION_SEC * TARGET_SAMPLE_RATE;
  const chunks = [];
  let startSample = 0;
  let partIdx = 1;

  while (startSample < mono.length) {
    const endSample = Math.min(mono.length, startSample + samplesPerChunk);
    const slice = mono.subarray(startSample, endSample);
    const wavBlob = encodeWavMono16Bit(slice, TARGET_SAMPLE_RATE);
    chunks.push({
      blob: wavBlob,
      filename: `audio_part_${partIdx}.wav`,
      offsetSec: startSample / TARGET_SAMPLE_RATE,
    });
    startSample = endSample;
    partIdx += 1;
  }

  return chunks;
}
