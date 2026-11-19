# Storage measurements

Numbers for the store of Platypus 2.13 (`docs/plans/2.13-storage.md`). They come from `scripts/store-bench.js`, which writes synthetic steps into a temporary folder and removes it at the end.

To repeat them:

```sh
node scripts/store-bench.js            # one million steps, about a minute and a half
node scripts/store-bench.js --check    # exit code 1 if a target is missed
node scripts/store-bench.js --json     # the numbers as JSON
```

## The data

- 1,000,000 steps spread evenly over 90 days, across 20 projects and about 4,000 sessions.
- Each step has the fields planned for the `steps` collection (S7): `project` (a 40-character key), `t`, `session`, `agent`, `action`, `tool`, `target` (a relative path), `outcome`, `phase` and, on errors, a normalised error signature. No text.
- Two indexes: `(project, t)` and `(session, t)`.
- Steps are written with `append`, through the write queue, as the engine will do.

## S3 · SQLite backend, 2026-11-19

Machine: Windows 11 (x64), AMD Ryzen 9 9955HX, Node.js 24.13.0, SQLite 3.50.4.

| Measure | Target | Result |
|---|---|---|
| Ingest (`append` with the queue, 500 documents per transaction) | at least 1,000 steps per second | **12,442 steps per second** |
| The 100 most recent steps of a project in the last 30 days (16,591 match) | under 50 ms | **0.40 ms** median, 2.43 ms maximum over 40 runs |
| The 100 most recent errors of a project in the last 30 days | | 1.24 ms |
| Counting the steps of a project in the last 30 days | | 1.52 ms |
| Reading all 16,591 of them, whole documents | | 89 ms |
| Reading all 16,591 of them, only `t` and `outcome` | | 86 ms |
| The steps of one session (256) | | 0.97 ms |
| Database size | | **355 MB per million steps** (372 bytes per step) |

With 100,000 steps the same queries take 0.33 ms, 1.30 ms, 0.15 ms and 7 ms, ingest runs at 23,600 steps per second, and the size per step is the same.

For comparison, the `memory` backend with 100,000 steps: ingest at 216,000 steps per second, and 8 ms for the 100 most recent steps of a project (it has no indexes: every query reads everything).

## S4 · Opening the database, 2026-11-19

Same machine and data. At start-up the store runs `PRAGMA quick_check`, reads the schema version and makes one small write.

| Measure | Result |
|---|---|
| Reopening the database with one million steps (355 MB), file already in the system cache | **600 ms** |

The time grows with the size of the file, because `quick_check` reads every page. It was not measured with a cold cache, where it can only be slower. The engine must therefore not wait for the store before it starts serving the office (see S9).

## S9 · Opening a large database, 2026-11-19

From S9, a database larger than 64 MB is not checked when it opens: the check runs right after, in a worker thread, while the office is already working.

| Measure | Result |
|---|---|
| Reopening the database with one million steps (355 MB) | **12 ms** (it was 600 ms with the check at opening) |

Same run: ingest 8,113 steps per second and 0.26 ms for the 100 most recent steps of a project (both targets met). The ingest figure is lower than in S3 because this run shared the machine with the API comparison and two full test runs; it is not a regression measured on its own.

## S12 · History over six months, 2026-11-19

Six months of session summaries, as the history of S12 reads them: 20 projects, 15 sessions a week each (7,800 sessions), all ten metrics per week with their trend reading, read in one pass (`queryAll`).

| Measure | Target | Result |
|---|---|---|
| One project, all metrics, 26 weeks | under 200 ms | **5 ms** (benchmark), 16–20 ms (test suite) |
| All projects, all metrics, 26 weeks | under 200 ms | **65 ms** (benchmark), 62–63 ms (test suite) |

A first version queried the sessions once per metric: 359 ms for all projects. Reading them once for all metrics brought it to 65 ms. No materialised weekly aggregates were needed.

**Ingest, compared like with like.** On one million steps, ingest measured 12,442 steps per second in S3 and 8,113–8,133 later. Run side by side on 200,000 steps, the code of S3 (`f14cc19`) and the code of S12 give the same speed: 14,608 and 14,416 against 13,926 and 14,492 steps per second, two runs each. The drop on the long runs comes from the state of the machine at that moment, not from the code; the note in S9 that blamed the parallel load was a guess, now checked.

## What the numbers say

- **Both targets are met with a wide margin.** Ingest is 12 times the target; the query the office needs is 100 times faster than the target.
- **The query plan is the reason.** For "project and time, newest first" SQLite walks the `(project, t)` index backwards and stops at the limit. A unit test (`scripts/unit-store.js`) checks that the plan uses the index and does not sort the whole result.
- **Reading many whole documents is the slow path:** about 5 ms per thousand, most of it parsing JSON. Asking for a few `fields` does not help, because the projection happens after parsing. The history of S12 should therefore count and aggregate in SQL, or keep weekly aggregates in `daily`, and not read steps one by one.
- **Size is the number to watch.** At 372 bytes per step, the soft limit of 200 MB planned in S10 holds about 540,000 steps. The synthetic rate here is 11,000 steps a day; a real desktop is expected to produce far fewer, but nobody has measured it yet (S15 will, on real data).
- **Where the bytes go** (estimates from the row layout, not measured page by page): the JSON document is about 170 bytes; the project key is stored once in its column and once in the `(project, t)` index, 40 characters each time; the `_id` (26 characters) is in the table and in its primary-key index; the `(session, t)` index adds about 30 bytes. If size becomes a problem, the cheapest saving is a short per-project number in place of the 40-character key inside the tables, which would take roughly 80 bytes off each step.
