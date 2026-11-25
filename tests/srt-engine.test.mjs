import test from "node:test";
import assert from "node:assert/strict";
import {
  attachGroqWordsToSegments,
  filterHallucinations,
  formatSubtitles,
  parseSrtToWords,
  segmentsToWords,
} from "../srt-engine.js";

test("PION 9:16 — dokładny przykład z ortodontą (1 linia, 16 znaków)", () => {
  const srt = `1
00:00:00,000 --> 00:00:08,000
Jeśli czeka Cię seria rezonansów magnetycznych, szczególnie w obszarze głowy i szyi, koniecznie porozmawiaj o tym ze swoim ortodontą.
`;
  const { words } = parseSrtToWords(srt);
  const res = formatSubtitles(words, {
    variant: "vertical",
    verticalLines: 1,
    verticalChars: 16,
    boldMode: "auto",
  });

  assert.deepEqual(
    res.cues.map((c) => c.text),
    [
      "Jeśli czeka Cię",
      "seria rezonansów",
      "magnetycznych,",
      "szczególnie",
      "w obszarze głowy",
      "i szyi,",
      "koniecznie",
      "porozmawiaj",
      "o tym ze swoim",
      "ortodontą.",
    ]
  );
  assert.equal(res.use_bold, true);
  assert.ok(res.srt.includes("<b>Jeśli czeka Cię</b>"));
  assert.equal(res.report.completeness_ok, true);
  assert.equal(res.report.warnings_count, 0);
});

test("PION 9:16 — długie wyrazy bez myślnika + raport QA", () => {
  const srt = `1
00:00:00,000 --> 00:00:04,000
Badamy insulinooporność oraz objawy ogólnoustrojowymi metodami.
`;
  const { words } = parseSrtToWords(srt);
  const res = formatSubtitles(words, {
    variant: "vertical",
    verticalLines: 1,
    verticalChars: 16,
  });

  const texts = res.cues.map((c) => c.text);
  assert.ok(texts.includes("insulinooporność"));
  assert.ok(texts.includes("ogólnoustrojowymi"));
  assert.ok(texts.every((t) => !t.includes("-")));
  assert.equal(res.report.completeness_ok, true);
  assert.ok(res.report.warnings.some((w) => w.message.includes("ogólnoustrojowymi")));
});

test("PION 9:16 — sierota przechodzi z następnym słowem nawet ponad limit", () => {
  const srt = `1
00:00:00,000 --> 00:00:04,000
Mówimy o polisomnografii dzisiaj.
`;
  const { words } = parseSrtToWords(srt);
  const res = formatSubtitles(words, {
    variant: "vertical",
    verticalLines: 1,
    verticalChars: 16,
  });
  assert.ok(res.cues.map((c) => c.text).includes("o polisomnografii"));
  assert.ok(res.report.warnings_count >= 1);
});

test("POZIOM 16:9 — maks. 13 słów, min. 2 s, 1 linia, cisza > 5 s", () => {
  const srt = `1
00:00:00,000 --> 00:00:01,200
Dzień dobry państwu.

2
00:00:01,300 --> 00:00:07,800
Dzisiaj omówimy bardzo szczegółowo wszystkie najważniejsze etapy przygotowania pacjenta do nowoczesnego leczenia ortodontycznego, ponieważ to wpływa na cały efekt końcowy.

3
00:00:16,500 --> 00:00:19,000
Dziękuję za uwagę.
`;
  const { words } = parseSrtToWords(srt);
  const res = formatSubtitles(words, {
    variant: "horizontal",
    maxWords: 13,
    minDur: 2.0,
    maxHold: 5.0,
  });

  assert.equal(res.report.completeness_ok, true);
  assert.equal(res.use_bold, false);
  assert.ok(res.cues.every((c) => c.lines.length === 1));
  assert.ok(res.cues.every((c) => c.word_count <= 13));
  assert.ok(res.cues.every((c) => c.duration >= 1.95));
  assert.equal(res.report.silences.length, 1);
  assert.ok(Math.abs(res.report.silences[0].start - 12.8) < 0.25);
});

test("Korekty --fix działają na granicach cue", () => {
  const srt = `1
00:00:00,000 --> 00:00:02,000
Badanie twarzy

2
00:00:02,000 --> 00:00:04,500
czaszki oraz IBMI.
`;
  const { words } = parseSrtToWords(srt);
  const res = formatSubtitles(words, {
    variant: "horizontal",
    fixesText: "twarzy czaszki => twarzoczaszki\nIBMI. => i BMI.",
  });
  assert.equal(res.txt_plain.trim(), "Badanie twarzoczaszki oraz i BMI.");
  assert.equal(res.report.applied_fixes.length, 2);
});

test("Filtr halucynacji i łączenie słów Groq z offsetem", () => {
  const segs = attachGroqWordsToSegments(
    {
      segments: [
        { start: 0.0, end: 2.0, text: "Napisy stworzone przez Amara.org" },
        { start: 2.0, end: 4.0, text: "tak tak tak tak tak" },
        { start: 4.0, end: 7.0, text: "Test działa poprawnie.", no_speech_prob: 0.05 },
      ],
      words: [
        { word: "Napisy", start: 0.0, end: 0.5 },
        { word: "Test", start: 4.0, end: 4.5 },
        { word: "działa", start: 4.5, end: 5.2 },
        { word: "poprawnie.", start: 5.2, end: 6.5 },
      ],
    },
    10.0
  );
  const { cleaned, removed } = filterHallucinations(segs);
  assert.equal(cleaned.length, 1);
  assert.equal(removed.length, 2);
  const words = segmentsToWords(cleaned);
  assert.equal(words[0].text, "Test");
  assert.equal(words[0].start, 14.0);
});

test("Polskie halucynacje filmowe (Jacek Makarewicz, prefiks Dzięki za oglądanie) + brak nakładania i rozciągniętych czasów", () => {
  const segs = [
    {
      start: 59.98,
      end: 63.0,
      text: "Dzięki za oglądanie! Niech to się nie zakończy.",
      words: [
        { word: "Dzięki", start: 59.98, end: 60.3 },
        { word: "za", start: 60.3, end: 60.5 },
        { word: "oglądanie!", start: 60.5, end: 60.9 },
        { word: "Niech", start: 61.0, end: 61.4 },
        { word: "to", start: 61.4, end: 61.6 },
        { word: "się", start: 61.6, end: 61.8 },
        { word: "nie", start: 61.8, end: 62.1 },
        { word: "zakończy.", start: 62.1, end: 62.8 },
      ],
    },
    { start: 181.0, end: 186.0, text: "Napisy by Jacek Makarewicz Dla" },
    { start: 231.0, end: 265.0, text: "Dzięki za oglądanie!" },
    {
      start: 270.0,
      end: 300.0,
      text: "Czekaj.",
      words: [{ word: "Czekaj.", start: 270.0, end: 299.5 }],
    },
    {
      start: 271.5,
      end: 273.5,
      text: "Chodź tutaj!",
      words: [
        { word: "Chodź", start: 271.5, end: 272.2 },
        { word: "tutaj!", start: 272.2, end: 273.0 },
      ],
    },
  ];
  const { cleaned, removed } = filterHallucinations(segs);
  assert.equal(cleaned.length, 3);
  assert.ok(removed.length >= 3);
  assert.equal(cleaned[0].text, "Niech to się nie zakończy.");

  const words = segmentsToWords(cleaned);
  const res = formatSubtitles(words, { variant: "horizontal", maxHold: 5.0 });
  // Zero nakładania się czasów
  for (let i = 0; i + 1 < res.cues.length; i++) {
    assert.ok(res.cues[i].end <= res.cues[i + 1].start + 0.001);
  }
  // Pojedyncze słowo "Czekaj." nie trwa 30 sekund
  assert.ok(res.cues.every((c) => c.duration <= 10.0));
});
