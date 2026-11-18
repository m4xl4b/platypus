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

## E1 · Vectors of any length  [x]

- Make `semantic.js` independent of `DIM`: PCA, kmeans, Rocchio (the widening of the goal in `alignment`) and cosine use `v.length`.
- Every vector carries its source: `{v, src: 'tfidf'|'ollama:<model>'|'onnx:<model>'}`.
- **Different sources are never compared:** if a mind holds mixed sources, use the most common one and recompute or leave out the other pieces. Write the rule in the Journal.
- **The pieces keep only term maps today, not the text.** A neural source needs the text, so decide in the Journal how to carry it (for example a short, bounded snippet kept in memory only, never written to disk) before E2 starts.
- **No visible change:** with TF-IDF alone, the numbers of `/api/agentmind` must stay identical. Pin a test that compares them on a demo scenario. The same test must cover `drift()` (`run`, `rel`, `weak`, `drifting`) and the 2.11 feedback drift tests (`driftBack`) in `scripts/unit-engine.js`, which must pass unchanged.

## E2 · Interface of the embedding providers  [x]

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

## E3 · Ollama provider  [x]

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

## E4 · Optional ONNX provider  [x]

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

## E5 · Calibration  [x]

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

## E6 · Interface  [x]

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

### 2026-11-18 · E1 · Vectors of any length

**Done.**
- `src/core/semantic.js`: `pca3` and `kmeans` take the length from the vectors (`vecs[0].length`); `alignment`, `drift` and `snapshotMinds` take an optional **meaning space** as their last argument, defaulting to the TF-IDF of the corpus. `DIM` is now used only inside `Corpus.vector`.
- A space is `{src, version, goal(g), piece(p)}`: `src` is the source (`tfidf`, `ollama:<model>`, `onnx:<model>`), `goal`/`piece` return the vector or `null` when it has not arrived yet, `version` grows when new vectors arrive (it is part of the snapshot cache signature). `tfidfSpace(corpus)` is the default. This is how "every vector carries its source": a vector never travels without the space it came from, and every calculation uses exactly one space. The vector cache of E2 will store `{v, src}`.
- The snapshot now also has `src` and `pending` (pieces left out because their vector has not arrived yet). `engine` is still `'lexical'` for TF-IDF and becomes `'neural'` otherwise. Changing the source with the same cache key starts again: the PCA axes of a different source are never reused.
- New `scripts/unit-embed.js` (called from `scripts/smoke-test.js`, one line) and the fixture `scripts/fixtures/agentmind-tfidf.json`.

**Rule for mixed sources (decision).** Pieces do not hold vectors at all; vectors live in the cache of each source, so a mind cannot "hold" two sources. The question is only which source a calculation uses. `pickSpace(minds, corpus, candidates)` takes the first candidate neural space that has a vector for **every goal and every action** of the minds involved; otherwise TF-IDF, which can always be recomputed from the term maps. Pieces of other kinds (results, files, replies, thinking, summaries) without a vector in the chosen space are left out of the cloud and counted in `pending`. The plan said "use the most common source": I chose "complete coverage of goals and actions" instead, because the north star and the drift rule need every action of the series; a series with holes would change `run` and the averages. Nothing is ever mixed.

**How the text reaches a neural source (decision, before E2).** Each piece keeps `text`, a snippet of its text with whitespace collapsed, at most 320 characters (`SNIP`); when a result arrives, the action's snippet gets ` → <result snippet>` appended, capped at 480 (`SNIP_ACTION`), just as its term map is merged today. Goals already kept `text` (300 characters). Snippets live in memory only: minds are never serialized (checked: nothing outside `semantic.js` reads `pieces` except the demo and the API, which sends labels, not text). Worst case about 900 × 480 characters per mind. The cache of E2 keys vectors by the sha1 of the normalized snippet and the kind (`query` for goals, `document` for pieces), and stores no text.

**Checks.**
- The fixture was written with the code of `db4e531`, before touching `semantic.js`, from a demo scenario replayed as a transcript with a fixed clock and the office in Italian (portale-clienti: CLAUDE redoes the login, a compaction, a new task; a Plan subagent that starts on the DB migration and drifts into `src/ui/components`). After the change the numbers of the snapshot for `main`, `plan1` and `all` (pieces, goals, clusters, align, ctx) and `drift()` for both agents (`run`, `rel`, `weak`, `drifting`) are identical.
- `scripts/unit-engine.js` is unchanged and its `drift`/`driftBack`/`snapshotMinds` checks pass.
- New tests: snippets are bounded and the action carries its result; spaces of 8 and 384 dimensions go through PCA, kmeans, alignment and drift with finite numbers; a neural space missing one goal or one action vector gives TF-IDF; pieces without a vector are left out and counted; switching source and back gives the same numbers.
- `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing. Run with a temporary home, `PLATYPUS_PORT=47840`, `PLATYPUS_DATA_DIR=<worktree>/.platypus-dev`.

**Doubts for Max.** None blocking. The 320-character snippet is a guess at what is useful for small multilingual models (about 80–100 tokens); E5 can say whether more text helps.

### 2026-11-18 · E2 · Interface of the embedding providers

**Done.** New `src/core/embed/index.js`, no npm dependencies.
- **Contract.** A provider is `{id, dim, embed(texts, kind) → Promise<Float32Array[]>, ready() → Promise<boolean>}`, plus `state` (`ready` / `not-found` / `not-installed` / `error` / `unknown`), `model`, `detail` and `hint` for the options panel. `kind` is `query` (goals) or `document` (pieces). `getProvider(settings)` returns the chain as one provider with that contract; `ready()` picks the source.
- **Chain** (`resolveChain`). `auto`: Ollama if `ready()` answers within 5 s, then ONNX, otherwise TF-IDF (in `auto` TF-IDF is a choice, so `fallback` is `null`). `ollama` / `onnx`: that source or TF-IDF with `fallback = {source, state, detail}`, which E6 will show. `tfidf`: lexical only. Unknown values become `auto`. The Ollama and ONNX providers are loaded with `require('./ollama')` / `require('./onnx')` inside `try`; a missing module gives a provider in state `not-installed` and the chain moves on.
- **`Embedder`**, one for the whole engine (wired into the engine in E3):
  - `space(prio)` gives `semantic.js` the meaning space of the active source, or `null` for TF-IDF. A lookup that misses returns `null` and queues the text; `version` grows when vectors arrive, which refreshes the snapshot cache. The sha1 of each piece's snippet is memoized in a `WeakMap`, so the pieces are not touched.
  - Queue: one per engine, deduplicated by key, priority 0 for agents being looked at and 1 for the rest, then arrival order; batches of at most 16 texts of the same source and kind; one request at a time; 5 s timeout each; at most 4000 waiting (the rest is asked again later).
  - Failures: 3 in a row suspend the source for 5 minutes, the queue is emptied and the chain is resolved again (in `auto` it moves on to the next source; with a chosen source it falls back to TF-IDF and says why). After the suspension, and every minute while on a fallback, the next lookup tries the chain again. No timers run in the background: everything starts from a lookup.
  - Cache in memory: LRU of 5000 vectors, keyed by `source|sha1`.
  - Cache on disk: `<dataDir>/embed-cache/<source>.bin` (source name sanitized), a 16-byte header (`PLEMB001` + dimension) and records of 20 bytes of sha1 + the float32 vector. Hashes and vectors only, never text. The index is read once per source; writes are appended in order; past the 50 MB cap the file is rewritten keeping the newest half. A file with a different dimension (another model with the same name) is thrown away.
  - `clearCache()` empties memory and deletes the files; `status()` gives the engine setting, the active source, the fallback, the state of each source, the cache size (vectors in memory, bytes on disk) and the queue length; `configure(settings)` redoes the chain only when `embedEngine`, `embedModel` or `ollamaUrl` change.
- `semantic.js`: the coverage check of `pickSpace` no longer stops at the first missing vector, because asking for a vector is also what queues it (found by the new test).

**Checks.** New tests in `scripts/unit-embed.js` (now async; `smoke-test.js` awaits it), with fake providers and a temporary folder: the chain in every mode, including a `ready()` that never answers; `getProvider`; null-then-vector; batch sizes (16, 16, 8 documents, 1 query); priority to visible agents; the disk file holds no text and serves a new instance without new requests; a dimension change recomputes; the memory and disk caps (10 vectors / 2000 bytes in the test); clearing the cache; three timeouts → suspended, TF-IDF and the reason, then retried after 5 minutes with a fake clock; in `auto` three errors from Ollama move to ONNX; the demo scenario starts on TF-IDF and switches to the neural space when every goal and action has a vector, with the other pieces counted as pending until they arrive. `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing (no new UI strings yet).

**Decisions.** One request at a time is enough for a local model and keeps Ollama from being flooded. Queued work is not persisted: after a restart, vectors come back from the disk cache when they are asked for again.

### 2026-11-18 · E3 · Ollama provider

**Done.**
- New `src/core/embed/ollama.js` (Node `http`, no dependencies): `GET /api/tags`, then `POST /api/embed` with `input` as a list and `truncate: true`; if `/api/embed` answers 404 without mentioning a model (old Ollama), it switches to `POST /api/embeddings`, one text at a time. `ready()` picks the model and embeds one short probe to learn the dimension. Answers are capped at 64 MB; every request has the 5 s timeout.
- **Host.** `loopbackUrl()` accepts only `127.0.0.1`, `::1` and `localhost` (http or https, no user/password); anything else gives state `error` without any network call. The option is cleaned in `state.setSettings` (one line in `state.js`, through `embed.cleanSetting`): a non-loopback `ollamaUrl` is refused and the previous value kept.
- **Model** (`embedModel`). If set, that model (with or without `:latest`); if missing: state `not-found`, `hint` = `ollama pull <model>`, never run. If empty: the first embedding model present (by name: embed, bge, e5, gte, minilm, …; or by family: bert, xlm-roberta, nomic-bert), preferring multilingual ones in this order: bge-m3, snowflake-arctic-embed2, embeddinggemma, qwen3-embedding, nomic-embed-text-v2, granite-embedding, multilingual-e5, paraphrase-multilingual, jina-embeddings-v3. If there is none: `hint` = `ollama pull bge-m3`.
- **Prefixes** per model: e5 `query: ` / `passage: `; nomic `search_query: ` / `search_document: `; embeddinggemma `task: search result | query: ` / `title: none | text: `; qwen3-embedding an instruction for the query only; none for bge-m3 and the others.
- **Settings** in `DEFAULT_SETTINGS`: `embedEngine: 'auto'`, `embedModel: ''`, `ollamaUrl: 'http://127.0.0.1:11434'`.
- **Engine** (`src/core/index.js`, small hooks): one `Embedder` for the core, cache in `embed-cache/` next to `settings.json` (so `dataDir()/embed-cache`, or `PLATYPUS_DATA_DIR`); `/api/agentmind` uses `pickSpace` with the space of the active source (priority 0, the agent being looked at); `POST /api/settings` calls `embedder.configure`; new `GET /api/embed` with `embedder.status()`; `stop()` stops it.
- The drift rule (`drift()`, `driftBack`) still uses TF-IDF only: neural vectors need their own thresholds, which come in E5.

**Models found and recommended for Italian (not verified).** I did not start Ollama. Listing its model folder (`OLLAMA_MODELS=D:\ollama\models`, manifest names only) shows these embedding models already on disk: `bge-m3`, `embeddinggemma-2`, `nomic-embed-text`, `nomic-embed-text-v2-moe`, `qwen3-embedding`, `snowflake-arctic-embed2`. This contradicts the plan's note that no embedding model is known to be pulled, so no download should be needed. On paper the multilingual candidates for Italian are bge-m3 (about 1.2 GB, 1024 dimensions), snowflake-arctic-embed2, embeddinggemma and qwen3-embedding; `nomic-embed-text` v1 is mostly English. My provisional recommendation is **bge-m3**, but this is not checked: measuring it needs Max's permission to start Ollama, and then `scripts/embed-eval.js` (E5) gives the AUC per model.

**Checks.**
- A fake Ollama server (`fakeOllama()` in `scripts/unit-embed.js`, deterministic 16-dimension vectors) is used both by the provider tests and by a block inside `scripts/smoke-test.js`. Provider: normal case (model chosen, dimension, one request per batch with the model's prefixes, no pull); model choice and prefixes; missing model and no embedding model (`hint` with the command); old Ollama; a slow `/api/tags` (not ready after about 100 ms) and a slow embed (error); Ollama off (`ECONNREFUSED` → `not-found`); non-loopback hosts refused, including `127.0.0.1.evil.example` and `user:pw@127.0.0.1`; the settings refusing an outside host.
- Engine (smoke test): with `tfidf` the bubble is lexical; switching to the fake Ollama through `/api/settings`, `/api/agentmind` turns into `ollama:nomic-embed-text:latest` with nothing pending and the same pieces, batches of at most 16 and the cache file in `embed-cache/`; an outside URL is refused; with Ollama off the bubble goes back to TF-IDF and `/api/embed` says why (`not-found`).
- The smoke test now starts its engine with `embedEngine: 'tfidf'` in its temporary `settings.json`, so a developer's running Ollama can never change its numbers.
- `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing.

**Doubt for Max.** With `auto` as the default, a Platypus on a computer where Ollama is running with an embedding model will start sending snippets of the agents' text to that local Ollama on its own. It stays on the computer, as the plan requires, but it also loads the model into memory. If you prefer, the default can be `tfidf` and the neural engine opt-in; I kept `auto` because the plan describes it as the chain's default.

### 2026-11-18 · E4 · Optional ONNX provider

**Done.**
- `optional/embed-onnx/`: `package.json` (dependency `@huggingface/transformers` `~3.7.0`), `index.js` with the provider contract (`create`, plus `download`, `installed`, `hasModel` for the install script), `worker.js` where the model runs in a `worker_thread`. During use remote models are switched off (`env.allowRemoteModels = false`): nothing goes on the network. The first request loads the model (60 s allowance), then the usual 5 s per batch.
- `src/core/embed/onnx.js`: loads `optional/embed-onnx` with `require` inside `try`. Missing module, missing npm packages or missing model → state `not-installed` with the hint `npm run embed:onnx:install`, and the chain moves on. The engine passes `modelsDir` = `<data folder>/models`.
- `scripts/embed-onnx-install.js` and the npm script `embed:onnx:install` (one line in `package.json`): says what it downloads and how big (npm packages, about 200 MB; the model, about 118 MB, into `<data folder>/models`; from registry.npmjs.org and huggingface.co), asks `[s/y/N]`, and only on yes runs `npm ci` (or `npm install` while there is no lockfile) in the folder, then downloads the model and writes the marker `.platypus-ok` next to it. The marker is how the provider knows the model is complete, without relying on transformers.js's cache layout. Messages are bilingual, like `scripts/launch.js`.
- `scripts/smoke-test.js` also checks the syntax of `optional/`.

**Model choice (decision).** `Xenova/multilingual-e5-small`, quantized `q8`:
- size: about 118 MB (fp32 is about 470 MB); 384 dimensions, so cheap vectors in memory and on disk (1.5 KB each);
- quality on Italian: trained on about 100 languages including Italian, and it is a retrieval model (query vs passage), which matches "task vs actions" better than a paraphrase model; `paraphrase-multilingual-MiniLM-L12-v2` (Apache-2.0, similar size) was the alternative, trained for sentence similarity rather than retrieval;
- licence: MIT;
- prefixes `query: ` (goals) and `passage: ` (pieces), added by the provider.
This is on paper: E5 measures it only if the real model is installed.

**Checks.** Automatic tests never download anything: a fake `transformers.js` written to a temporary folder (deterministic 12-dimension vectors; it refuses to run if remote models are not off) goes through the real `optional/embed-onnx` and its worker. Covered: module / packages / model missing → `not-installed` with the command; with the marker the provider is ready, runs in a worker thread, adds the e5 prefixes; a model error comes back as an error and the worker stays up; in `auto` with Ollama off the chain takes ONNX; in this worktree, without installation, the real provider says `not-installed`; the install script answered "n" exits with code 1, shows the 118 MB, and creates neither `node_modules` nor the models folder. `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing.

**Not done, needs Max's permission.** The real test: `npm run embed:onnx:install` (about 320 MB of downloads), then one run with the real model. Also, there is no `package-lock.json` in `optional/embed-onnx/` yet: generating it needs the npm registry, so the first install uses `npm install` with the `~3.7.0` range. The packaged Electron app does not include `optional/`, so there ONNX shows as "not installed" (Ollama still works).

### 2026-11-18 · E5 · Calibration

**Done.**
- **Test set** `scripts/embed-eval-set.js`: 30 tasks written for the purpose (16 Italian, 14 English, 12 areas), six on-topic actions each; off-topic actions are those of a task from another area; 11 tasks use synonyms or the other language; 4 tasks that cannot be measured. No real data.
- **`scripts/embed-eval.js`**: AUC on/off topic (overall, on synonyms, worst task), the background similarity, 60 simulated sessions through the real `alignment()` and drift rule with the best `rel` (Youden) and the one in use, and the `weak` threshold. `--source tfidf|ollama|onnx`, `--json`. For neural sources it makes two passes (measure the background, then rescale from it).
- **One rule, three places.** New `src/core/drift-rule.js`, a UMD file usable with `require` and as a page script (`window.PlatypusDrift`): the per-source table (`rel`, `run`, `weak`, `warn`, `floor`, `zero`, `calibrated`), `thresholdsFor(src)` and `judge(rows, th)`.
  - engine: `alignment()` takes `zero` (rescaling) and `floor` (the old `Math.max(0.03, …)`) from the table; `drift()` calls `judge()` and now also returns `src` and `uncalibrated`;
  - feedback: `driftBack` passes the agent's space to `drift()` (one argument; the thresholds come through `drift()`), and `index.js` gives the hook's agent the space picked for that mind (priority 1);
  - map: `renderer/worldmap.js` no longer has 0.35 / 6 / 0.031 / 0.6 written in it; it uses `PlatypusDrift.judge(al, m.th)` and draws the bands from `th`. `/api/agentmind` sends `th`, the thresholds of the source the rows were computed with. The server serves `/drift-rule.js` from `src/core` (one line in `index.js`); `renderer/index.html` loads it before `worldmap.js`.
  - The map's old rule did not stop counting at a change of task; now it does, like the engine.
- **Uncalibrated neural sources** (no row in the table): rows and cloud are computed, but `judge()` says `weak` with `uncalibrated: true`, so the engine, the feedback and the map all say "not measurable" (new string in `src/i18n/locales/en/embed.json`: "this meaning source is not calibrated yet").
- **The default engine is now `tfidf`** (was `auto` in E3; unknown values also give `tfidf`).
- Results in `docs/plans/embedding-calibration.md`.

**Results (TF-IDF).** AUC 0.785, on synonyms 0.547 (close to chance), worst task 0.302, background 0.011. Drift with 0.35: 80% of the drifts caught, no false alarms, 11.7% of the sessions not judgeable (all synonym tasks: the base sits on the floor). The best threshold would be 0.64 (86.7%, no false alarms), but I left the TF-IDF thresholds as they are: the 2.11 tests must pass unchanged and 30 tasks are few. `weak` 0.031 is confirmed (right above the floor 0.03).

**Requirement "the neural source must beat TF-IDF": not measured.** No neural source could be measured without Max's permission (start Ollama, or install the ONNX model). So, as the plan says, TF-IDF stays the default; the table has the TF-IDF row only.

**Checks.**
- Unit tests: the evaluation on TF-IDF (AUC > 0.7, synonyms worse, 0.35 catches ≥ 75% with ≤ 5% false alarms); on a 64-dimension test source with a background; the table; the engine and `drift-rule.js` loaded as a page script in a `vm` give the same answer on the same rows; the snapshot's `th`; `worldmap.js` has no hard-coded thresholds and `index.html` loads the rule first; an uncalibrated source gives "not measurable" in the engine, the map and `driftBack`; `driftBack` with TF-IDF unchanged; rescaling and floor.
- Smoke test: `/drift-rule.js` is served, equals the engine's file, and on the 2.11 drift session the page rule and the engine agree (drifting for 10 actions).
- The 2.11 checks in `scripts/unit-engine.js` pass unchanged; the E1 fixture still matches (it now ignores added fields such as `src` and `th`, the numbers are compared as before).
- Interface: engine in web mode with a temporary home on port 47840 and the demo, map of the Plan subagent opened in the built-in browser: green/yellow/red bands in place, "DRIFTING for 13 actions · alignment 0%", no console errors. The engine was stopped by its PID.
- `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing.

**Decision for Max.** To measure a real model: permission to start Ollama (the models are already on disk) and run `node scripts/embed-eval.js --source ollama --model bge-m3` (and the others), or to install the ONNX model. If one beats TF-IDF, its row goes into `drift-rule.js` and the default can become `auto`.

### 2026-11-18 · E6 · Interface

**Done.**
- **Options, "Meaning engine" section** (new `renderer/embed-ui.js`; `game.js` gets three one-line hooks in `toggleSettings`: the HTML, the binding, and collecting the values on save; `index.html` loads the module before `game.js`):
  - the choice: lexical only (TF-IDF, the default), automatic (Ollama, then ONNX, then lexical), Ollama, ONNX; the Ollama model (empty = automatic) and address (loopback only, explained in the tooltip);
  - the state of each source when the panel opens (ready / not found / not installed / error / not checked yet), the model, "in use", the command to get it (`ollama pull …`, `npm run embed:onnx:install`) shown as text and never run, the detail of the error; a red line when a chosen source is not available and lexical is used instead; the cache size (vectors in memory, bytes on disk) and the **CLEAR THE CACHE** button;
  - a line saying that Platypus never downloads models on its own.
- **Engine.** `POST /api/embed {action: 'probe'}` checks every source without changing the one in use, through a new light `check()` of the providers: Ollama reads only `/api/tags` (no model is loaded into memory just because the options were opened), ONNX checks the packages and the model marker without starting the worker. `POST /api/embed {action: 'clear'}` clears the cache. `/api/agentmind` also says `active` (the source chosen), `refining` (that source is not complete yet, so TF-IDF is shown meanwhile, or pieces are still pending) and `fallback`.
- **Bubble and star view** (`renderer/worldmap.js`): next to the bubble's caption an honest label, "lexical (TF-IDF): compares words, not concepts" or "meaning: Ollama · <model>" / "meaning: ONNX · <model>"; a yellow "refining…" while the neural vectors arrive (the TF-IDF picture is on screen meanwhile, never an empty one); when the source of the snapshot changes, "source changed: starting again" for 8 seconds. Every snapshot is drawn on its own (positions are not interpolated), so two sources are never mixed. The star panel says "not measurable: this meaning source is not calibrated yet" for a neural source without a row in the table (E5).
- 33 new strings in `src/i18n/locales/en/embed.json`; small styles in `renderer/style.css`.

**Checks.**
- Tests: `check()` of the Ollama provider reads only `/api/tags`; in the smoke test the options probe shows Ollama `ready` with its model and ONNX `not-installed` without any request other than `/api/tags`; switching to the fake Ollama the bubble first answers with TF-IDF and `refining`, then with the neural source and `refining: false`; clearing the cache empties memory and disk.
- Interface, in the built-in browser with the engine in web mode (temporary home, port 47840, demo) and a fake Ollama started for the purpose: the options section shows the three sources (Ollama "not found" on the real default address, which is not running; ONNX "not installed" with the command; lexical "ready · in use"), the cache and the button; after switching to the fake Ollama the bubble's label went "lexical … → lexical … refining… → meaning: Ollama · nomic-embed-text refining… source changed: starting again → meaning: Ollama · nomic-embed-text", and the star said "CAN'T TELL · this meaning source is not calibrated yet". No console errors. Settings put back to TF-IDF, engine and fake Ollama stopped by their PIDs, temporary home deleted.
- `npm test` → "Tutto a posto."; `npm run i18n:check` → 0 missing.

**Note.** Opening the options checks `127.0.0.1:11434` (or the configured address) once: a loopback request that only lists the models. On this computer Ollama is not running, so it answers "not found"; nothing is started.
