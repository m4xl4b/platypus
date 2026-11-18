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
| `ollama:*` | not measured | | | | | | | | |
| `onnx:Xenova/multilingual-e5-small` | not measured | | | | | | | | |

The table of `drift-rule.js` has two rows: `tfidf` (`rel` 0.35, `run` 6, `weak` 0.031, `warn` 0.6, `floor` 0.03, `zero` 0, `widen` 0) and `fake:synonyms` (`rel` 0.53, `run` 6, `weak` 0.309, `warn` 0.78, `floor` 0.03, `zero` 0.621, `widen` 0.381). `warn` (the yellow band) is `rel` + 0.25. A test recomputes the `fake:synonyms` row from the measure and fails if the table and the measure disagree.

What the TF-IDF numbers say:

- On words it works (AUC 0.785, no false alarms with 0.35), but **on synonyms it is close to chance** (0.547): exactly the case the neural sources are for. 11.7% of the sessions cannot be judged at all, because the task's words never appear in the work (all of them `syn` tasks).
- A higher `rel` (0.64) would catch one drift more out of 30, still without false alarms. The TF-IDF thresholds were **not** changed: the 2.11 tests (`drift`, `driftBack`) must pass unchanged, and 30 tasks are too few to move a threshold that works.
- `weak` 0.031 sits right above the floor of the base (0.03): it is what separates "never a word of the task" from everything else, and the measure confirms it.

About `fake:synonyms`: it is the hidden provider of the demo (`src/core/embed/fake.js`, `embedEngine = 'fake'`, demo sessions only). It is **not a model**: a small dictionary that maps synonyms in Italian and English to the same concept, with a constant component that imitates the background similarity of neural models. Its dictionary was written knowing the areas of the test set, so its numbers are not evidence about neural models; they show that the whole chain (rescaling from the background, widening, thresholds per source, map and engine agreeing) works with a source that is not TF-IDF, and they drive the "synonyms" scene of the demo.

## Neural sources: not measured yet

Measuring a real model needs Max's permission: starting Ollama (the models `bge-m3`, `snowflake-arctic-embed2`, `embeddinggemma`, `qwen3-embedding` and `nomic-embed-text` are already in its folder) or installing the ONNX model (`npm run embed:onnx:install`, about 320 MB). The commands are:

```
node scripts/embed-eval.js --source ollama --model bge-m3
node scripts/embed-eval.js --source onnx
```

The script measures the background and `widen`, uses them as the engine would, and prints the row for `drift-rule.js` (`zero`, `widen`, the proposed `rel`, `warn`, the suggested `weak`). The row goes into the table **only if the source beats TF-IDF** on AUC and on the drift test.

Until then:

- a neural source without a row in the table is "not calibrated": the bubble and the north star show its geometry, but the drift rule says "not measurable" (engine, feedback and map alike) instead of guessing;
- **the default engine is `tfidf`** (`embedEngine` in `DEFAULT_SETTINGS`): the plan says to leave TF-IDF as the default when the neural source does not beat it, and so far nothing has been shown to beat it.
