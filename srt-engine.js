/**
 * Silnik przetwarzania napisów SRT i TXT (100% przeglądarkowy JavaScript, zero zależności):
 * - filtrowanie halucynacji Whispera (PL + wielojęzyczne)
 * - parsowanie istniejących plików .srt (proporcjonalna estymacja czasów słów)
 * - korekty transkryptu (błędnie => poprawnie) działające także na granicach cue
 * - tryb POZIOM (16:9): maks. 13 słów, min. 2 s, 1 linia (Resolve łamie sam), brak ogryzków, brak luk, max-hold
 * - tryb PION (9:16): stała liczba linii (dom. 1) i maks. znaków/linię ze spacjami (dom. 16), ochrona sierot, domyślnie <b>
 * - tryb WŁASNY: 1–2 linie, maks. słów na linię
 * - pełny raport QA (kompletność, sieroty, linie ponad limit, cue < min_dur, długie cisze, halucynacje)
 */

export const ABBREVIATIONS = new Set([
  "np.", "tzn.", "itp.", "itd.", "tzw.", "godz.", "min.", "sek.", "art.", "ust.",
  "pl.", "al.", "ul.", "prof.", "dr.", "hab.", "str.", "mgr.", "inż.", "lek.",
  "tys.", "mln.", "mld.", "ok.", "św.", "im.", "nr.", "pkt.", "rys.", "tab.",
  "etc.", "e.g.", "i.e.", "mr.", "mrs.", "ms.", "vs.",
]);

export const ORPHANS_1 = new Set(["i", "z", "w", "a", "o", "u"]);
export const ORPHANS_2 = new Set(["na", "do", "ze", "że", "to", "od", "po"]);

export const SOFT_PREPOSITIONS = new Set([
  "na", "do", "ze", "że", "to", "od", "po", "za", "pod", "nad", "przy",
  "przez", "przed", "dla", "bez", "we", "ku", "oraz", "lub", "albo", "czy",
  "jak", "gdy", "bo", "ale", "lecz", "więc", "czyli", "nie",
]);

export const HARD_HALLUCINATION_SUBSTRINGS = [
  "amara.org",
  "amara org",
  "napisy stworzone przez",
  "napisy przygotował",
  "napisy wykonał",
  "napisy opracował",
  "napisy by",
  "napisy pl",
  "polskie napisy",
  "jacek makarewicz",
  "tłumaczenie i napisy",
  "tłumaczenie napisów",
  "korekta napisów",
  "subtitles by",
  "captioned by",
  "transcribed by",
  "mbc 뉴스",
  "ご視聴ありがとうございました",
  "시청해주셔서 감사합니다",
];

// Frazy często doklejane przez Whispera na początku/końcu segmentu po długiej ciszy w filmach
const HALLUCINATION_PREFIX_PATTERNS = [
  /^\s*(?:dzięki|dziękuję)(?:\s+bardzo)?\s+za\s+(?:oglądanie|uwagę)[!.…,\s]*/i,
  /^\s*(?:zapraszam\s+do\s+subskrypcji|subskrybuj(?:\s+kanał)?)[!.…,\s]*/i,
  /^\s*(?:napisy\s+by\s+[^.!?\n]+)[!.…,\s]*/i,
  /^\s*(?:thanks?\s+you?\s+for\s+watching)[!.…,\s]*/i,
];

export const SILENCE_HALLUCINATION_PHRASES = new Set([
  "dziękuję", "dziękuję bardzo", "dziękuję za uwagę", "dziękuję za oglądanie",
  "dzięki za oglądanie", "dzięki za uwagę", "do zobaczenia", "do usłyszenia",
  "subskrybuj", "subskrybuj kanał", "zapraszam do subskrypcji", "polub i subskrybuj",
  "thank you", "thank you very much", "thank you for watching", "thanks for watching",
  "please subscribe", "subscribe", "bye", "bye bye", "you",
  "muzyka", "music", "applause", "brawa", "śmiech", "cisza",
]);

// Frazy YouTube'owe halucynowane w dialogach nawet przy niskim no_speech_prob
const STRONG_OUTRO_HALLUCINATIONS = new Set([
  "dzięki za oglądanie",
  "dziękuję za oglądanie",
  "dziękuję za oglądanie mojego filmu",
  "dzięki za oglądanie mojego filmu",
  "zapraszam do subskrypcji",
  "subskrybuj kanał",
  "polub i subskrybuj",
  "thank you for watching",
  "thanks for watching",
]);

const SENTENCE_END_CHARS = [".", "?", "!", "…"];
const CLAUSE_END_CHARS = [",", ";", ":", "—", "–", "-"];

// ─────────────────────────── FORMATTING HELPERS ──────────────────────────────

export function fmtTsTxt(seconds) {
  const t = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h > 0 ? `[${p2(h)}:${p2(m)}:${p2(s)}]` : `[${p2(m)}:${p2(s)}]`;
}

export function fmtTsSrt(seconds) {
  const ms = Math.max(0, Math.round((seconds || 0) * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(r)}`;
}

export function parseTsSrt(ts) {
  const norm = String(ts || "").trim().replace(".", ",");
  const m = norm.match(/^(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})$/);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, "0"), 10);
  return h * 3600 + mn * 60 + s + ms / 1000;
}

function stripTags(text) {
  return String(text || "").replace(/<\/?(?:b|i|u|font[^>]*)>/gi, "");
}

function cleanWordCore(token) {
  return String(token || "")
    .replace(/^["'„”«»(\[—–\-]+|["'„”«»)\].,?!…;:\-—–]+$/g, "")
    .toLowerCase();
}

function endsSentence(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const stripped = t.replace(/["'”»)\]]+$/g, "");
  if (!stripped) return false;
  if (ABBREVIATIONS.has(stripped.toLowerCase())) return false;
  if (/^[A-ZĄĆĘŁŃÓŚŹŻ]\.$/.test(stripped)) return false;
  return SENTENCE_END_CHARS.some((ch) => stripped.endsWith(ch));
}

function endsClause(token) {
  const stripped = String(token || "").trim().replace(/["'”»)\]]+$/g, "");
  return CLAUSE_END_CHARS.some((ch) => stripped.endsWith(ch));
}

function isOrphan(token, includeTwoLetter = false) {
  const core = cleanWordCore(token);
  if (!core) return false;
  if (endsSentence(token)) return false;
  if (ORPHANS_1.has(core)) return true;
  if (includeTwoLetter && ORPHANS_2.has(core)) return true;
  return false;
}

// ────────────────────────── HALLUCINATION FILTER ─────────────────────────────

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInternalRepetitionLoop(text) {
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  const n = tokens.length;
  if (n < 4) return false;

  for (let k = 1; k <= 4; k++) {
    if (n < k * 4) continue;
    let runCount = 1;
    let i = 0;
    while (i + 2 * k <= n) {
      let equal = true;
      for (let j = 0; j < k; j++) {
        if (tokens[i + j] !== tokens[i + k + j]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        runCount += 1;
        if (runCount >= 4) return true;
        i += k;
      } else {
        runCount = 1;
        i += 1;
      }
    }
  }
  return false;
}

export function filterHallucinations(segments) {
  const cleaned = [];
  const removed = [];
  let lastNorm = null;
  let repeatStreak = 0;

  for (const origSeg of segments || []) {
    let seg = { ...origSeg };
    let text = String(seg.text || "").trim();
    if (!text) continue;

    let norm = normalizeText(text);
    const start = Number(seg.start || 0);
    const end = Number(seg.end ?? start);

    if (!norm) {
      removed.push({ start, end, text, reason: "pusty tekst" });
      continue;
    }

    const noSpeech = Number(seg.no_speech_prob || 0);
    const avgLogprob = Number(seg.avg_logprob || 0);
    const compRatio = Number(seg.compression_ratio || 0);

    if (noSpeech >= 0.75 || (noSpeech >= 0.52 && avgLogprob <= -0.75)) {
      removed.push({ start, end, text, reason: `cisza (no_speech=${noSpeech.toFixed(2)})` });
      continue;
    }

    if (HARD_HALLUCINATION_SUBSTRINGS.some((sub) => norm.includes(sub))) {
      removed.push({ start, end, text, reason: "kredyty/duch napisowy" });
      continue;
    }

    if (STRONG_OUTRO_HALLUCINATIONS.has(norm)) {
      removed.push({ start, end, text, reason: "halucynacja YouTube w ciszy" });
      continue;
    }

    // Usuń doklejony przez Whispera prefiks typu "Dzięki za oglądanie!" przed właściwym dialogiem
    for (const rx of HALLUCINATION_PREFIX_PATTERNS) {
      const m = text.match(rx);
      if (m && m[0].length < text.length) {
        const prefixWords = m[0].trim().split(/\s+/).filter(Boolean).length;
        const remainder = text.slice(m[0].length).trim();
        if (remainder) {
          removed.push({ start, end: start, text: m[0].trim(), reason: "halucynowany prefiks" });
          text = remainder;
          seg.text = remainder;
          if (Array.isArray(seg.words) && seg.words.length > prefixWords) {
            seg.words = seg.words.slice(prefixWords);
            seg.start = Number(seg.words[0].start ?? seg.start);
          }
          norm = normalizeText(text);
        }
      }
    }

    if (SILENCE_HALLUCINATION_PHRASES.has(norm) && (noSpeech >= 0.35 || avgLogprob <= -0.55)) {
      removed.push({ start, end, text, reason: "fraza halucynowana w ciszy" });
      continue;
    }

    if (compRatio >= 2.4 || isInternalRepetitionLoop(text)) {
      removed.push({ start, end, text, reason: "pętla powtórzeń" });
      continue;
    }

    if (norm === lastNorm) {
      repeatStreak += 1;
      if (repeatStreak >= 2) {
        removed.push({ start, end, text, reason: "powtarzany segment (3+)" });
        continue;
      }
    } else {
      lastNorm = norm;
      repeatStreak = 0;
    }

    cleaned.push(seg);
  }

  return { cleaned, removed };
}

// ─────────────────────── WORD EXTRACTION & SRT PARSING ───────────────────────

function estimateWordTimings(rawWords, start, end, estimated = true) {
  if (!rawWords.length) return [];
  const dur = Math.max(0.15, end - start);
  const weights = rawWords.map((w) => Math.max(1, (cleanWordCore(w) || w).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const tokens = [];
  let cursor = start;

  for (let i = 0; i < rawWords.length; i++) {
    const wDur = dur * (weights[i] / totalWeight);
    tokens.push({
      text: rawWords[i],
      start: cursor,
      end: cursor + wDur,
      estimated,
    });
    cursor += wDur;
  }
  if (tokens.length) {
    tokens[tokens.length - 1].end = Math.max(tokens[tokens.length - 1].start + 0.05, end);
  }
  return tokens;
}

/**
 * Łączy odpowiedź Groq/OpenAI verbose_json (gdzie `words` bywa na najwyższym poziomie)
 * z segmentami, aby zachować metryki halucynacji segmentów oraz czasy pojedynczych słów.
 */
export function attachGroqWordsToSegments(payload, timeOffset = 0) {
  const segments = (payload.segments || []).map((s) => ({
    ...s,
    start: Number(s.start || 0) + timeOffset,
    end: Number(s.end || 0) + timeOffset,
    words: Array.isArray(s.words)
      ? s.words.map((w) => ({
          ...w,
          start: Number(w.start || 0) + timeOffset,
          end: Number(w.end || 0) + timeOffset,
        }))
      : [],
  }));

  const topWords = (payload.words || [])
    .filter((w) => w && (!w.type || w.type === "word") && String(w.word ?? w.text ?? "").trim())
    .map((w) => ({
      ...w,
      word: String(w.word ?? w.text ?? "").trim(),
      start: Number(w.start || 0) + timeOffset,
      end: Number(w.end ?? w.start ?? 0) + timeOffset,
    }));

  if (topWords.length && segments.length) {
    let wIdx = 0;
    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      const segEnd = seg.end;
      const segWords = [];
      while (wIdx < topWords.length) {
        const w = topWords[wIdx];
        const wMid = (w.start + w.end) / 2;
        if (sIdx === segments.length - 1 || wMid <= segEnd + 0.08) {
          segWords.push(w);
          wIdx++;
        } else {
          break;
        }
      }
      seg.words = segWords;
    }
  } else if (topWords.length && !segments.length) {
    segments.push({
      start: topWords[0].start,
      end: topWords[topWords.length - 1].end,
      text: payload.text || topWords.map((w) => w.word).join(" "),
      words: topWords,
    });
  }

  return segments;
}

export function segmentsToWords(segments) {
  const tokens = [];
  for (const seg of segments || []) {
    const words = seg.words || [];
    if (words.length) {
      for (const w of words) {
        const txt = String(w.word ?? w.text ?? "").trim();
        if (!txt) continue;
        const ws = Number(w.start ?? seg.start ?? 0);
        let we = Number(w.end ?? ws + 0.15);
        if (we < ws) we = ws + 0.05;
        const parts = txt.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          tokens.push({ text: parts[0], start: ws, end: we, estimated: false });
        } else {
          tokens.push(...estimateWordTimings(parts, ws, we, true));
        }
      }
    } else {
      const parts = String(seg.text || "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const segStart = Number(seg.start || 0);
      const segEnd = Number(seg.end ?? segStart + 1.0);
      tokens.push(...estimateWordTimings(parts, segStart, segEnd, true));
    }
  }

  // Zapewnij monotoniczność startów i przytnij nienaturalnie rozciągnięte czasy pojedynczych słów
  // (Whisper w dialogach z długą ciszą potrafi rozciągnąć word.end na 10-30 s w głąb ciszy)
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && tokens[i].start < tokens[i - 1].start) {
      tokens[i].start = tokens[i - 1].start;
    }
    const maxWordDur = Math.max(1.6, Math.min(3.2, tokens[i].text.length * 0.22));
    if (tokens[i].end - tokens[i].start > maxWordDur) {
      tokens[i].end = tokens[i].start + maxWordDur;
    }
    if (tokens[i].end < tokens[i].start) {
      tokens[i].end = tokens[i].start + 0.08;
    }
    if (i > 0 && tokens[i - 1].end > tokens[i].start) {
      tokens[i - 1].end = Math.max(tokens[i - 1].start + 0.05, tokens[i].start);
    }
  }

  return tokens;
}

export function parseSrtToWords(srtContent) {
  const content = String(srtContent || "")
    .replace(/^\ufeff/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = content.trim().split(/\n{2,}/);
  const tokens = [];
  let hadBold = false;

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    let tsIdx = 0;
    if (!lines[0].includes("-->") && lines.length >= 2 && lines[1].includes("-->")) {
      tsIdx = 1;
    } else if (!lines[0].includes("-->")) {
      continue;
    }

    const m = lines[tsIdx].match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    );
    if (!m) continue;

    const start = parseTsSrt(m[1]);
    const end = parseTsSrt(m[2]);
    const rawText = lines.slice(tsIdx + 1).join(" ");
    if (/<b>/i.test(rawText)) hadBold = true;

    const rawWords = stripTags(rawText).split(/\s+/).filter(Boolean);
    if (rawWords.length) {
      tokens.push(...estimateWordTimings(rawWords, start, end, true));
    }
  }

  return { words: tokens, hadBold };
}

// ────────────────────────── CORRECTIONS (--fix) ──────────────────────────────

export function parseFixesText(fixesRaw) {
  const pairs = [];
  if (!fixesRaw) return pairs;
  for (const rawLine of String(fixesRaw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.includes("=>") ? "=>" : line.includes("->") ? "->" : null;
    if (!sep) continue;
    const idx = line.indexOf(sep);
    const left = line.slice(0, idx).trim();
    const right = line.slice(idx + sep.length).trim();
    if (left) pairs.push([left, right]);
  }
  return pairs;
}

export function applyFixes(words, fixes) {
  if (!fixes.length || !words.length) {
    return {
      words: words.map((w) => ({ ...w })),
      appliedLog: [],
    };
  }

  let current = words.map((w) => ({ ...w }));
  const appliedLog = [];

  for (const [src, dst] of fixes) {
    const srcParts = src.split(/\s+/).filter(Boolean);
    const dstParts = dst ? dst.split(/\s+/).filter(Boolean) : [];
    if (!srcParts.length) continue;

    const k = srcParts.length;
    let count = 0;
    const out = [];
    let i = 0;
    const n = current.length;

    while (i < n) {
      let match = i + k <= n;
      if (match) {
        for (let j = 0; j < k; j++) {
          if (current[i + j].text !== srcParts[j]) {
            match = false;
            break;
          }
        }
      }
      if (match) {
        const spanStart = current[i].start;
        const spanEnd = current[i + k - 1].end;
        let wasEst = false;
        for (let j = 0; j < k; j++) {
          if (current[i + j].estimated) wasEst = true;
        }
        if (dstParts.length) {
          out.push(...estimateWordTimings(dstParts, spanStart, spanEnd, wasEst));
        }
        count += 1;
        i += k;
      } else {
        out.push(current[i]);
        i += 1;
      }
    }

    current = out;
    appliedLog.push({ from: src, to: dst, count });
  }

  return { words: current, appliedLog };
}

// ──────────────────────── ORPHAN ATOMIC GROUPING ─────────────────────────────

function groupAtomicUnits(words, includeTwoLetter = false) {
  const units = [];
  let i = 0;
  const n = words.length;
  while (i < n) {
    const group = [words[i]];
    while (
      isOrphan(group[group.length - 1].text, includeTwoLetter) &&
      i + 1 < n
    ) {
      if (endsSentence(group[group.length - 1].text)) break;
      if (words[i + 1].start - group[group.length - 1].end > 3.0) break;
      i += 1;
      group.push(words[i]);
    }
    units.push(group);
    i += 1;
  }
  return units;
}

function splitIntoSentences(words, maxHold = 5.0) {
  const sentences = [];
  let buf = [];
  for (const w of words) {
    if (buf.length && w.start - buf[buf.length - 1].end > maxHold) {
      sentences.push(buf);
      buf = [];
    }
    buf.push(w);
    if (endsSentence(w.text)) {
      sentences.push(buf);
      buf = [];
    }
  }
  if (buf.length) sentences.push(buf);
  return sentences;
}

// ─────────────────────────── NO-GAPS & PAUSE HOLD ────────────────────────────

function applyNoGapsAndHold(rawCues, maxHold) {
  const silences = [];
  if (!rawCues.length) return { cues: [], silences };

  if (rawCues[0].start > maxHold) {
    silences.push({
      start: 0,
      end: round3(rawCues[0].start),
      duration: round3(rawCues[0].start),
      start_srt: fmtTsSrt(0),
      end_srt: fmtTsSrt(rawCues[0].start),
      note: "cisza na początku nagrania",
    });
  }

  for (let i = 0; i < rawCues.length; i++) {
    const c = rawCues[i];
    const spokenEnd = Math.max(c.start + 0.1, c.spoken_end);
    if (i + 1 < rawCues.length) {
      let nxtStart = rawCues[i + 1].start;
      if (nxtStart < c.start + 0.1) {
        nxtStart = c.start + 0.1;
        rawCues[i + 1].start = nxtStart;
      }
      const clampedSpokenEnd = Math.min(spokenEnd, nxtStart);
      const gap = nxtStart - clampedSpokenEnd;
      if (gap <= maxHold) {
        // Ścisły brak luk i zero nakładania się: c.end === nxtStart
        c.end = nxtStart;
      } else {
        c.end = Math.min(nxtStart, clampedSpokenEnd + maxHold);
        silences.push({
          start: round3(c.end),
          end: round3(nxtStart),
          duration: round3(nxtStart - c.end),
          start_srt: fmtTsSrt(c.end),
          end_srt: fmtTsSrt(nxtStart),
          note: `cisza po cue #${i + 1}`,
        });
      }
    } else {
      c.end = Math.max(spokenEnd + 0.4, c.start + 0.5);
    }
  }

  return { cues: rawCues, silences };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function makeCueObject(index, start, end, spokenEnd, lines, bold, warnings) {
  const plainText = lines.join("\n");
  const formattedText = bold ? `<b>${plainText}</b>` : plainText;
  const wordCount = lines.reduce((acc, ln) => acc + ln.split(/\s+/).filter(Boolean).length, 0);
  const maxLineChars = lines.reduce((m, ln) => Math.max(m, ln.length), 0);
  return {
    index,
    start: round3(start),
    end: round3(end),
    spoken_end: round3(spokenEnd),
    duration: round3(Math.max(0, end - start)),
    start_srt: fmtTsSrt(start),
    end_srt: fmtTsSrt(end),
    start_txt: fmtTsTxt(start),
    lines,
    text: plainText,
    formatted_text: formattedText,
    bold,
    word_count: wordCount,
    max_line_chars: maxLineChars,
    warnings,
  };
}

// ─────────────────────────── POZIOM (16:9) ENGINE ────────────────────────────

function splitLongSentenceHorizontal(sent, maxWords = 13, includeTwoLetter = false) {
  const n = sent.length;
  if (n <= maxWords) return [sent];

  const numChunks = Math.ceil(n / maxWords);
  const target = n / numChunks;
  const chunks = [];
  let startIdx = 0;

  for (let chunkI = 0; chunkI < numChunks - 1; chunkI++) {
    const remainingChunks = numChunks - chunkI;
    const remainingWords = n - startIdx;
    let minEnd = Math.max(startIdx + 2, n - (remainingChunks - 1) * maxWords);
    let maxEnd = Math.min(startIdx + maxWords, n - (remainingChunks - 1) * 2);
    if (minEnd > maxEnd) {
      minEnd = maxEnd = Math.min(startIdx + maxWords, n - 1);
    }

    const idealEnd = startIdx + Math.round(remainingWords / remainingChunks);
    let bestEnd = idealEnd;
    let bestScore = -1e9;

    for (let cand = minEnd; cand <= maxEnd; cand++) {
      const lastW = sent[cand - 1];
      const nextW = sent[cand];
      const chunkLen = cand - startIdx;

      let score = -Math.abs(chunkLen - target) * 2.5;
      if (chunkLen >= 9 && chunkLen <= maxWords) score += 1.5;
      if (chunkLen <= 3) score -= 10.0;

      if (isOrphan(lastW.text, includeTwoLetter)) {
        score -= 1000.0;
      } else if (SOFT_PREPOSITIONS.has(cleanWordCore(lastW.text)) && !endsClause(lastW.text)) {
        score -= 12.0;
      }

      if (endsClause(lastW.text)) score += 14.0;

      const pause = nextW.start - lastW.end;
      if (pause >= 0.35) score += Math.min(10.0, pause * 8.0);

      if (score > bestScore) {
        bestScore = score;
        bestEnd = cand;
      }
    }

    chunks.push(sent.slice(startIdx, bestEnd));
    startIdx = bestEnd;
  }

  chunks.push(sent.slice(startIdx));
  return chunks;
}

export function buildHorizontalCues(
  words,
  {
    maxWords = 13,
    minDur = 2.0,
    maxHold = 5.0,
    bold = false,
    includeTwoLetterOrphans = false,
  } = {}
) {
  if (!words.length) return { cues: [], silences: [] };

  const sentences = splitIntoSentences(words, maxHold);
  let rawGroups = [];

  sentences.forEach((sent, sIdx) => {
    const parts = splitLongSentenceHorizontal(sent, maxWords, includeTwoLetterOrphans);
    for (const part of parts) {
      rawGroups.push({
        words: part,
        sentence_id: sIdx,
        start: part[0].start,
        spoken_end: part[part.length - 1].end,
        end: part[part.length - 1].end,
      });
    }
  });

  rawGroups = applyNoGapsAndHold(rawGroups, maxHold).cues;

  let changed = true;
  let guard = 0;
  while (changed && rawGroups.length > 1 && guard < 200) {
    changed = false;
    guard += 1;

    for (let i = 0; i < rawGroups.length; i++) {
      const cur = rawGroups[i];
      const dur = cur.end - cur.start;
      const wCnt = cur.words.length;
      const isStub = wCnt <= 2 && dur < minDur;
      const isShort = dur < minDur - 0.02;

      if (!isShort && !isStub) continue;

      const canPrev =
        i > 0 &&
        cur.start - rawGroups[i - 1].spoken_end <= maxHold &&
        rawGroups[i - 1].words.length + wCnt <= maxWords;

      const canNext =
        i + 1 < rawGroups.length &&
        rawGroups[i + 1].start - cur.spoken_end <= maxHold &&
        wCnt + rawGroups[i + 1].words.length <= maxWords;

      let mergeDir = null;
      if (canPrev && canNext) {
        const samePrev = rawGroups[i - 1].sentence_id === cur.sentence_id;
        const sameNext = rawGroups[i + 1].sentence_id === cur.sentence_id;
        if (samePrev && !sameNext) mergeDir = "prev";
        else if (sameNext && !samePrev) mergeDir = "next";
        else mergeDir = rawGroups[i - 1].words.length <= rawGroups[i + 1].words.length ? "prev" : "next";
      } else if (canPrev) {
        mergeDir = "prev";
      } else if (canNext) {
        mergeDir = "next";
      }

      if (mergeDir === "prev") {
        const prev = rawGroups[i - 1];
        prev.words = prev.words.concat(cur.words);
        prev.spoken_end = cur.spoken_end;
        prev.end = cur.end;
        rawGroups.splice(i, 1);
        rawGroups = applyNoGapsAndHold(rawGroups, maxHold).cues;
        changed = true;
        break;
      } else if (mergeDir === "next") {
        const nxt = rawGroups[i + 1];
        cur.words = cur.words.concat(nxt.words);
        cur.spoken_end = nxt.spoken_end;
        cur.end = nxt.end;
        rawGroups.splice(i + 1, 1);
        rawGroups = applyNoGapsAndHold(rawGroups, maxHold).cues;
        changed = true;
        break;
      }

      // Przesunięcie granicy między dwoma cue, gdy sąsiad ma zapas > minDur
      const needed = minDur - dur;
      if (i + 1 < rawGroups.length) {
        const nxt = rawGroups[i + 1];
        const nxtDur = nxt.end - nxt.start;
        if (nxt.start - cur.spoken_end <= maxHold && nxtDur - needed >= minDur) {
          const shift = Math.min(needed, 0.65);
          if (cur.end + shift < nxt.end - minDur + 0.01) {
            cur.end += shift;
            nxt.start += shift;
            changed = true;
            break;
          }
        }
      }
      if (i > 0) {
        const prev = rawGroups[i - 1];
        const prevDur = prev.end - prev.start;
        if (cur.start - prev.spoken_end <= maxHold && prevDur - needed >= minDur) {
          const shift = Math.min(needed, 0.65);
          if (prev.end - shift >= prev.start + minDur - 0.01) {
            prev.end -= shift;
            cur.start -= shift;
            changed = true;
            break;
          }
        }
      }
    }
  }

  const finalized = applyNoGapsAndHold(rawGroups, maxHold);
  rawGroups = finalized.cues;
  const silences = finalized.silences;

  if (rawGroups.length) {
    const last = rawGroups[rawGroups.length - 1];
    if (last.end - last.start < minDur) {
      last.end = last.start + minDur;
    }
  }

  const cues = rawGroups.map((g, idx) => {
    const lineText = g.words.map((w) => w.text).join(" ");
    const warns = [];
    const dur = g.end - g.start;
    if (dur < minDur - 0.05) {
      warns.push(`czas trwania ${dur.toFixed(2)}s < ${minDur.toFixed(1)}s`);
    }
    if (g.words.length > maxWords) {
      warns.push(`${g.words.length} słów > limit ${maxWords}`);
    }
    if (g.words.length && isOrphan(g.words[g.words.length - 1].text, includeTwoLetterOrphans)) {
      warns.push(`sierota na końcu cue: '${g.words[g.words.length - 1].text}'`);
    }
    return makeCueObject(idx + 1, g.start, g.end, g.spoken_end, [lineText], bold, warns);
  });

  return { cues, silences };
}

// ──────────────────────────── PION (9:16) ENGINE ─────────────────────────────

export function buildVerticalCues(
  words,
  {
    linesPerCue = 1,
    maxChars = 16,
    maxHold = 5.0,
    bold = true,
    includeTwoLetterOrphans = false,
  } = {}
) {
  if (!words.length) return { cues: [], silences: [] };

  const linesCount = Math.max(1, Math.min(3, parseInt(linesPerCue, 10) || 1));
  const charLimit = Math.max(8, parseInt(maxChars, 10) || 16);

  const sentences = splitIntoSentences(words, maxHold);
  let rawGroups = [];

  for (const sent of sentences) {
    const units = groupAtomicUnits(sent, includeTwoLetterOrphans);
    const packedLines = [];
    let curLine = [];
    let curLen = 0;

    for (const unit of units) {
      const unitStr = unit.map((w) => w.text).join(" ");
      const unitLen = unitStr.length;

      if (!curLine.length) {
        curLine = [...unit];
        curLen = unitLen;
      } else if (curLen + 1 + unitLen <= charLimit) {
        curLine.push(...unit);
        curLen += 1 + unitLen;
      } else {
        packedLines.push(curLine);
        curLine = [...unit];
        curLen = unitLen;
      }
    }
    if (curLine.length) packedLines.push(curLine);

    for (let i = 0; i < packedLines.length; i += linesCount) {
      const slice = packedLines.slice(i, i + linesCount);
      const flat = slice.flat();
      const lineStrings = slice.map((ln) => ln.map((w) => w.text).join(" "));
      rawGroups.push({
        words: flat,
        lines: lineStrings,
        start: flat[0].start,
        spoken_end: flat[flat.length - 1].end,
        end: flat[flat.length - 1].end,
      });
    }
  }

  const finalized = applyNoGapsAndHold(rawGroups, maxHold);
  rawGroups = finalized.cues;
  const silences = finalized.silences;

  const cues = rawGroups.map((g, idx) => {
    const warns = [];
    for (const ln of g.lines) {
      if (ln.length > charLimit) {
        if (!ln.includes(" ")) {
          warns.push(`długi wyraz ponad limit (${ln.length}/${charLimit} zn.): '${ln}'`);
        } else {
          warns.push(`linia ponad limit przez sierotę/złożenie (${ln.length}/${charLimit} zn.): '${ln}'`);
        }
      }
      const lnWords = ln.split(/\s+/).filter(Boolean);
      if (lnWords.length && isOrphan(lnWords[lnWords.length - 1], includeTwoLetterOrphans)) {
        warns.push(`sierota na końcu linii: '${lnWords[lnWords.length - 1]}'`);
      }
    }
    return makeCueObject(idx + 1, g.start, g.end, g.spoken_end, g.lines, bold, warns);
  });

  return { cues, silences };
}

// ─────────────────────── WŁASNY (SŁOWA / LINIE) ENGINE ───────────────────────

function findSplitIdxCustom(words, maxW, includeTwoLetter = false) {
  const total = words.length;
  let bestIdx = Math.max(total - maxW, Math.min(maxW, Math.floor((total + 1) / 2)));
  for (const offset of [0, 1, -1, 2, -2]) {
    const cand = Math.floor((total + 1) / 2) + offset;
    if (total - maxW <= cand && cand <= maxW && cand >= 1 && cand < total) {
      const prevText = words[cand - 1].text;
      if (isOrphan(prevText, includeTwoLetter)) continue;
      if (endsClause(prevText)) return cand;
    }
  }
  if (bestIdx >= 1 && bestIdx < total && isOrphan(words[bestIdx - 1].text, includeTwoLetter)) {
    if (bestIdx - 1 >= Math.max(1, total - maxW)) bestIdx -= 1;
    else if (bestIdx + 1 <= Math.min(maxW, total - 1)) bestIdx += 1;
  }
  return bestIdx;
}

export function buildCustomCues(
  words,
  {
    maxLines = 1,
    maxWordsPerLine = 5,
    maxGap = 0.8,
    maxHold = 5.0,
    noGaps = true,
    bold = false,
    includeTwoLetterOrphans = false,
  } = {}
) {
  if (!words.length) return { cues: [], silences: [] };

  const linesLim = Math.max(1, Math.min(2, parseInt(maxLines, 10) || 1));
  const wordsLim = Math.max(1, Math.min(15, parseInt(maxWordsPerLine, 10) || 5));
  const maxTotalWords = linesLim * wordsLim;

  let rawGroups = [];
  let cur = [];

  const flush = () => {
    if (!cur.length) return;
    let lines;
    if (linesLim === 1 || cur.length <= wordsLim) {
      lines = [cur.map((w) => w.text).join(" ")];
    } else {
      const splitIdx = findSplitIdxCustom(cur, wordsLim, includeTwoLetterOrphans);
      lines = [
        cur.slice(0, splitIdx).map((w) => w.text).join(" "),
        cur.slice(splitIdx).map((w) => w.text).join(" "),
      ];
    }
    rawGroups.push({
      words: [...cur],
      lines,
      start: cur[0].start,
      spoken_end: cur[cur.length - 1].end,
      end: cur[cur.length - 1].end,
    });
    cur = [];
  };

  const units = groupAtomicUnits(words, includeTwoLetterOrphans);
  for (const unit of units) {
    if (cur.length) {
      const prevEnd = cur[cur.length - 1].end;
      const uStart = unit[0].start;
      const isGap = uStart - prevEnd >= maxGap;
      const endsSent = endsSentence(cur[cur.length - 1].text);
      const wouldOverflow = cur.length + unit.length > maxTotalWords;
      if (isGap || wouldOverflow || (endsSent && (uStart - prevEnd >= 0.3 || cur.length >= 2))) {
        flush();
      }
    }
    cur.push(...unit);
  }
  flush();

  let silences = [];
  if (noGaps) {
    const res = applyNoGapsAndHold(rawGroups, maxHold);
    rawGroups = res.cues;
    silences = res.silences;
  } else {
    for (let i = 0; i < rawGroups.length; i++) {
      if (i > 0 && rawGroups[i].start < rawGroups[i - 1].end) {
        rawGroups[i].start = rawGroups[i - 1].end;
      }
      if (rawGroups[i].end <= rawGroups[i].start) {
        rawGroups[i].end = rawGroups[i].start + 0.3;
      }
    }
  }

  const cues = rawGroups.map((g, idx) => {
    const warns = [];
    for (const ln of g.lines) {
      const lnWords = ln.split(/\s+/).filter(Boolean);
      if (lnWords.length && isOrphan(lnWords[lnWords.length - 1], includeTwoLetterOrphans)) {
        warns.push(`sierota na końcu linii: '${lnWords[lnWords.length - 1]}'`);
      }
    }
    return makeCueObject(idx + 1, g.start, g.end, g.spoken_end, g.lines, bold, warns);
  });

  return { cues, silences };
}

// ────────────────────────── HIGH-LEVEL PIPELINE ──────────────────────────────

export function renderSrt(cues, overrideBold = null) {
  return cues
    .map((c, idx) => {
      const useBold = overrideBold !== null ? overrideBold : Boolean(c.bold);
      const body = useBold ? `<b>${c.text}</b>` : c.text;
      return `${idx + 1}\n${fmtTsSrt(c.start)} --> ${fmtTsSrt(c.end)}\n${body}\n`;
    })
    .join("\n");
}

export function renderTxt(cues, withTimestamps = true) {
  if (!cues.length) return "";
  if (!withTimestamps) {
    return cues.map((c) => c.text.replace(/\n/g, " ")).join(" ").trim() + "\n";
  }
  return (
    cues
      .map((c) => {
        const ts = fmtTsTxt(c.start);
        const lines = c.text.split("\n");
        return lines.length > 1
          ? `${ts} ${lines[0]}\n${lines.slice(1).join("\n")}`
          : `${ts} ${lines[0]}`;
      })
      .join("\n") + "\n"
  );
}

export function formatSubtitles(
  words,
  {
    variant = "horizontal",
    maxWords = 13,
    minDur = 2.0,
    maxHold = 5.0,
    verticalLines = 1,
    verticalChars = 16,
    customLines = 1,
    customWordsPerLine = 5,
    customNoGaps = true,
    boldMode = "auto",
    sourceHadBold = false,
    includeTwoLetterOrphans = false,
    fixesText = "",
    removedHallucinations = [],
  } = {}
) {
  const fixes = parseFixesText(fixesText);
  const { words: fixedWords, appliedLog } = applyFixes(words, fixes);

  let useBold;
  if (boldMode === "yes") useBold = true;
  else if (boldMode === "no") useBold = false;
  else useBold = variant === "vertical" ? true : Boolean(sourceHadBold);

  let built;
  if (variant === "horizontal") {
    built = buildHorizontalCues(fixedWords, {
      maxWords,
      minDur,
      maxHold,
      bold: useBold,
      includeTwoLetterOrphans,
    });
  } else if (variant === "vertical") {
    built = buildVerticalCues(fixedWords, {
      linesPerCue: verticalLines,
      maxChars: verticalChars,
      maxHold,
      bold: useBold,
      includeTwoLetterOrphans,
    });
  } else {
    built = buildCustomCues(fixedWords, {
      maxLines: customLines,
      maxWordsPerLine: customWordsPerLine,
      maxHold,
      noGaps: customNoGaps,
      bold: useBold,
      includeTwoLetterOrphans,
    });
  }

  const { cues, silences } = built;

  // Kontrola kompletności słów (zasada 2.7)
  const inWords = fixedWords.map((w) => w.text);
  const outWords = cues.flatMap((c) => c.lines.flatMap((ln) => ln.split(/\s+/).filter(Boolean)));
  const completenessOk =
    inWords.length === outWords.length && inWords.every((w, idx) => w === outWords[idx]);

  const cueWarnings = [];
  for (const c of cues) {
    for (const msg of c.warnings) {
      cueWarnings.push({
        cue_index: c.index,
        timecode: fmtTsSrt(c.start),
        message: msg,
        text: c.text,
      });
    }
  }

  const hasEstimated = fixedWords.some((w) => w.estimated);
  const lastEnd = cues.length ? cues[cues.length - 1].end : 0;

  return {
    variant,
    use_bold: useBold,
    cues,
    srt: renderSrt(cues, useBold),
    txt: renderTxt(cues, true),
    txt_plain: renderTxt(cues, false),
    report: {
      cue_count: cues.length,
      word_count: outWords.length,
      total_duration: round3(lastEnd),
      total_duration_str: fmtTsTxt(lastEnd),
      completeness_ok: completenessOk,
      warnings_count: cueWarnings.length,
      warnings: cueWarnings,
      silences,
      removed_hallucinations: removedHallucinations || [],
      applied_fixes: appliedLog.filter((f) => f.count > 0),
      unmatched_fixes: appliedLog.filter((f) => f.count === 0),
      estimated_timings: hasEstimated,
    },
  };
}
