/**
 * Cloudflare Worker — bezpieczny pośrednik między stroną WWW a ElevenLabs Scribe v2.
 *
 * Zmienne (Settings -> Runtime variables and secrets -> Production):
 *   - ELEVENLABS_API_KEY (Secret) — klucz API z https://elevenlabs.io/app/settings/api-keys
 *   - ACCESS_CODE        (Secret) — opcjonalne hasło dostępu dla testerów
 *   - ALLOWED_ORIGIN     (Text)   — opcjonalnie np. https://jakubkubackig-18.github.io
 */

const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL_ID = "scribe_v2";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "*";
  const allowed = (env.ALLOWED_ORIGIN || "*").trim();
  const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : allowed;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET") {
      return jsonResponse(
        {
          status: "ok",
          service: "srt-studio-worker",
          provider: "elevenlabs",
          model: MODEL_ID,
          elevenlabs_configured: Boolean(env.ELEVENLABS_API_KEY),
          access_code_required: Boolean(env.ACCESS_CODE),
        },
        200,
        cors
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    if (!env.ELEVENLABS_API_KEY) {
      return jsonResponse(
        { error: "Brak zmiennej ELEVENLABS_API_KEY w ustawieniach Cloudflare Workera." },
        500,
        cors
      );
    }

    if (env.ACCESS_CODE) {
      const provided = (request.headers.get("X-Access-Code") || "").trim();
      if (provided !== env.ACCESS_CODE.trim()) {
        return jsonResponse({ error: "Nieprawidłowe hasło dostępu." }, 401, cors);
      }
    }

    try {
      const incomingForm = await request.formData();
      const file = incomingForm.get("file");
      if (!file) {
        return jsonResponse({ error: "Brak pliku audio w polu 'file'." }, 400, cors);
      }

      const language = String(incomingForm.get("language") || "").trim();
      const prompt = String(incomingForm.get("prompt") || "").trim();

      const outForm = new FormData();
      outForm.append("file", file);
      outForm.append("model_id", MODEL_ID);
      outForm.append("timestamps_granularity", "word");
      outForm.append("tag_audio_events", "false");
      outForm.append("diarize", "false");

      if (language && language !== "auto") {
        outForm.append("language_code", language);
      }

      if (prompt) {
        const terms = prompt
          .split(/[,;\n]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2 && t.length <= 50 && t.split(/\s+/).length <= 5)
          .slice(0, 100);
        for (const term of terms) {
          outForm.append("keyterms", term);
        }
      }

      const resp = await fetch(ELEVENLABS_URL, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        body: outForm,
      });

      const textBody = await resp.text();
      if (!resp.ok) {
        return new Response(textBody, {
          status: resp.status,
          headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
        });
      }

      const raw = JSON.parse(textBody);
      const rawWords = Array.isArray(raw.words) ? raw.words : [];
      const words = rawWords
        .filter((w) => {
          if (!w) return false;
          if (w.type === "spacing" || w.type === "audio_event") return false;
          return Boolean(String(w.text ?? w.word ?? "").trim());
        })
        .map((w) => ({
          word: String(w.text ?? w.word).trim(),
          start: Number(w.start ?? 0),
          end: Number(w.end ?? w.start ?? 0),
        }));

      const segments = [];
      if (words.length) {
        let buf = [];
        const flush = () => {
          if (!buf.length) return;
          segments.push({
            start: buf[0].start,
            end: buf[buf.length - 1].end,
            text: buf.map((x) => x.word).join(" "),
            words: buf,
          });
          buf = [];
        };
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          if (buf.length && (w.start - buf[buf.length - 1].end > 1.5 || buf.length >= 25)) {
            flush();
          }
          buf.push(w);
          if (/[.?!…]["'”»)\]]*$/.test(w.word)) {
            flush();
          }
        }
        flush();
      } else if (String(raw.text || "").trim()) {
        segments.push({
          start: 0,
          end: 1,
          text: String(raw.text).trim(),
          words: [],
        });
      }

      return jsonResponse(
        {
          provider: "elevenlabs",
          model: MODEL_ID,
          language: raw.language_code || language || "auto",
          text: raw.text || words.map((w) => w.word).join(" "),
          words,
          segments,
          meta: {
            raw_words_count: rawWords.length,
            kept_words_count: words.length,
            text_length: String(raw.text || "").trim().length,
          },
        },
        200,
        cors
      );
    } catch (err) {
      return jsonResponse({ error: String(err?.message || err) }, 500, cors);
    }
  },
};
