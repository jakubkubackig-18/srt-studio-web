# SRT Studio — Wersja Web 24/7 (GitHub Pages + Cloudflare Worker + Groq)

Aplikacja do błyskawicznej transkrypcji audio/wideo (Whisper Large V3) oraz profesjonalnego łamania napisów `.srt` zgodnie ze standardami montażowymi **POZIOM (16:9)** i **PION (9:16)** — działająca w 100% w chmurze 24/7, bez włączonego komputera i za **0 zł** na start.

---

## Jak opublikować w 5 minut (GitHub Desktop + GitHub Pages + Cloudflare)

### Krok 1: Opublikuj stronę na GitHub Pages (2 minuty)
1. Otwórz aplikację **GitHub Desktop**.
2. Wybierz **File → Add Local Repository…** i wskaż ten folder (`srt-studio-web`).
3. Kliknij **Publish repository** (zostaw odznaczone *Keep this code private* tylko jeśli masz darmowe konto GitHub i chcesz użyć GitHub Pages — w kodzie nie ma żadnych tajnych kluczy!).
4. Wejdź na swoje repozytorium na **github.com → Settings → Pages**:
   * **Source:** `Deploy from a branch`
   * **Branch:** `main` oraz folder `/ (root)`
   * Kliknij **Save**.
5. Po ~30–60 sekundach Twoja strona jest już online pod adresem:
   `https://<twoj-login>.github.io/srt-studio-web/`

> Już po samym Kroku 1 strona działa online — można na niej testować demo, przełamywać pliki `.srt` (POZIOM / PION) oraz transkrybować audio własnym kluczem Groq.

---

### Krok 2: Ukryj swój klucz Groq w Cloudflare Worker (3 minuty)
Żeby **użytkownicy strony nie musieli wpisywać żadnego klucza API**:

1. Wygeneruj darmowy klucz API na [console.groq.com/keys](https://console.groq.com/keys) (`gsk_...`).
2. Załóż/otwórz darmowe konto na [dash.cloudflare.com](https://dash.cloudflare.com).
3. W lewym menu kliknij **Compute (Workers) → Workers & Pages → Create → Create Worker**:
   * Nazwij go np. `srt-studio-api` i kliknij **Deploy**.
   * Kliknij **Edit code**, usuń przykładowy kod, wklej całą zawartość pliku `worker/cloudflare-worker.js` i kliknij **Deploy**.
4. Wróć do widoku Workera → **Settings → Variables and Secrets → Add**:
   * **Type:** `Secret`, **Variable name:** `GROQ_API_KEY`, **Value:** Twój klucz `gsk_...` → **Deploy**.
   * *(Opcjonalnie, żeby zabezpieczyć swój limit przed obcymi)* Dodaj drugi Secret: **Variable name:** `ACCESS_CODE`, **Value:** wymyślone hasło dla testerów.
5. Skopiuj adres Workera (wygląda np. tak: `https://srt-studio-api.twoj-nick.workers.dev`).

---

### Krok 3: Wpisz adres Workera do `config.js` i wypchnij zmianę (30 sekund)
1. Otwórz plik `config.js` i wklej swój adres Workera:
   ```js
   window.SRT_STUDIO_CONFIG = {
     WORKER_URL: "https://srt-studio-api.twoj-nick.workers.dev",
     REQUIRE_ACCESS_CODE: false, // zmień na true, jeśli dodałeś ACCESS_CODE
   };
   ```
2. W **GitHub Desktop** wpisz opis commita (np. `Podłączenie Cloudflare Worker`), kliknij **Commit to main**, a następnie **Push origin**.

Gotowe! Po ok. 30 sekundach strona działa 24/7 dla każdego, bez klucza po stronie użytkownika i bez włączonego Twojego komputera.
