# Platypus · Calibration of the meaning sources

Results of `scripts/embed-eval.js` (plan `docs/plans/neural-embeddings.md`, task E5). The thresholds that the engine uses are in the table of `src/core/drift-rule.js`, one row per measured source.

## How it is measured

- **Test set:** `scripts/embed-eval-set.js`, 30 tasks written for the purpose (16 in Italian, 14 in English) in 12 areas (auth, billing, warehouse, UI, documents, database, performance, CI, translations, email, search, logging), with six "on topic" actions each, written the way the office records them (tool, file, a piece of the result). The "off topic" actions of a task are the on-topic actions of a task from another area. 11 tasks are marked `syn`: their actions talk about the task with different words or in the other language ("Aggiusta il login" → `authentication.ts`, `signIn`, credentials). Plus 4 tasks that cannot be measured (`Zzyzx quux frobnicate`, "Vai avanti", …). No real data.
- **AUC:** for each task, the probability that an on-topic action is closer to the task than an off-topic one (plain cosine, before the widening of the goal); the mean over the tasks. 1 is perfect, 0.5 is chance.
- **Background (zero):** the mean similarity between a task and the actions that have nothing to do with it. Neural models have a high background; the engine rescales the scores from it: `(s − zero) / (1 − zero)`.
- **Widening (widen):** the north star widens the task with the closest of the first actions. For a neural source every text is a little similar to every other, so a task that cannot be measured would widen anyway and look measurable. `widen` is the minimum rescaled score for an early action to widen the task: halfway between the best early action of the tasks that cannot be measured and the 5th percentile of the real ones. For TF-IDF it is 0 (any shared word), as before.
- **Drift:** 60 simulated sessions, through the real `alignment()` and the real rule (`drift-rule.js`): 8 on-topic actions, then 12 more on topic (control) or 12 off topic (drift). For each threshold `rel` from 0.05 to 0.95: the share of drifts caught (true) and of controls flagged (false). Sessions whose base is under `weak` are not judged, as in the engine. Two thresholds are reported: Youden's (the middle of the interval that maximizes true − false) and the **proposed** one, the middle of the thresholds that catch at least 90% of the drifts with no false alarm (Youden's when there are none). The proposed one leaves room on both sides; Youden's tends to sit right next to the first false alarm.
- **Not measurable (weak):** the base of the real tasks (5th percentile) against the highest base of the tasks that cannot be measured.

## Results

Measured on 2026-11-18.

| Source | AUC | AUC on synonyms | Worst task | Background (zero) | widen | Drift: Youden `rel` (true / false) | Drift: proposed `rel` (true / false) | Drift with the threshold in use (true / false / not judged) | `weak` suggested (in use) |
|---|---|---|---|---|---|---|---|---|---|
| `tfidf` | 0.785 | 0.547 | 0.302 | 0.011 (0 used) | 0 | 0.64 (0.867 / 0) | 0.64, none reaches 90% | 0.35: 0.80 / 0 / 0.117 | 0.03 (0.031) |
| `fake:synonyms` (demo only) | 0.941 | 0.917 | 0.604 | 0.621 | 0.381 | 0.87 (1.0 / 0) | **0.53** (0.933 / 0) | 0.53: 0.933 / 0 / 0 | **0.309** |
| `ollama:qwen3-embedding:0.6b` (0.64 GB) | **0.989** | **0.979** | **0.938** | 0.348 | 0.277 | 0.70 (1.0 / 0) | **0.62** (1.0 / 0) | | **0.299** |
| `ollama:qwen3-embedding:4b` (2.5 GB) | 0.995 | 0.989 | 0.885 | 0.404 | 0.34 | 0.65 (1.0 / 0) | **0.62** (1.0 / 0) | | **0.325** |
| `ollama:embeddinggemma-2:570m` (0.92 GB) | 0.975 | 0.940 | 0.781 | 0.620 | 0.167 | 0.74 (1.0 / 0) | **0.68** (1.0 / 0) | | **0.278** |
| `ollama:snowflake-arctic-embed2` (1.16 GB) | 0.971 | 0.954 | 0.708 | 0.240 | 0.174 | 0.72 (1.0 / 0) | **0.62** (1.0 / 0) | | **0.222** |
| `ollama:nomic-embed-text-v2-moe` (0.96 GB) | 0.960 | 0.928 | 0.729 | 0.218 | 0.04 | 0.81 (1.0 / 0) | **0.78** (1.0 / 0) | | **0.227** |
| `ollama:bge-m3` (1.16 GB) | 0.950 | 0.922 | 0.750 | 0.399 | 0.14 | 0.70 (1.0 / 0) | **0.66** (1.0 / 0) | | **0.186** |
| `ollama:nomic-embed-text:v1.5` (0.27 GB) | 0.761 | 0.579 | 0 | 0.509 | 0 | 0.86 (0.8 / 0) | 0.86, none reaches 90% | | 0.03 — **does not beat TF-IDF, no row** |
| `onnx:Xenova/multilingual-e5-small` (q8, 130 MB) | 0.845 | 0.689 | 0 | 0.806 | 0.11 (not separated: 0 / 0.11) | 0.91 (0.8 / 0) | 0.91, none reaches 90% | | 0.031 — **does not beat TF-IDF on drift, no row** (replaced in 2.12.1) |
| `onnx:onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8, 585 MB) | 0.935 | 0.867 | 0.396 | 0.382 | 0.194 | 0.77 (0.967 / 0) | **0.71** (0.967 / 0) | | **0.121** |

The table of `drift-rule.js` has two rows: `tfidf` (`rel` 0.35, `run` 6, `weak` 0.031, `warn` 0.6, `floor` 0.03, `zero` 0, `widen` 0) and `fake:synonyms` (`rel` 0.53, `run` 6, `weak` 0.309, `warn` 0.78, `floor` 0.03, `zero` 0.621, `widen` 0.381). `warn` (the yellow band) is `rel` + 0.25, at most 0.95 (so 0.95 for `nomic-embed-text-v2-moe`, whose `rel` is 0.78). A test recomputes the `fake:synonyms` row from the measure and fails if the table and the measure disagree.

What the TF-IDF numbers say:

- On words it works (AUC 0.785, no false alarms with 0.35), but **on synonyms it is close to chance** (0.547): exactly the case the neural sources are for. 11.7% of the sessions cannot be judged at all, because the task's words never appear in the work (all of them `syn` tasks).
- A higher `rel` (0.64) would catch one drift more out of 30, still without false alarms. The TF-IDF thresholds were **not** changed: the 2.11 tests (`drift`, `driftBack`) must pass unchanged, and 30 tasks are too few to move a threshold that works.
- `weak` 0.031 sits right above the floor of the base (0.03): it is what separates "never a word of the task" from everything else, and the measure confirms it.

About `fake:synonyms`: it is the hidden provider of the demo (`src/core/embed/fake.js`, `embedEngine = 'fake'`, demo sessions only). It is **not a model**: a small dictionary that maps synonyms in Italian and English to the same concept, with a constant component that imitates the background similarity of neural models. Its dictionary was written knowing the areas of the test set, so its numbers are not evidence about neural models; they show that the whole chain (rescaling from the background, widening, thresholds per source, map and engine agreeing) works with a source that is not TF-IDF, and they drive the "synonyms" scene of the demo.

## Real models (Ollama), measured on 2026-11-18

With Max's permission Ollama 0.40.14 was started on this computer (loopback only) and the seven embedding models already in its folder were measured; nothing was downloaded. The rows of the table above with a bold proposed `rel` are now in `drift-rule.js` (the "in use" column is the same as the proposed one).

- **Six of seven beat TF-IDF clearly**: on synonyms the AUC goes from 0.547 to 0.92–0.99; every drift of the simulated sessions is caught, with no false alarm and no session left unjudged (TF-IDF: 80%, and 11.7% unjudged).
- **`nomic-embed-text:v1.5` does not** (AUC 0.761, synonyms 0.579): it is mostly an English model. It has no row, so with it the drift rule says "not measurable".
- **Recommended for Italian: `qwen3-embedding:0.6b`**: the best AUC overall together with the 4b one, by far the best worst task (0.938), and the smallest of the good ones (0.64 GB). It is now the first choice when `embedModel` is empty and the model proposed with `ollama pull` when there is none. Then `qwen3-embedding:4b`, `embeddinggemma`, `snowflake-arctic-embed2`, `nomic-embed-text-v2-moe`, `bge-m3`.
- Caveats: `widen` is tight for `bge-m3` (0.141 against 0.139) and `embeddinggemma` (0.173 against 0.162), so with them a task that cannot be measured may occasionally look measurable. The set is small (30 tasks) and written for the purpose; real sessions may need the thresholds revisited.
- End-to-end check with the real engine (web mode, demo, `embedEngine = ollama`, model chosen automatically): `qwen3-embedding:0.6b`, 1024 dimensions, the bubble switched to it after about 1 s. The "synonyms" scene went from "drifting for 10 actions" (TF-IDF) to "leaving · 72%", not drifting; the Plan subagent that really drifts into the UI components stayed "drifting for 13 actions".
- That check found a real bug that the fake Ollama could not show: loading a model the first time takes more than 5 s; the request was cut at 5 s, which made Ollama cancel the load, and after three tries the source was suspended. Now a "cold" model gets up to 60 s (for `ready()` and the first batch), Ollama is asked to keep it loaded for 10 minutes (`keep_alive`), and while it is warm the 5 s limit applies again. The ONNX provider had the same problem in the queue and is fixed the same way.

## The ONNX model, measured on 2026-11-18

At Max's request `npm run embed:onnx:install` was run (53 npm packages, `@huggingface/transformers` 3.7.6, 378 MB in `optional/embed-onnx/node_modules`; the model `Xenova/multilingual-e5-small` q8, 130 MB, in the data folder of the development loop) and the model was measured.

- It separates better than TF-IDF (AUC 0.845 against 0.785, synonyms 0.689 against 0.547), but **it does not beat TF-IDF on drift**: 80% of the drifts caught, as TF-IDF with its threshold in use and less than TF-IDF's best (86.7%), and no threshold reaches 90%. All its similarities sit in a narrow band (background 0.806), and on the Italian tasks whose actions use other words or English it does not separate at all (worst task 0: "I totali dei documenti di vendita non tornano di un centesimo"; all scores between 0.76 and 0.85). Checked task by task: it is the model, not the measure.
- So it has no row: it is "not calibrated". Since an uncalibrated source would make the drift rule say "not measurable", worse than TF-IDF, **`auto` now uses only calibrated sources**: with Ollama off and only the ONNX model installed, automatic mode stays lexical, without starting the model. Chosen by hand (`embedEngine = onnx`) it is used for the bubble, and the options say "not calibrated: automatic mode skips it, and chosen by hand it does not judge drift".
- End to end in the real engine: chosen by hand, the worker loaded the model and the bubble switched to `onnx:Xenova/multilingual-e5-small` (384 dimensions) in about 1.6 s; in `auto` with Ollama off the engine stayed on TF-IDF.

## Qwen3-Embedding in ONNX, measured on 2026-11-18 (2.12.1)

The same model that is best on Ollama, in the ONNX version of `onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8, `model_quantized.onnx`, 585 MB; Apache-2.0), with the pooling it needs (the last token) and the same instruction in front of the task as on Ollama (none in front of the actions). Measured with the same set and the same script, the model in a temporary data folder.

- **It beats TF-IDF on both counts**: AUC 0.935 against 0.785, on synonyms 0.867 against 0.547, worst task 0.396 against 0.302; drift: with the proposed `rel` 0.71, 96.7% of the drifts caught with no false alarm (TF-IDF: 80% with its threshold in use, 86.7% at best). So it has a row in `drift-rule.js` and **it replaces `Xenova/multilingual-e5-small`** as the model of `npm run embed:onnx:install`; with Ollama off and this model installed, automatic mode uses it.
- It is below the same model on Ollama (AUC 0.989, synonyms 0.979, every drift caught): most likely the 8-bit quantization. With Ollama on, automatic mode still prefers Ollama.
- **Caveats**: `widen` is tight (0.194, the best early action of the tasks that cannot be measured, against 0.189, the 5th percentile of the real ones), and the suggested `weak` (0.121) sits above the 5th percentile of the base of the real tasks (0.092): with this model a few real tasks may be reported as "not measurable" rather than judged. The set is small (30 tasks) and written for the purpose.
- Cost: about 380 MB of npm packages and 585 MB of model, against about 130 MB for e5-small.

The commands, to measure again:

```
node scripts/embed-eval.js --source ollama --model qwen3-embedding:0.6b
node scripts/embed-eval.js --source onnx                  # the installed model (Qwen3-Embedding)
```

The script measures the background and `widen`, uses them as the engine would, and prints the row for `drift-rule.js` (`zero`, `widen`, the proposed `rel`, `warn`, the suggested `weak`). The row goes into the table **only if the source beats TF-IDF** on AUC and on the drift test.

Still true:

- a neural source without a row in the table (`nomic-embed-text:v1.5`, the old ONNX e5-small, any other model) is "not calibrated": in `auto` it is skipped (the chain moves on, down to TF-IDF, and it is not even loaded); chosen by hand it is used, and the bubble and the north star show its geometry, but the drift rule says "not measurable" (engine, feedback and map alike) instead of guessing;
- **the default engine is `auto`** (`embedEngine` in `DEFAULT_SETTINGS`), as the plan allows once a neural source beats TF-IDF, and decided by Max on 2026-11-18. On a computer where Ollama runs with an embedding model, Platypus uses it on its own (snippets of the agents' text go to that local Ollama, which keeps the model loaded for 10 minutes); without Ollama nothing changes, it stays lexical. `tfidf` in the options turns it off.
