# Platypus · Calibration of the meaning sources

Results of `scripts/embed-eval.js` (plan `docs/plans/neural-embeddings.md`, task E5). The thresholds that the engine uses are in the table of `src/core/drift-rule.js`, one row per measured source.

## How it is measured

- **Test set:** `scripts/embed-eval-set.js`, 30 tasks written for the purpose (16 in Italian, 14 in English) in 12 areas (auth, billing, warehouse, UI, documents, database, performance, CI, translations, email, search, logging), with six "on topic" actions each, written the way the office records them (tool, file, a piece of the result). The "off topic" actions of a task are the on-topic actions of a task from another area. 11 tasks are marked `syn`: their actions talk about the task with different words or in the other language ("Aggiusta il login" → `authentication.ts`, `signIn`, credentials). Plus 4 tasks that cannot be measured (`Zzyzx quux frobnicate`, "Vai avanti", …). No real data.
- **AUC:** for each task, the probability that an on-topic action is closer to the task than an off-topic one (plain cosine, before the widening of the goal); the mean over the tasks. 1 is perfect, 0.5 is chance.
- **Background (zero):** the mean similarity between a task and the actions that have nothing to do with it. Neural models have a high background; the engine rescales the scores from it: `(s − zero) / (1 − zero)`.
- **Drift:** 60 simulated sessions, through the real `alignment()` and the real rule (`drift-rule.js`): 8 on-topic actions, then 12 more on topic (control) or 12 off topic (drift). For each threshold `rel` from 0.05 to 0.95: the share of drifts caught (true) and of controls flagged (false). Sessions whose base is under `weak` are not judged, as in the engine. The best threshold maximizes true − false (Youden), taking the middle of the best interval.
- **Not measurable (weak):** the base of the real tasks (5th percentile) against the highest base of the tasks that cannot be measured.

## Results

Measured on 2026-11-18.

| Source | AUC | AUC on synonyms | Worst task | Background | Drift: best `rel` (true / false) | Drift with the threshold in use (true / false / not judged) | `weak` suggested (in use) |
|---|---|---|---|---|---|---|---|
| `tfidf` | 0.785 | 0.547 | 0.302 | 0.011 | 0.64 (0.867 / 0) | 0.35: 0.80 / 0 / 0.117 | 0.03 (0.031) |
| `ollama:*` | not measured | | | | | | |
| `onnx:Xenova/multilingual-e5-small` | not measured | | | | | | |

What the TF-IDF numbers say:

- On words it works (AUC 0.785, no false alarms with 0.35), but **on synonyms it is close to chance** (0.547): exactly the case the neural sources are for. 11.7% of the sessions cannot be judged at all, because the task's words never appear in the work (all of them `syn` tasks).
- A higher `rel` (0.64) would catch one drift more out of 30, still without false alarms. The TF-IDF thresholds were **not** changed: the 2.11 tests (`drift`, `driftBack`) must pass unchanged, and 30 tasks are too few to move a threshold that works.
- `weak` 0.031 sits right above the floor of the base (0.03): it is what separates "never a word of the task" from everything else, and the measure confirms it.

## Neural sources: not measured yet

Measuring a real model needs Max's permission: starting Ollama (the models `bge-m3`, `snowflake-arctic-embed2`, `embeddinggemma`, `qwen3-embedding` and `nomic-embed-text` are already in its folder) or installing the ONNX model (`npm run embed:onnx:install`, about 320 MB). The commands are:

```
node scripts/embed-eval.js --source ollama --model bge-m3
node scripts/embed-eval.js --source onnx
```

The script makes two passes: the first measures the background, the second rescales from it, as the engine does. A row goes into the table of `drift-rule.js` with the measured `zero`, the best `rel` and the suggested `weak`, **only if the source beats TF-IDF** on AUC and on the drift test.

Until then:

- a neural source without a row in the table is "not calibrated": the bubble and the north star show its geometry, but the drift rule says "not measurable" (engine, feedback and map alike) instead of guessing;
- **the default engine is `tfidf`** (`embedEngine` in `DEFAULT_SETTINGS`): the plan says to leave TF-IDF as the default when the neural source does not beat it, and so far nothing has been shown to beat it.
