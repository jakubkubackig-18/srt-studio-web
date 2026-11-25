import {
  attachGroqWordsToSegments,
  filterHallucinations,
  fmtTsSrt,
  formatSubtitles,
  parseSrtToWords,
  renderSrt,
  renderTxt,
  segmentsToWords,
} from "./srt-engine.js";
import { prepareAudioChunks } from "./audio-prep.js";

const DEMO_SRT = `1
00:00:00,000 --> 00:00:07,200
Jeśli czeka Cię seria rezonansów magnetycznych, szczególnie w obszarze głowy i szyi, koniecznie porozmawiaj o tym ze swoim ortodontą.

2
00:00:07,200 --> 00:00:13,400
W przypadku leczenia wady twarzy czaszki oraz chirurgii ortodonatycznej bardzo ważna jest też pełna diagnostyka, w tym polisomnografia i analiza IBMI.

3
00:00:13,400 --> 00:00:14,600
aparatem.

4
00:00:21,500 --> 00:00:24,200
Dziękuję za uwagę i do zobaczenia w kolejnym odcinku!
`;

const GROQ_DIRECT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const cfg = window.SRT_STUDIO_CONFIG || {};
const WORKER_URL = (cfg.WORKER_URL || "").trim().replace(/\/+$/, "");
const REQUIRE_ACCESS_CODE = Boolean(cfg.REQUIRE_ACCESS_CODE);

const state = {
  inputMode: "audio",
  audioFile: null,
  audioObjectUrl: null,
  srtFile: null,
  variant: "horizontal",
  verticalLines: 1,
  customLines: 1,
  baseName: "napisy",
  originalFileName: "napisy.srt",
  accessCode: "",
  words: null,
  removedHallucinations: [],
  sourceHadBold: false,
  result: null,
  editedCues: null,
  selectedCueIndex: 0,
};

const $ = (id) => document.getElementById(id);

const els = {
  brandHomeLink: $("brandHomeLink"),
  landingNav: $("landingNav"),
  connectionBadge: $("connectionBadge"),
  loadDemoBtn: $("loadDemoBtn"),
  footerDemoBtn: $("footerDemoBtn"),
  newFileTopBtn: $("newFileTopBtn"),
  backToUploadBtn: $("backToUploadBtn"),
  landingView: $("landingView"),
  workspaceView: $("workspaceView"),
  audioInputPanel: $("audioInputPanel"),
  audioDropzone: $("audioDropzone"),
  audioFileInput: $("audioFileInput"),
  audioDropTitle: $("audioDropTitle"),
  audioDropSub: $("audioDropSub"),
  heroVariantSelector: $("heroVariantSelector"),
  groqKeyField: $("groqKeyField"),
  groqKeyInput: $("groqKeyInput"),
  accessModal: $("accessModal"),
  accessModalForm: $("accessModalForm"),
  accessModalInput: $("accessModalInput"),
  accessModalError: $("accessModalError"),
  accessRememberCheck: $("accessRememberCheck"),
  accessModalCancel: $("accessModalCancel"),
  languageSelect: $("languageSelect"),
  modelSelect: $("modelSelect"),
  promptInput: $("promptInput"),
  startTranscribeBtn: $("startTranscribeBtn"),
  progressBox: $("progressBox"),
  progressText: $("progressText"),
  progressPct: $("progressPct"),
  progressBar: $("progressBar"),
  // Workspace elements
  wsFileName: $("wsFileName"),
  variantSelector: $("variantSelector"),
  toggleParamsBtn: $("toggleParamsBtn"),
  toggleFixesBtn: $("toggleFixesBtn"),
  paramsDrawer: $("paramsDrawer"),
  fixesDrawer: $("fixesDrawer"),
  paramsHorizontal: $("paramsHorizontal"),
  paramsVertical: $("paramsVertical"),
  paramsCustom: $("paramsCustom"),
  hMaxWords: $("hMaxWords"),
  hMaxWordsVal: $("hMaxWordsVal"),
  hMinDur: $("hMinDur"),
  hMinDurVal: $("hMinDurVal"),
  hMaxHold: $("hMaxHold"),
  hMaxHoldVal: $("hMaxHoldVal"),
  hBoldMode: $("hBoldMode"),
  vLinesToggle: $("vLinesToggle"),
  vMaxChars: $("vMaxChars"),
  vMaxCharsVal: $("vMaxCharsVal"),
  vMaxHold: $("vMaxHold"),
  vMaxHoldVal: $("vMaxHoldVal"),
  vBoldCheck: $("vBoldCheck"),
  cLinesToggle: $("cLinesToggle"),
  cMaxWords: $("cMaxWords"),
  cMaxWordsVal: $("cMaxWordsVal"),
  cNoGapsCheck: $("cNoGapsCheck"),
  cBoldCheck: $("cBoldCheck"),
  twoLetterOrphansCheck: $("twoLetterOrphansCheck"),
  fixesInput: $("fixesInput"),
  applyFixesBtn: $("applyFixesBtn"),
  liveSyncStatus: $("liveSyncStatus"),
  statCues: $("statCues"),
  statWords: $("statWords"),
  statDuration: $("statDuration"),
  statCompleteness: $("statCompleteness"),
  statWarningsPill: $("statWarningsPill"),
  statWarnings: $("statWarnings"),
  downloadSrtBtn: $("downloadSrtBtn"),
  downloadTxtBtn: $("downloadTxtBtn"),
  downloadTxtPlainBtn: $("downloadTxtPlainBtn"),
  copySrtBtn: $("copySrtBtn"),
  audioPlayerCard: $("audioPlayerCard"),
  audioPlayer: $("audioPlayer"),
  monitorMeta: $("monitorMeta"),
  monitorFrame: $("monitorFrame"),
  monitorSubtitle: $("monitorSubtitle"),
  qaBadge: $("qaBadge"),
  qaList: $("qaList"),
  viewTabs: $("viewTabs"),
  viewEditor: $("viewEditor"),
  viewSrt: $("viewSrt"),
  viewTxt: $("viewTxt"),
  rawSrtPre: $("rawSrtPre"),
  rawTxtPre: $("rawTxtPre"),
  editedBadge: $("editedBadge"),
  resetEditsBtn: $("resetEditsBtn"),
  toast: $("toast"),
};

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(els.toast._t);
  els.toast._t = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function formatBytes(bytes) {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

function safeBaseName(filename) {
  const clean = String(filename || "napisy").replace(/\.[^.]+$/, "");
  return clean.replace(/[^\w\-.ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]+/g, "_").trim() || "napisy";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setProgress(msg, pct) {
  els.progressBox.style.display = "block";
  els.progressText.textContent = msg;
  els.progressPct.textContent = `${Math.round(pct)}%`;
  els.progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

// ── View switching (Landing <-> Workspace) ───────────────────────────────
function showWorkspaceView() {
  els.landingView.style.display = "none";
  els.workspaceView.style.display = "block";
  els.landingNav.style.display = "none";
  els.loadDemoBtn.style.display = "none";
  els.newFileTopBtn.style.display = "inline-flex";
  window.scrollTo(0, 0);
}

function showLandingView() {
  els.workspaceView.style.display = "none";
  els.landingView.style.display = "block";
  els.landingNav.style.display = "";
  els.loadDemoBtn.style.display = "inline-flex";
  els.newFileTopBtn.style.display = "none";
  els.progressBox.style.display = "none";
  window.scrollTo(0, 0);
}

// ── Init mode (Cloudflare Worker vs BYOK) ────────────────────────────────
function initConnectionMode() {
  if (WORKER_URL) {
    els.connectionBadge.textContent = "Chmura 24/7";
    els.groqKeyField.style.display = "none";
    const savedCode = localStorage.getItem("srt_studio_access_code");
    if (savedCode) state.accessCode = savedCode;
  } else {
    els.connectionBadge.textContent = "Tryb BYOK";
    els.groqKeyField.style.display = "flex";
    const savedKey = localStorage.getItem("srt_studio_groq_key");
    if (savedKey) els.groqKeyInput.value = savedKey;
  }
}

els.groqKeyInput.addEventListener("change", () => {
  localStorage.setItem("srt_studio_groq_key", els.groqKeyInput.value.trim());
});

// ── Access Code Modal (przed transkrypcją) ───────────────────────────────
function openAccessModal(errorMsg = "") {
  els.accessModalError.textContent = errorMsg;
  els.accessModalError.style.display = errorMsg ? "block" : "none";
  els.accessModalInput.value = "";
  els.accessModal.style.display = "grid";
  requestAnimationFrame(() => els.accessModalInput.focus());
}

function closeAccessModal() {
  els.accessModal.style.display = "none";
}

els.accessModalCancel.addEventListener("click", closeAccessModal);
els.accessModal.addEventListener("click", (e) => {
  if (e.target === els.accessModal) closeAccessModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.accessModal.style.display !== "none") {
    closeAccessModal();
  }
});

els.accessModalForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const entered = els.accessModalInput.value.trim();
  if (!entered) {
    els.accessModalError.textContent = "Wpisz hasło dostępu.";
    els.accessModalError.style.display = "block";
    return;
  }
  state.accessCode = entered;
  if (els.accessRememberCheck.checked) {
    localStorage.setItem("srt_studio_access_code", entered);
  } else {
    localStorage.removeItem("srt_studio_access_code");
  }
  closeAccessModal();
  startAudioTranscription();
});

// ── Options & Variant Sync ───────────────────────────────────────────────
function collectFormatOptions() {
  let boldMode = "auto";
  if (state.variant === "horizontal") boldMode = els.hBoldMode.value;
  else if (state.variant === "vertical") boldMode = els.vBoldCheck.checked ? "yes" : "no";
  else boldMode = els.cBoldCheck.checked ? "yes" : "no";

  const maxHold =
    state.variant === "vertical"
      ? parseFloat(els.vMaxHold.value)
      : parseFloat(els.hMaxHold.value);

  return {
    variant: state.variant,
    maxWords: parseInt(els.hMaxWords.value, 10),
    minDur: parseFloat(els.hMinDur.value),
    maxHold,
    verticalLines: state.verticalLines,
    verticalChars: parseInt(els.vMaxChars.value, 10),
    customLines: state.customLines,
    customWordsPerLine: parseInt(els.cMaxWords.value, 10),
    customNoGaps: els.cNoGapsCheck.checked,
    boldMode,
    sourceHadBold: state.sourceHadBold,
    includeTwoLetterOrphans: els.twoLetterOrphansCheck.checked,
    fixesText: els.fixesInput.value,
    removedHallucinations: state.removedHallucinations,
  };
}

function setVariant(v, triggerReformat = true) {
  state.variant = v;
  els.heroVariantSelector.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.variant === v);
  });
  els.variantSelector.querySelectorAll(".vpill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.variant === v);
  });
  els.paramsHorizontal.style.display = v === "horizontal" ? "flex" : "none";
  els.paramsVertical.style.display = v === "vertical" ? "flex" : "none";
  els.paramsCustom.style.display = v === "custom" ? "flex" : "none";
  if (triggerReformat && state.words) {
    reformatLive();
  }
}

function reformatLive() {
  if (!state.words) return;
  const t0 = performance.now();
  state.result = formatSubtitles(state.words, collectFormatOptions());
  state.editedCues = null;
  els.editedBadge.style.display = "none";
  renderResults();
  const dt = Math.max(1, Math.round(performance.now() - t0));
  els.liveSyncStatus.textContent = `Przeliczono na żywo (${dt} ms)`;
}

// ── Cloud Audio Transcription ────────────────────────────────────────────
async function transcribeChunk(chunk, { model, language, prompt, apiKey, accessCode }) {
  const form = new FormData();
  form.append("file", chunk.blob, chunk.filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (language && language !== "auto") form.append("language", language);
  if (prompt) form.append("prompt", prompt);

  const endpoint = WORKER_URL || GROQ_DIRECT_URL;
  const headers = {};
  if (WORKER_URL) {
    if (accessCode) headers["X-Access-Code"] = accessCode;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, { method: "POST", headers, body: form });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => res.statusText);
    if (res.status === 401 || res.status === 403) {
      const authErr = new Error(
        WORKER_URL
          ? "Nieprawidłowe hasło dostępu — spróbuj ponownie."
          : "Nieprawidłowy klucz Groq API (sprawdź klucz z console.groq.com)."
      );
      authErr.isAuthError = true;
      throw authErr;
    }
    throw new Error(`Błąd API (${res.status}): ${bodyText.slice(0, 240)}`);
  }
  return res.json();
}

async function startAudioTranscription() {
  if (!state.audioFile) return;

  const apiKey = els.groqKeyInput.value.trim();

  if (!WORKER_URL && !apiKey) {
    showToast("Wpisz swój klucz Groq API (console.groq.com) lub skonfiguruj WORKER_URL.");
    els.groqKeyInput.focus();
    return;
  }
  if (WORKER_URL && REQUIRE_ACCESS_CODE && !state.accessCode) {
    openAccessModal();
    return;
  }

  const accessCode = state.accessCode;

  els.startTranscribeBtn.disabled = true;
  setProgress("Przygotowanie pliku audio…", 10);

  try {
    const chunks = await prepareAudioChunks(state.audioFile, setProgress);
    const model = els.modelSelect.value;
    const language = els.languageSelect.value;
    const prompt = els.promptInput.value.trim();

    const allSegments = [];
    for (let i = 0; i < chunks.length; i++) {
      const pctBase = 32 + Math.round((i / chunks.length) * 55);
      const label =
        chunks.length > 1
          ? `Transkrypcja fragmentu ${i + 1}/${chunks.length}…`
          : `Transkrypcja audio (Groq Whisper)…`;
      setProgress(label, pctBase);

      const payload = await transcribeChunk(chunks[i], {
        model,
        language,
        prompt,
        apiKey,
        accessCode,
      });
      allSegments.push(...attachGroqWordsToSegments(payload, chunks[i].offsetSec));
    }

    setProgress("Filtrowanie halucynacji i budowanie napisów…", 92);

    const nonEmpty = allSegments.filter((s) => String(s.text || "").trim());
    const { cleaned, removed } = filterHallucinations(nonEmpty);
    const words = segmentsToWords(cleaned);

    if (!words.length) throw new Error("Nie wykryto mowy w przesłanym pliku.");

    state.originalFileName = state.audioFile.name;
    state.baseName = safeBaseName(state.audioFile.name);
    state.words = words;
    state.removedHallucinations = removed;
    state.sourceHadBold = false;
    state.selectedCueIndex = 0;

    if (state.audioObjectUrl) URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = URL.createObjectURL(state.audioFile);

    setProgress("Gotowe!", 100);
    reformatLive();
    showWorkspaceView();
    showToast(`Gotowe! Wygenerowano ${state.result.report.cue_count} napisów.`);
  } catch (err) {
    if (err?.isAuthError && WORKER_URL) {
      state.accessCode = "";
      localStorage.removeItem("srt_studio_access_code");
      els.progressBox.style.display = "none";
      openAccessModal(err.message);
    } else {
      setProgress(`Błąd: ${err.message}`, 0);
      showToast(err.message);
    }
  } finally {
    els.startTranscribeBtn.disabled = false;
  }
}

// ── Demo SRT Loader (wewnętrzny podgląd przykładowy) ─────────────────────
function loadDemoSrt(srtContent, fname) {
  const { words, hadBold } = parseSrtToWords(srtContent);
  if (!words.length) return;

  state.originalFileName = fname;
  state.baseName = safeBaseName(fname);
  state.words = words;
  state.removedHallucinations = [];
  state.sourceHadBold = hadBold;
  state.selectedCueIndex = 0;

  if (state.audioObjectUrl) {
    URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = null;
  }

  reformatLive();
  showWorkspaceView();
  showToast(`Załadowano demo (${state.result.report.cue_count} napisów)`);
}

// ── Rendering Workspace ──────────────────────────────────────────────────
function getActiveCues() {
  return state.editedCues || state.result?.cues || [];
}

function renderResults() {
  if (!state.result) return;
  const report = state.result.report;
  const cues = getActiveCues();

  els.wsFileName.textContent = state.originalFileName;
  els.statCues.textContent = cues.length;
  els.statWords.textContent = report.word_count;
  els.statDuration.textContent = report.total_duration_str;
  els.statCompleteness.textContent = report.completeness_ok ? "✓ 100% słów" : "⚠ Sprawdź słowa";
  els.statCompleteness.className = report.completeness_ok ? "pill-ok" : "pill-warn";

  if (report.warnings_count > 0) {
    els.statWarningsPill.style.display = "inline";
    els.statWarnings.textContent = report.warnings_count;
  } else {
    els.statWarningsPill.style.display = "none";
  }

  const suffixMap = { horizontal: "poziom", vertical: "pion", custom: "wlasny" };
  els.downloadSrtBtn.textContent = `Pobierz _${suffixMap[state.variant]}.srt`;

  if (state.audioObjectUrl) {
    els.audioPlayerCard.style.display = "block";
    if (els.audioPlayer.src !== state.audioObjectUrl) {
      els.audioPlayer.src = state.audioObjectUrl;
    }
  } else {
    els.audioPlayerCard.style.display = "none";
  }

  const isVert = state.variant === "vertical";
  els.monitorFrame.className = `monitor-frame ${isVert ? "ratio-9-16" : "ratio-16-9"}`;

  renderQAReport(report);
  renderCueEditor(cues, state.result.use_bold);
  renderRawViews(cues, state.result.use_bold);
  selectCue(Math.min(state.selectedCueIndex, Math.max(0, cues.length - 1)));
}

function renderQAReport(report) {
  const items = [];

  if (report.warnings.length === 0) {
    els.qaBadge.textContent = "Wszystko OK";
    els.qaBadge.className = "qa-pill qa-ok";
    items.push({
      type: "ok",
      text: "Brak błędów limitu znaków, sierot ani zbyt krótkich cue.",
      tc: "QA",
    });
  } else {
    els.qaBadge.textContent = `${report.warnings.length} do sprawdzenia`;
    els.qaBadge.className = "qa-pill qa-warn";
    for (const w of report.warnings) {
      items.push({
        type: "warn",
        text: `Cue #${w.cue_index}: ${w.message}`,
        tc: w.timecode.slice(0, 8),
        cueIndex: w.cue_index - 1,
      });
    }
  }

  if (report.applied_fixes?.length) {
    const txt = report.applied_fixes.map((f) => `„${f.from}” → „${f.to}” (×${f.count})`).join(", ");
    items.push({ type: "ok", text: `Korekty: ${txt}`, tc: "FIX" });
  }

  if (report.unmatched_fixes?.length) {
    const txt = report.unmatched_fixes.map((f) => `„${f.from}”`).join(", ");
    items.push({ type: "warn", text: `Nie znaleziono w tekście: ${txt}`, tc: "FIX" });
  }

  if (report.silences?.length) {
    for (const s of report.silences) {
      items.push({
        type: "info",
        text: `Długa cisza (${s.duration.toFixed(1)} s) — ${s.note}`,
        tc: `${s.start_srt.slice(0, 8)}–${s.end_srt.slice(0, 8)}`,
      });
    }
  }

  if (report.removed_hallucinations?.length) {
    items.push({
      type: "info",
      text: `Odfiltrowano halucynacji Whispera: ${report.removed_hallucinations.length}`,
      tc: "ASR",
    });
  }

  if (report.estimated_timings) {
    items.push({
      type: "info",
      text: "Czasy cięć w środku oryginalnych linii są szacowane proporcjonalnie — sprawdź na timeline (25 fps).",
      tc: "INFO",
    });
  }

  els.qaList.innerHTML = "";
  for (const it of items) {
    const div = document.createElement("div");
    div.className = `qa-item qa-type-${it.type}${it.cueIndex !== undefined ? " clickable" : ""}`;
    div.innerHTML = `<span>${escapeHtml(it.text)}</span><span class="qa-tc">${escapeHtml(it.tc)}</span>`;
    if (it.cueIndex !== undefined) {
      div.addEventListener("click", () => {
        selectCue(it.cueIndex);
        const row = els.viewEditor.querySelector(`[data-idx="${it.cueIndex}"]`);
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    els.qaList.appendChild(div);
  }
}

function renderCueEditor(cues, useBold) {
  els.viewEditor.innerHTML = "";
  const isVert = state.variant === "vertical";
  const isHoriz = state.variant === "horizontal";
  const maxCharsLimit = parseInt(els.vMaxChars.value, 10);
  const minDurLimit = parseFloat(els.hMinDur.value);

  cues.forEach((cue, idx) => {
    const row = document.createElement("div");
    row.className = `cue-row${cue.warnings?.length ? " has-warn" : ""}${idx === state.selectedCueIndex ? " active-cue" : ""}`;
    row.dataset.idx = String(idx);

    const durShort = isHoriz && cue.duration < minDurLimit - 0.05;
    const maxLineLen = Math.max(...cue.text.split("\n").map((l) => l.length), 0);
    const wordCnt = cue.text.trim() ? cue.text.trim().split(/\s+/).length : 0;
    const charsOver = isVert && maxLineLen > maxCharsLimit;

    row.innerHTML = `
      <div class="cue-num">
        <span>#${idx + 1}</span>
        ${state.audioObjectUrl ? `<button type="button" class="play-cue-btn" title="Odtwórz od tego momentu">▶</button>` : ""}
      </div>
      <div class="cue-times">
        <span>${fmtTsSrt(cue.start)}</span>
        <span>→ ${fmtTsSrt(cue.end)}</span>
        <span class="cue-dur${durShort ? " short" : ""}">${cue.duration.toFixed(2)} s</span>
      </div>
      <textarea class="cue-editor-input" rows="${Math.max(1, cue.text.split("\n").length)}">${escapeHtml(cue.text)}</textarea>
      <div class="cue-meta">
        <span class="meta-pill">${wordCnt} sł.</span>
        <span class="meta-pill${charsOver ? " over" : ""}">${maxLineLen} zn.</span>
        ${useBold ? `<span class="meta-pill">&lt;b&gt;</span>` : ""}
      </div>
      ${cue.warnings?.length ? `<div class="cue-warn-msg">⚠ ${escapeHtml(cue.warnings.join(" · "))}</div>` : ""}
    `;

    row.addEventListener("click", () => selectCue(idx));

    const playBtn = row.querySelector(".play-cue-btn");
    if (playBtn) {
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectCue(idx);
        els.audioPlayer.currentTime = Math.max(0, cue.start);
        els.audioPlayer.play();
      });
    }

    const ta = row.querySelector(".cue-editor-input");
    const autoSizeTa = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", () => {
      if (!state.editedCues) {
        state.editedCues = state.result.cues.map((c) => ({ ...c }));
      }
      state.editedCues[idx].text = ta.value;
      autoSizeTa();
      els.editedBadge.style.display = "inline-flex";
      updateMonitor(idx);
      renderRawViews(state.editedCues, state.result.use_bold);
    });

    els.viewEditor.appendChild(row);
    requestAnimationFrame(autoSizeTa);
  });
}

function selectCue(idx) {
  state.selectedCueIndex = idx;
  els.viewEditor.querySelectorAll(".cue-row").forEach((r) => {
    r.classList.toggle("active-cue", Number(r.dataset.idx) === idx);
  });
  updateMonitor(idx);
}

function updateMonitor(idx) {
  const cues = getActiveCues();
  const cue = cues[idx];
  const ratioLabel =
    state.variant === "vertical"
      ? "9:16 PION"
      : state.variant === "horizontal"
      ? "16:9 POZIOM"
      : "WŁASNY";
  if (!cue) {
    els.monitorSubtitle.textContent = "Brak napisu";
    els.monitorMeta.textContent = ratioLabel;
    return;
  }
  els.monitorMeta.textContent = `${ratioLabel} · #${idx + 1} (${cue.duration.toFixed(1)}s)`;
  els.monitorSubtitle.textContent = cue.text;
  els.monitorSubtitle.classList.toggle("is-bold", Boolean(state.result?.use_bold));
}

function renderRawViews(cues, useBold) {
  els.rawSrtPre.textContent = renderSrt(cues, useBold);
  els.rawTxtPre.textContent = renderTxt(cues, true);
}

function downloadFile(content, filename, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Pobrano: ${filename}`);
}

function exportFormat(fmt) {
  if (!state.result) return;
  const cues = getActiveCues();
  const useBold = Boolean(state.result.use_bold);
  const suffixMap = { horizontal: "poziom", vertical: "pion", custom: "wlasny" };

  if (fmt === "srt") {
    downloadFile(
      renderSrt(cues, useBold),
      `${state.baseName}_${suffixMap[state.variant]}.srt`,
      "application/x-subrip;charset=utf-8"
    );
  } else if (fmt === "txt") {
    downloadFile(renderTxt(cues, true), `${state.baseName}-transcript.txt`);
  } else {
    downloadFile(renderTxt(cues, false), `${state.baseName}-tekst.txt`);
  }
}

// ── Dropzones & Events ───────────────────────────────────────────────────
function bindDropzone(zoneEl, inputEl, onFile) {
  zoneEl.addEventListener("click", () => inputEl.click());
  zoneEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputEl.click();
    }
  });
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    zoneEl.classList.add("drag-over");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("drag-over"));
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.classList.remove("drag-over");
    if (e.dataTransfer.files?.length) onFile(e.dataTransfer.files[0]);
  });
  inputEl.addEventListener("change", () => {
    if (inputEl.files?.length) onFile(inputEl.files[0]);
  });
}

bindDropzone(els.audioDropzone, els.audioFileInput, (file) => {
  state.audioFile = file;
  els.audioDropzone.classList.add("has-file");
  els.audioDropTitle.textContent = `✓ ${file.name}`;
  els.audioDropSub.textContent = `${formatBytes(file.size)} · gotowy do transkrypcji`;
  els.startTranscribeBtn.disabled = false;
});

els.heroVariantSelector.addEventListener("click", (e) => {
  const btn = e.target.closest(".tier-btn");
  if (btn) setVariant(btn.dataset.variant, false);
});

els.variantSelector.addEventListener("click", (e) => {
  const btn = e.target.closest(".vpill");
  if (btn) setVariant(btn.dataset.variant, true);
});

// Drawers (Dostosuj zasady / Korekty --fix)
els.toggleParamsBtn.addEventListener("click", () => {
  const open = els.paramsDrawer.style.display === "none";
  els.paramsDrawer.style.display = open ? "block" : "none";
  els.fixesDrawer.style.display = "none";
  els.toggleParamsBtn.classList.toggle("active-toggle", open);
  els.toggleFixesBtn.classList.remove("active-toggle");
});

els.toggleFixesBtn.addEventListener("click", () => {
  const open = els.fixesDrawer.style.display === "none";
  els.fixesDrawer.style.display = open ? "block" : "none";
  els.paramsDrawer.style.display = "none";
  els.toggleFixesBtn.classList.toggle("active-toggle", open);
  els.toggleParamsBtn.classList.remove("active-toggle");
});

els.startTranscribeBtn.addEventListener("click", startAudioTranscription);

// Navigation back to upload
els.backToUploadBtn.addEventListener("click", showLandingView);
els.newFileTopBtn.addEventListener("click", showLandingView);
els.brandHomeLink.addEventListener("click", (e) => {
  e.preventDefault();
  showLandingView();
});

// Live parameter controls
els.hMaxWords.addEventListener("input", () => {
  els.hMaxWordsVal.textContent = els.hMaxWords.value;
  reformatLive();
});
els.hMinDur.addEventListener("input", () => {
  els.hMinDurVal.textContent = `${parseFloat(els.hMinDur.value).toFixed(1)} s`;
  reformatLive();
});
els.hMaxHold.addEventListener("input", () => {
  els.hMaxHoldVal.textContent = `${parseFloat(els.hMaxHold.value).toFixed(1)} s`;
  els.vMaxHold.value = els.hMaxHold.value;
  els.vMaxHoldVal.textContent = els.hMaxHoldVal.textContent;
  reformatLive();
});
els.hBoldMode.addEventListener("change", reformatLive);

els.vLinesToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".mini-seg-btn");
  if (!btn) return;
  state.verticalLines = parseInt(btn.dataset.val, 10);
  els.vLinesToggle.querySelectorAll(".mini-seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  reformatLive();
});

els.vMaxChars.addEventListener("input", () => {
  els.vMaxCharsVal.textContent = `${els.vMaxChars.value} zn.`;
  document.querySelectorAll('.preset-btn[data-target="vMaxChars"]').forEach((b) => {
    b.classList.toggle("active", b.dataset.val === els.vMaxChars.value);
  });
  reformatLive();
});
els.vMaxHold.addEventListener("input", () => {
  els.vMaxHoldVal.textContent = `${parseFloat(els.vMaxHold.value).toFixed(1)} s`;
  els.hMaxHold.value = els.vMaxHold.value;
  els.hMaxHoldVal.textContent = els.vMaxHoldVal.textContent;
  reformatLive();
});
els.vBoldCheck.addEventListener("change", reformatLive);

els.cLinesToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".mini-seg-btn");
  if (!btn) return;
  state.customLines = parseInt(btn.dataset.val, 10);
  els.cLinesToggle.querySelectorAll(".mini-seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  reformatLive();
});

els.cMaxWords.addEventListener("input", () => {
  const n = parseInt(els.cMaxWords.value, 10);
  const suf = n === 1 ? "słowo" : n <= 4 ? "słowa" : "słów";
  els.cMaxWordsVal.textContent = `${n} ${suf}`;
  document.querySelectorAll('.preset-btn[data-target="cMaxWords"]').forEach((b) => {
    b.classList.toggle("active", b.dataset.val === els.cMaxWords.value);
  });
  reformatLive();
});
els.cNoGapsCheck.addEventListener("change", reformatLive);
els.cBoldCheck.addEventListener("change", reformatLive);
els.twoLetterOrphansCheck.addEventListener("change", reformatLive);

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = $(btn.dataset.target);
    if (!target) return;
    target.value = btn.dataset.val;
    target.dispatchEvent(new Event("input"));
  });
});

els.applyFixesBtn.addEventListener("click", () => {
  if (state.words) {
    reformatLive();
    showToast("Zastosowano korekty transkryptu");
  }
});

els.viewTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".mini-seg-btn");
  if (!btn) return;
  const v = btn.dataset.view;
  els.viewTabs.querySelectorAll(".mini-seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  els.viewEditor.style.display = v === "editor" ? "flex" : "none";
  els.viewSrt.style.display = v === "srt" ? "block" : "none";
  els.viewTxt.style.display = v === "txt" ? "block" : "none";
});

els.resetEditsBtn.addEventListener("click", () => {
  state.editedCues = null;
  els.editedBadge.style.display = "none";
  renderResults();
  showToast("Przywrócono automatyczny podział");
});

els.downloadSrtBtn.addEventListener("click", () => exportFormat("srt"));
els.downloadTxtBtn.addEventListener("click", () => exportFormat("txt"));
els.downloadTxtPlainBtn.addEventListener("click", () => exportFormat("txt_plain"));
els.copySrtBtn.addEventListener("click", async () => {
  if (!state.result) return;
  await navigator.clipboard.writeText(renderSrt(getActiveCues(), Boolean(state.result.use_bold)));
  showToast("Skopiowano SRT do schowka");
});

els.audioPlayer.addEventListener("timeupdate", () => {
  const cues = getActiveCues();
  if (!cues.length) return;
  const t = els.audioPlayer.currentTime;
  const found = cues.findIndex((c) => t >= c.start && t <= c.end);
  if (found !== -1 && found !== state.selectedCueIndex) {
    selectCue(found);
  }
});

function loadDemo() {
  els.fixesInput.value =
    "IBMI. => i BMI.\ntwarzy czaszki => twarzoczaszki\nortodonatycznej => ortognatycznej";
  setVariant("vertical", false);
  loadDemoSrt(DEMO_SRT, "demo_ortodonta.srt");
}

els.loadDemoBtn.addEventListener("click", loadDemo);
els.footerDemoBtn.addEventListener("click", loadDemo);

// Boot
initConnectionMode();
