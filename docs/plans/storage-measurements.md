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

## What the numbers say

- **Both targets are met with a wide margin.** Ingest is 12 times the target; the query the office needs is 100 times faster than the target.
- **The query plan is the reason.** For "project and time, newest first" SQLite walks the `(project, t)` index backwards and stops at the limit. A unit test (`scripts/unit-store.js`) checks that the plan uses the index and does not sort the whole result.
- **Reading many whole documents is the slow path:** about 5 ms per thousand, most of it parsing JSON. Asking for a few `fields` does not help, because the projection happens after parsing. The history of S12 should therefore count and aggregate in SQL, or keep weekly aggregates in `daily`, and not read steps one by one.
- **Size is the number to watch.** At 372 bytes per step, the soft limit of 200 MB planned in S10 holds about 540,000 steps. The synthetic rate here is 11,000 steps a day; a real desktop is expected to produce far fewer, but nobody has measured it yet (S15 will, on real data).
- **Where the bytes go** (estimates from the row layout, not measured page by page): the JSON document is about 170 bytes; the project key is stored once in its column and once in the `(project, t)` index, 40 characters each time; the `_id` (26 characters) is in the table and in its primary-key index; the `(session, t)` index adds about 30 bytes. If size becomes a problem, the cheapest saving is a short per-project number in place of the 40-character key inside the tables, which would take roughly 80 bytes off each step.
