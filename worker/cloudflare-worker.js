/**
 * Cloudflare Worker — bezpieczny pośrednik między stroną WWW a:
 *   1. ElevenLabs Scribe v2 (najwyższa dokładność po polsku, brak halucynacji w ciszy)
 *   2. Groq Whisper API (whisper-large-v3 / whisper-large-v3-turbo)
 *
 * Zmienne (Settings -> Runtime variables and secrets -> Production):
 *   - ELEVENLABS_API_KEY (Secret) — klucz API z https://elevenlabs.io/app/settings/api-keys
 *   - GROQ_API_KEY       (Secret) — klucz API z https://console.groq.com/keys
 *   - ACCESS_CODE        (Secret) — opcjonalne hasło dostępu dla testerów
 *   - ALLOWED_ORIGIN     (Text)   — opcjonalnie np. https://twoj-nick.github.io
 */

const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODELS = new Set(["whisper-large-v3", "whisper-large-v3-turbo"]);
const ELEVEN_MODELS = new Set(["scribe_v2", "scribe_v1"]);

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

async function handleElevenLabs(incomingForm, env, model, language, prompt, cors) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonResponse(
      { error: "Brak zmiennej ELEVENLABS_API_KEY w ustawieniach Cloudflare Workera." },
      500,
      cors
    );
  }

  const file = incomingForm.get("file");
  const outForm = new FormData();
  outForm.append("file", file);
  outForm.append("model_id", model);
  outForm.append("timestamps_granularity", "word");
  outForm.append("tag_audio_events", "false");
  outForm.append("diarize", "false");

  if (language && language !== "auto") {
    outForm.append("language_code", language);
  }

  // Słownik własnych terminów (keyterms wspierane przez scribe_v2: maks. 50 znaków i 5 słów na termin)
  if (prompt && model === "scribe_v2") {
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
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
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
  // Znormalizuj słowa z ElevenLabs (filtruj spacing i audio_event) do wspólnego formatu
  const words = (raw.words || [])
    .filter((w) => w && (w.type === "word" || !w.type) && String(w.text || "").trim())
    .map((w) => ({
      word: String(w.text).trim(),
      start: Number(w.start ?? 0),
      end: Number(w.end ?? w.start ?? 0),
    }));

  const normalized = {
    provider: "elevenlabs",
    model,
    language: raw.language_code || language || "auto",
    text: raw.text || words.map((w) => w.word).join(" "),
    words,
    segments: words.length
      ? [
          {
            start: words[0].start,
            end: words[words.length - 1].end,
            text: raw.text || words.map((w) => w.word).join(" "),
            words,
          },
        ]
      : [],
  };

  return jsonResponse(normalized, 200, cors);
}

async function handleGroq(incomingForm, env, model, language, prompt, cors) {
  if (!env.GROQ_API_KEY) {
    return jsonResponse(
      { error: "Brak zmiennej GROQ_API_KEY w ustawieniach Cloudflare Workera." },
      500,
      cors
    );
  }

  const file = incomingForm.get("file");
  const outForm = new FormData();
  outForm.append("file", file);
  outForm.append("model", model);
  outForm.append("response_format", "verbose_json");
  outForm.append("timestamp_granularities[]", "word");
  outForm.append("timestamp_granularities[]", "segment");
  outForm.append("temperature", "0");

  if (language && language !== "auto") {
    outForm.append("language", language);
  }
  if (prompt) {
    outForm.append("prompt", prompt.slice(0, 800));
  }

  const groqResp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: outForm,
  });

  const body = await groqResp.text();
  return new Response(body, {
    status: groqResp.status,
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
          elevenlabs_configured: Boolean(env.ELEVENLABS_API_KEY),
          groq_configured: Boolean(env.GROQ_API_KEY),
          access_code_required: Boolean(env.ACCESS_CODE),
        },
        200,
        cors
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
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

      const rawModel = String(incomingForm.get("model") || "scribe_v2").trim();
      const language = String(incomingForm.get("language") || "").trim();
      const prompt = String(incomingForm.get("prompt") || "").trim();

      if (ELEVEN_MODELS.has(rawModel)) {
        return await handleElevenLabs(incomingForm, env, rawModel, language, prompt, cors);
      }

      const groqModel = GROQ_MODELS.has(rawModel) ? rawModel : "whisper-large-v3";
      return await handleGroq(incomingForm, env, groqModel, language, prompt, cors);
    } catch (err) {
      return jsonResponse({ error: String(err?.message || err) }, 500, cors);
    }
  },
};
