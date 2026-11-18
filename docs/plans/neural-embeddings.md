# Platypus · Meaning with neural embeddings

This is the English version of Max's `PIANO-EMBEDDING.md`, adapted to the code after 2.11.

Development plan to carry out step by step, one task at a time. It lives in the repository at `docs/plans/neural-embeddings.md`, on branch `sviluppo-embedding`.
Each task has a checkbox: `[ ]` to do, `[~]` in progress, `[x]` done, `[!]` blocked (with the reason below it).
At the bottom is the **Journal**, where whoever works on the plan records, at every step, what they did, what they verified and the decisions they made. The Journal is written in English.

## The goal

Today the context bubble and the north star (`src/core/semantic.js`) measure meaning in a **lexical** way: TF-IDF with feature hashing into 256 dimensions, 5-letter stems and a small Italian→English dictionary. It works on words, not on concepts: "aggiusta il login" and "correggi l'autenticazione" come out far apart.

This plan adds neural vectors from three sources, in order of preference:

1. **Local Ollama:** if the user has it running with an embedding model already downloaded.
2. **Optional ONNX model:** a package installed separately, with a multilingual model downloaded once, only if the user asks for it.
3. **TF-IDF:** the one we have today, always available and used as the fallback.

## Rules on top of `docs/plans/parallel.md`

Everything in `docs/plans/parallel.md` still applies. In addition:

- **The engine stays free of npm dependencies.** Ollama is called with Node's `http`. The ONNX provider lives in `optional/embed-onnx/`, with its own `package.json`; the engine loads it with a dynamic `require` only if it is installed.
- **Privacy:**
  - Ollama is reached only on loopback addresses (`127.0.0.1`, `::1`, `localhost`): the option refuses any other host, because the agents' texts must not leave the computer;
  - the ONNX model is downloaded only with an explicit command, and it is the only new network call, documented;
  - never download Ollama models for the user (`ollama pull`): it is proposed to them;
  - the disk cache holds only vectors and hashes, never the text.
- **Never block the office:**
  - embeddings are asynchronous, queued, with a 5 s timeout per request and batches of at most 16 texts;
  - the TF-IDF result is shown at once and updated when the neural vectors arrive;
  - the ONNX model runs in a `worker_thread`.
- **Texts:** the new interface strings go in `src/i18n/locales/en/embed.json` (the keys are the Italian text, as everywhere else).
- **Installing or starting Ollama, or downloading any model,** on Max's computer needs his permission. Checked on 2026-11-18: this computer has Ollama installed but not running, and no embedding model is known to be pulled. Never start it and never `ollama pull` on his behalf. Automated tests must not need any of it: they use a fake Ollama server and a fake ONNX module.

## Where to work: map of the existing code

| What | Where |
|---|---|
| TF-IDF vectors (`Corpus.vector(terms)`, which takes a term map, not text), `DIM`, `cosine` | `src/core/semantic.js` |
| PCA, clusters, snapshot of the minds | `pca3`, `kmeans`, `snapshotMinds` in `src/core/semantic.js`; today they take `DIM` for granted (`kmeans` also builds its centroids with `DIM`) |
| North-star alignment (one row per action) | `alignment(mind, corpus)` in `src/core/semantic.js` (not in `AgentMind` any more). It builds the goal vector, widens it with the closest early actions (relevance feedback), and adds the base floor `Math.max(0.03, …)` |
| Drift rule: below `DRIFT_REL` (0.35) for `DRIFT_RUN` (6) actions in a row, "not measurable" when the base is ≤ `WEAK_BASE` (0.031) | `drift(mind, corpus)` and the constants in `src/core/semantic.js` |
| Same drift rule, used by the 2.11 feedback "back to the task" | `driftBack` in `src/core/feedback-rules.js`, which calls `drift()` (imported as `semanticDrift`) |
| Same drift rule, copied for the map | `driftOf` in `renderer/worldmap.js`: it has the numbers 0.35, 6 and 0.031 written in it and reads the `align` rows of the API; the yellow and red bands of the chart use 0.6 and 0.35 |
| Where the vectors come from | `AgentMind` keeps pieces with a term map (`terms`), not the text; a `Corpus` per session is created in `src/core/state.js` (`s.corpus`) |
| API | `agentMind()` → `GET /api/agentmind` in `src/core/index.js`; the answer has `engine: 'lexical'` today |
| View of the bubble and the star | `renderer/worldmap.js` |
| Settings | `DEFAULT_SETTINGS` in `src/core/state.js`, "OPZ" options panel in `renderer/game.js` |
| Existing tests that must not change | `scripts/unit-engine.js` (the `drift` and `driftBack` checks of 2.11, the `snapshotMinds` check), `scripts/smoke-test.js` |

---

## E1 · Vectors of any length  [ ]

- Make `semantic.js` independent of `DIM`: PCA, kmeans, Rocchio (the widening of the goal in `alignment`) and cosine use `v.length`.
- Every vector carries its source: `{v, src: 'tfidf'|'ollama:<model>'|'onnx:<model>'}`.
- **Different sources are never compared:** if a mind holds mixed sources, use the most common one and recompute or leave out the other pieces. Write the rule in the Journal.
- **The pieces keep only term maps today, not the text.** A neural source needs the text, so decide in the Journal how to carry it (for example a short, bounded snippet kept in memory only, never written to disk) before E2 starts.
- **No visible change:** with TF-IDF alone, the numbers of `/api/agentmind` must stay identical. Pin a test that compares them on a demo scenario. The same test must cover `drift()` (`run`, `rel`, `weak`, `drifting`) and the 2.11 feedback drift tests (`driftBack`) in `scripts/unit-engine.js`, which must pass unchanged.

## E2 · Interface of the embedding providers  [ ]

- New `src/core/embed/index.js`:
  - `getProvider(settings)` returns `{id, dim, embed(texts, kind) → Promise<Float32Array[]>, ready()}`;
  - `kind` is `query` or `document`, for the models that want different prefixes (e5, nomic).
- **Chain:**
  - with the `embedEngine` option on `auto`: Ollama if it answers, then ONNX if it is installed, otherwise TF-IDF;
  - with `ollama`, `onnx` or `tfidf` use that one and, if it does not work, fall back to TF-IDF **and say so**.
- **Cache:**
  - in memory (LRU, 5000 vectors);
  - on disk in `dataDir()/embed-cache/<source>.bin`, keyed by the sha1 of the normalized text;
  - a cap of 50 MB per source; it is cleared from the options.
- **Queue:** one for the whole engine, with priority to the visible agents, batches and timeouts. If a source fails 3 times in a row, it is suspended for 5 minutes.

## E3 · Ollama provider  [ ]

- `src/core/embed/ollama.js`:
  - `GET /api/tags` to see which models are there;
  - `POST /api/embed` (with `input` as a list);
  - if that is missing, `POST /api/embeddings` for old versions.
- **Choosing the model** (option `embedModel`):
  - if it is empty, take the first embedding model present, preferring multilingual ones;
  - if there is none, the engine says so in the options with the command to run (for example `ollama pull <model>`), without running it.
- Write in the Journal which models you found and which one you recommend for Italian: it has to be checked, not taken for granted. On this computer Ollama is installed but not running and no embedding model is known to be there, so a real check needs Max's permission to start Ollama and to pull a model.
- **Host:** option `ollamaUrl`, default `http://127.0.0.1:11434`, accepted only if it is loopback.
- **Tests:** a fake Ollama server inside `scripts/smoke-test.js`, answering with deterministic vectors. Cover:
  - the normal case;
  - Ollama off;
  - a missing model;
  - a timeout;
  - a non-loopback host refused.

## E4 · Optional ONNX provider  [ ]

- **`optional/embed-onnx/`:**
  - `package.json` with `@huggingface/transformers`;
  - `index.js` exporting the same contract;
  - a `worker.js`.
- **Model:** multilingual and small, for example `Xenova/multilingual-e5-small` or a quantized `paraphrase-multilingual-MiniLM-L12-v2`.
  - Weigh size, quality on Italian and licence;
  - write down the choice.
  - The e5 models want the prefixes `query:` and `passage:`.
- **Installation:** `npm run embed:onnx:install` runs `npm ci` in the folder and downloads the model into `dataDir()/models/`. It first asks for confirmation in the terminal, saying how big it is.
- **Loading:** the engine looks for it with `require` inside `try`. If it is missing, the provider shows as "not installed" and the chain moves on.
- **Tests:** the automatic ones do **not** download the model. The provider is tested with a fake module. The real test is done once, by hand and with Max's permission, and is written down.

## E5 · Calibration  [ ]

Today's thresholds are valid for TF-IDF, not for neural vectors, which have much higher baseline similarities:

- drift below 0.35 (`DRIFT_REL`) for 6 actions (`DRIFT_RUN`);
- base ≤ 0.031 (`WEAK_BASE`) to say "not measurable".

- **Test set:** `scripts/embed-eval.js` with a small labelled set.
  - About thirty tasks, in Italian and in English.
  - For each, "on topic" and "off topic" answers, taken from the demo scenarios plus some written for the purpose. No real data from Max.
- **Measures per source:**
  - how well it separates on and off topic (AUC);
  - the best threshold for drift;
  - the threshold for "not measurable".
- **Use:** the thresholds go in a table per source, inside `semantic.js`. The results go in `docs/plans/embedding-calibration.md`.
- **One rule, three places.** The per-source thresholds must apply everywhere the drift rule is used:
  - the engine `drift()` in `semantic.js`;
  - the 2.11 feedback rule `driftBack`, which goes through `drift()` and so gets them with no change of its own (check it, with a test);
  - `driftOf` in `renderer/worldmap.js`, which today has the numbers written in it. The snapshot from `/api/agentmind` must tell the map which source (and so which thresholds) the `align` rows were computed with, so the map and the engine never disagree. Add a test that the two give the same answer for the same rows.
  - The base floor `Math.max(0.03, …)` in `alignment` belongs to the same table.
- **Requirement:** the neural source must beat TF-IDF on the test set. If it does not, write it down and leave TF-IDF as the default.

## E6 · Interface  [ ]

- **Options** (`DEFAULT_SETTINGS` in `src/core/state.js`, panel in `renderer/game.js`): a section "Meaning engine" with:
  - the choice between automatic, Ollama, ONNX and lexical only;
  - the state of each source (ready / not found / not installed / error), the model in use and the size of the cache;
  - the button to clear the cache.
- **Bubble and star view:** an honest label, for example "meaning: Ollama · <model>" or "lexical (TF-IDF): compares words, not concepts".
  - If the source changes, the view says so and starts again, without mixing.
- **While the vectors arrive:** a small "refining…" indicator. Never an empty screen.

## E7 · Demo and tests  [ ]

- **The demo:** it works without Ollama. With the option `embedEngine=fake`, hidden and for the demo only, it shows the "synonyms" scenario: an agent that talks about "autenticazione" while the task says "login".
  - With TF-IDF the scenario comes out as drifting.
  - With the fake semantic provider it comes out as aligned.
  - It is the visible proof of why embeddings are needed.
- **`npm test` covers:**
  - the provider chain;
  - the cache (with a small cap);
  - mixed sources;
  - the fallbacks;
  - the unchanged numbers with TF-IDF (E1), including `drift()` and the 2.11 feedback drift tests.

## E8 · Documents  [ ]

- **`docs/ARCHITECTURE.md`:** the `embed/` module and the provider chain. Update the Italian `docs/ARCHITETTURA.md` to match.
- **Install guides** (`docs/INSTALL.md` and `docs/INSTALLAZIONE.md`):
  - "More precise meaning (optional)": Ollama and the ONNX model, how big they are, what stays local;
  - the only new network call, which is the download of the ONNX model and is explicit.
- **README:** one line on the updated privacy (`README.md` and `README.it.md`).
- **Notes for the changelog:** in the section below.

---

## For the CHANGELOG

(to fill in at the end)

## Journal

(Every step adds an entry: date, task, what was done, how it was verified, decisions and doubts.)
