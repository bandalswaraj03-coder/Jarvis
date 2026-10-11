# JARVIS for iPhone (v0.4: answer engine)
A static web app (no server, no build). Your Gemini key lives only in your iPhone's browser storage and is sent only to Google.

## Put it on your iPhone (free, ~5 minutes)
A web app needs an https address once. Free option: **GitHub Pages**.
1. Create a free account at github.com → New repository → name `jarvis` → **Public** → Create.
2. "uploading an existing file" → drag in ALL files from this folder (index.html, agent.js, sw.js, manifest.webmanifest, 2 PNG icons) → Commit. (There is no key in these files.)
3. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save. After ~1 min you get `https://YOURNAME.github.io/jarvis/`.
4. On the iPhone open that link in **Safari** → Share → **Add to Home Screen**.
5. Open JARVIS from the Home Screen → Menu → Settings → paste your Gemini key → Save.
   (The Home Screen app has its own storage, so enter the key there even if you did it in Safari.)

## What it does
Agent loop (up to 6 steps): plans, then picks tools: live web research with sources (Gemini's built-in Google Search + page reading), calculator, clock, approved memory, UPSC study log/progress. Model default `gemini-3.1-pro-preview`; change in Settings.

## Test
`node --test test.mjs` (6 tests with a mock Gemini; Node 20+).

## Status
Tested with mock: tool loop, thought-signature echo, research parsing, calculator safety, memory approval, study tracking.
**Unverified (could not reach the internet or an iPhone while building):** real Gemini calls from Safari, Google Search grounding combined with this setup, voice input in Home Screen mode (iOS may block it; keyboard dictation always works), spoken replies, Home Screen install.
Not built: website builder.

## Safety
Anyone holding your unlocked phone can open the app. Set a spending cap/budget alert for your key in Google AI Studio/Cloud billing. Don't publish a copy of the app with the key filled in.

## v0.3 changes
- Pick the brain in Menu → Settings: **DeepSeek** (default; models `deepseek-v4-pro` / `deepseek-v4-flash`) or **Gemini**.
- DeepSeek has no web search. Optional: also paste a Gemini key to enable live Google-grounded `research`. Without it, JARVIS uses a free Wikipedia tool for background knowledge only (not news).
- Automatic retry on temporary "busy" errors (503/429). Quota/balance errors show immediately.
- Fixed the white strip at the bottom of the screen.
- **Unverified:** DeepSeek calls straight from Safari. If DeepSeek's server blocks browser requests you'll see "Request failed or was blocked by the browser"; the fix would be a tiny proxy.

## Updating GitHub
Replace these files in your repo (open each file → pencil icon, or upload again and overwrite): index.html, agent.js, sw.js, test.mjs, README.md.

## v0.4: answer engine
Tap **Deep** (bottom bar) or just ask a hard question. JARVIS plans 3 differently-angled searches (official sources, critics/corrections, base facts), runs them in parallel, cross-checks them, and answers with Verified vs Uncertain plus sources.
- Needs a Gemini key (its Google Search grounding does the retrieval), even if DeepSeek is the brain. About 4 Gemini calls per deep question, so it costs more and is slower.
- Update on GitHub: index.html, agent.js, sw.js, test.mjs, README.md.
- **Unverified:** real Google grounding calls, and answer quality on real questions.
