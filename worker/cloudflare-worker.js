/**
 * Cloudflare Worker — bezpieczny pośrednik między GitHub Pages a Groq Whisper API.
 *
 * Wdrożenie (2 minuty, bez instalowania narzędzi):
 * 1. Wejdź na https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
 * 2. Nazwij np. "srt-studio-api" -> Deploy -> Edit code
 * 3. Wklej cały ten plik i kliknij Deploy.
 * 4. Wejdź w Settings -> Variables and Secrets -> Add:
 *    - GROQ_API_KEY (typ: Secret) = Twój klucz gsk_... z https://console.groq.com/keys
 *    - (opcjonalnie) ACCESS_CODE (typ: Secret) = hasło dla testerów
 *    - (opcjonalnie) ALLOWED_ORIGIN (typ: Text) = np. https://twoj-nick.github.io
 * 5. Skopiuj adres Workera (https://srt-studio-api.twoj-nick.workers.dev)
 *    i wklej go do pliku config.js w polu WORKER_URL.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const ALLOWED_MODELS = new Set(["whisper-large-v3", "whisper-large-v3-turbo"]);

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "*";
  const allowed = (env.ALLOWED_ORIGIN || "*").trim();
  const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : allowed;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "srt-studio-worker",
          groq_configured: Boolean(env.GROQ_API_KEY),
          access_code_required: Boolean(env.ACCESS_CODE),
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    if (!env.GROQ_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Brak zmiennej GROQ_API_KEY w ustawieniach Workera." }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (env.ACCESS_CODE) {
      const provided = (request.headers.get("X-Access-Code") || "").trim();
      if (provided !== env.ACCESS_CODE.trim()) {
        return new Response(
          JSON.stringify({ error: "Nieprawidłowy kod dostępu." }),
          { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    try {
      const incomingForm = await request.formData();
      const file = incomingForm.get("file");
      if (!file) {
        return new Response(
          JSON.stringify({ error: "Brak pliku audio w polu 'file'." }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const rawModel = String(incomingForm.get("model") || "whisper-large-v3");
      const model = ALLOWED_MODELS.has(rawModel) ? rawModel : "whisper-large-v3";
      const language = String(incomingForm.get("language") || "").trim();
      const prompt = String(incomingForm.get("prompt") || "").trim();

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
        headers: {
          ...cors,
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err?.message || err) }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  },
};
