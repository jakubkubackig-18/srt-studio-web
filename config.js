/**
 * Konfiguracja SRT Studio (GitHub Pages + Cloudflare Worker)
 *
 * 1. Po wdrożeniu pliku worker/cloudflare-worker.js na Cloudflare Workers,
 *    wklej poniżej swój adres Workera (bez ukośnika na końcu).
 * 2. Dopóki WORKER_URL jest pusty (""), aplikacja pozwala wpisać własny
 *    klucz Groq bezpośrednio w przeglądarce (tryb testowy BYOK) oraz zawsze
 *    pozwala przełamywać istniejące pliki .srt bez żadnego klucza.
 */
window.SRT_STUDIO_CONFIG = {
  WORKER_URL: "https://srt-studio-api.jakubkubacki-g.workers.dev",
  REQUIRE_ACCESS_CODE: false,
};
