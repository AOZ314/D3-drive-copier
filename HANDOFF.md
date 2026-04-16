# D3 — Technical Handoff Document

_Written for any developer (human or AI) who wants to understand, maintain, or extend D3. Covers architecture, every design decision, complete data schemas, all key functions, known limitations, and critical constraints. No prior knowledge of the codebase is assumed._

---

## Table of Contents

1. [What D3 Is](#1-what-d3-is)
2. [Architecture Overview](#2-architecture-overview)
3. [Storage Model](#3-storage-model)
4. [ScriptProperties Schema](#4-scriptproperties-schema)
5. [Config Constants](#5-config-constants)
6. [Job Object Schema](#6-job-object-schema)
7. [Conflict Strategies](#7-conflict-strategies)
8. [Backend — Public API Functions](#8-backend--public-api-functions)
9. [Backend — Internal Helpers](#9-backend--internal-helpers)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Permission Copying](#11-permission-copying)
12. [Known Limitations](#12-known-limitations)
13. [Design Decisions Reference](#13-design-decisions-reference)
14. [Critical Rules — Never Break These](#14-critical-rules--never-break-these)

---

## 1. What D3 Is

D3 is a **standalone Google Apps Script web app** that recursively copies Google Drive folder trees. It is deployed as a web app, served via `doGet()`, and runs entirely on Google's servers with no third-party dependencies.

**Two source files:**
- `Code.gs` — all backend logic (~1300 lines)
- `App.html` — complete frontend: HTML, CSS, JavaScript (~2700 lines)

**One manifest:**
- `appsscript.json` — declares OAuth scopes, runtime version, Drive Advanced Service, web app settings

The app is deployed with `executeAs: USER_ACCESSING`. Each user who opens D3 runs the script under their own Google account — the deployer never has access to any user's Drive data.

---

## 2. Architecture Overview

### Entry point and serving

`doGet()` is the sole entry point. It serves `App.html` using `HtmlService.createHtmlOutputFromFile('App')`. **Never add `onOpen()`, `showSidebar()`, or any `SpreadsheetApp` calls** — this is not a Sheets add-on, those will throw errors.

### How copying works

Copying is driven by **Apps Script's time-based trigger system**, not by a long-running HTTP request. The flow is:

1. User confirms a job in the preflight modal → `enqueueJob()` is called → job written to `UserProperties` → a 1-second trigger fires `processBatch()`
2. `processBatch()` runs for up to 5.5 minutes, copies as many items as it can
3. At the end of each batch, if work remains, `processBatch()` schedules itself to run again in 60–120 seconds (depending on throttle setting)
4. This continues until the job is done, paused, or cancelled

The user can close their browser tab at step 2 — copying continues on Google's servers because triggers run independently of browser sessions.

### The ScriptLock

`processBatch()` acquires `LockService.getUserLock()` for its **entire run**. This prevents two batch runs from colliding on the same user's properties. Every other function that writes to properties must also acquire the lock briefly — but `processBatch` having it means those functions can never write during a batch run. The **cooperative pause/cancel flag pattern** exists specifically to work around this: instead of writing job status directly (which would need the lock), `pauseJob` and `cancelJob` write a short "please stop" flag to properties without the lock, and `processBatch` reads and acts on that flag after each file.

### Required setup

The **Drive Advanced Service** must be enabled in the Apps Script Editor (Services → Drive API v3). It is required for `Drive.Files.list()`, `Drive.Files.get()`, `Drive.Files.copy()`, and `Drive.About.get()`. Without it, folder browsing, size estimation, Google-native file copying, and permission reading all fail.

### Apps Script platform limits

| Constraint | Value | How D3 handles it |
|---|---|---|
| Max execution time | 6 minutes | `CONFIG.MAX_BATCH_MS = 5.5 min` — loop exits before the limit |
| ScriptProperties per key | 9 KB | `saveJobs_()` auto-prunes terminal jobs; `dc_wq_` and `dc_fm_` are separate keys |
| ScriptProperties total | 500 KB | Each user's storage is independent; job + queue data is small |
| Trigger minimum interval | 1 minute | Inter-batch delay is 60–120s depending on throttle |
| Drive copy speed | ~0.5–2s/file | This is a Google-imposed ceiling, not a code limitation |

---

## 3. Storage Model

**All persistent state uses `PropertiesService.getUserProperties()` and `LockService.getUserLock()`** — both are scoped to the current user running the script. This means:

- Each Google account that accesses the web app has a completely separate job queue, settings, quota counters, and history
- There is no shared state between accounts — two people using the same deployed app cannot see each other's jobs
- When a time-based trigger fires, it runs as the user who created it; `getUserProperties()` correctly accesses that user's data

`getScriptProperties()` (which is shared across all users of a deployment) is **never used**. Do not introduce it.

---

## 4. ScriptProperties Schema

All keys are per-user via `getUserProperties()`.

| Key | Type | Description |
|---|---|---|
| `dc_jobs` | JSON array | All job metadata objects. **Never** contains workQueue or folderMap data |
| `dc_active` | string | Job ID of the currently-running job |
| `dc_pause` | string | Cooperative pause flag — written as jobId by `pauseJob`, read by `processBatch` |
| `dc_cancel` | string | Cooperative cancel flag — same pattern as pause |
| `dc_wq_<jobId>` | JSON array | Per-job work queue: `[{ sourceId, targetParentId, parentPerms }, …]` |
| `dc_fm_<jobId>` | JSON object | Per-job folder map: `{ [sourceFolderId]: createdDestFolderId }` — prevents duplicate folder creation across batch runs |
| `dc_advsettings` | JSON object | `{ throttle, defaultConflict, allowRootAsSource, scheduledCopying, scheduleHour }` — preserved across `resetState()` |
| `dc_quota` | JSON object | `{ date: 'YYYY-MM-DD', reads: N, writes: N }` — rolling daily API call counts, Pacific date for midnight rollover |

**Why `dc_wq_` and `dc_fm_` are separate keys:** A large folder tree's work queue can easily reach hundreds of entries with serialised `parentPerms` arrays. Embedding those in `dc_jobs` would blow past the 9 KB per-key limit. The jobs array contains only lightweight metadata.

---

## 5. Config Constants

```javascript
const CONFIG = {
  MAX_BATCH_MS:         5.5 * 60 * 1000,  // exit copy loop before 6-min execution limit
  TRIGGER_FUNCTION:     'processBatch',    // must match the actual function name exactly
  SCHEDULE_FUNCTION:    'runScheduled_',   // must match the actual function name exactly
  SAVE_CHECKPOINTS:     20,               // save progress ~20× per job regardless of job size
  MAX_LAST_ERROR_CHARS: 500,              // truncate lastError to keep dc_jobs under size limit
  MAX_DC_JOBS_BYTES:    7168,             // ~7KB — prune terminal jobs when dc_jobs exceeds this
};
```

`TRIGGER_FUNCTION` and `SCHEDULE_FUNCTION` are used by `clearProcessTriggers_()` and `clearScheduleTriggers_()` to find and delete triggers by handler function name. If either value ever changes, the function it names **must also be renamed to match**.

```javascript
const THROTTLE_PRESETS_ = {
  normal:  { maxItems: 150, interBatchMs: 60  * 1000 },
  careful: { maxItems: 75,  interBatchMs: 90  * 1000 },
  slow:    { maxItems: 30,  interBatchMs: 120 * 1000 },
};
```

`processBatch` reads the user's throttle preference from `ADV_SETTINGS` at the start of each batch and uses the preset's `maxItems` and `interBatchMs` instead of the old hardcoded values.

---

## 6. Job Object Schema

```javascript
{
  id:               string,   // 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)
  sourceId:         string,   // Google Drive folder ID of the source
  sourceName:       string,   // display name, captured at enqueue time
  destId:           string,   // Google Drive folder ID of the destination
  destName:         string,
  status:           string,   // see status lifecycle below
  copyPermissions:  boolean,  // captured at enqueue; off by default
  copyGoogleFiles:  boolean,  // if true, native files copied with Drive.Files.copy()
  conflictStrategy: string,   // 'rename'|'skip'|'update'|'overwrite'
  processed:        number,   // folders created + files copied (not skipped or deleted)
  skipped:          number,   // items skipped by conflict strategy (merge/update)
  deleted:          number,   // items trashed by the 'update' cleanup pass
  nativeSkipped:    number,   // Google-native files skipped because copyGoogleFiles=false
  total:            number,   // 0 until countItems_() runs; pre-populated from preflight when possible
  sizeBytes:        number,   // 0 unless preflight scan provides it
  createdAt:        number,   // Date.now()
  updatedAt:        number,   // Date.now() on every save
  currentFolder:    string,   // folder name currently being processed (for UI label)
  lastError:        string,   // last error message; cleared on resumeJob(); truncated to 500 chars
  itemsPerSecond:   number,   // EMA of copy throughput across batches; used for ETA display
}
```

### Status lifecycle

```
pending → running → done
                 → skipped   (conflictStrategy='skip' AND at least one item was skipped)
                 → error     (any thrown exception)
                 → cancelled
         paused  → pending   (on resume, if another job is running)
                → running   (on resume, if no other job is running)
         error  → pending   (on resume — retry from last checkpoint)
```

### Counter semantics

- **`processed`** — items that were actually created or copied. The only counter that drives the progress bar numerator.
- **`skipped`** — items that already existed at the destination and were left in place (merge/update strategy). Also includes folders that were merged into (reused, not created).
- **`deleted`** — items trashed by the update cleanup pass after processing each folder. Recursively counted.
- **`nativeSkipped`** — Google Workspace files (Docs/Sheets/Slides/Forms/Drawings) encountered when `copyGoogleFiles=false`. Not in `skipped` because it's a settings choice, not a conflict.

**Progress bar denominator** = `total - skipped - nativeSkipped` per job. None of the non-processed counters count as "remaining work."

---

## 7. Conflict Strategies

Selected in the preflight modal before each job. The backend value and UI label differ deliberately:

| Backend value | UI label | Behaviour |
|---|---|---|
| `'rename'` | Rename | Default. Everything gets copied; name conflicts resolved by appending `(copy)`, `(copy2)`… |
| `'skip'` | Merge | Merges into existing same-name folders; skips files that already exist at destination |
| `'update'` | Update | Like Merge, but after processing each folder also trashes destination items with no matching name in source — mirrors source by filename |
| `'overwrite'` | Overwrite | Merges into existing folders; trashes same-name files before copying the source version |

**Important:** The UI calls `'skip'` strategy **"Merge"** because "skip" confused users into thinking the whole job would be skipped. The backend string is still `'skip'`. Do not rename it in the backend without a data migration for existing stored jobs.

### Folder conflict handling

`getOrCreateMappedFolder_()` applies conflict strategy to folders:
- `skip`/`overwrite`/`update` → reuse (merge into) existing same-name folder → increments `job.skipped`
- `rename` → create uniquely-named new folder if conflict exists → increments `job.processed`
- `folderMap` records `sourceId → destId` to prevent duplicate folder creation if the same source folder is encountered across batch runs

---

## 8. Backend — Public API Functions

These are called from the frontend via `google.script.run`.

### `enqueueJob(sourceFolderId, destFolderId, settings)`

Two-phase design: all slow work (validation, `getFolderById`, descendant check) happens **before** acquiring the lock. The lock wraps only the property write (~5 lines). This means rapid double-clicks can't cause long waits.

`settings`: `{ copyPermissions, copyGoogleFiles, conflictStrategy, total, sizeBytes }`. `total` and `sizeBytes` come from the preflight scan. If `total = 0`, `processBatch` will run `countItems_()` at activation time.

`shouldKickoff` pattern: checks whether any other job is already `running` before releasing the lock; if not, schedules a 1-second trigger after the lock is released.

Resolves the `'ROOT'` virtual token to the real My Drive folder ID before any validation. The frontend passes `'ROOT'` when My Drive root is assigned as source or destination — `getFolderById('ROOT')` would throw.

### `processBatch()`

The copy engine. **Must be a top-level function** — Apps Script's trigger system calls it by name.

**Activation:** Finds the currently running job via `dc_active`, or promotes the first `pending` job. `job.total === 0` triggers `countItems_()` — this check is intentionally outside the activation `if` block to handle the `pending → pause → resume` path where `total` was never set because the job was paused before its first batch.

**Copy loop per folder task:**
1. `getOrCreateMappedFolder_()` — create or reuse destination folder
2. `cacheTargetFileNames_()` — one `Drive.Files.list` for all existing filenames in the target folder (O(n) savings vs per-file API calls)
3. File loop — `copyFileCached_()` per file; result is `'copied'`/`'skipped'`/`'nativeSkipped'`
4. Enqueue subfolders onto `workQueue`
5. `update` cleanup pass — if strategy is `'update'`, builds source name sets, trashes destination items not in source, increments `job.deleted`

**Periodic save:** Progress saved every `saveInterval` items where `saveInterval = max(1, floor(total / SAVE_CHECKPOINTS))`. Gives ~20 UI updates per job regardless of job size.

**Cooperative pause/cancel:** After every file (including skipped ones), `processBatch` reads `dc_pause` and `dc_cancel`. On pause: current folder's task is unshifted back to the front of `workQueue` so it's re-entered on resume (safe — existing files are skipped by conflict strategy). On cancel: `dc_wq_` and `dc_fm_` are deleted.

**Error handling:** The catch block saves `dc_wq_` and `dc_fm_` using `typeof workQueue !== 'undefined'` guards. This is intentional — the catch can fire before those variables are assigned if the error happens very early. Saving state on error means retrying resumes from the last checkpoint rather than recreating folders from scratch.

**"Always advance" pattern:** After reaching any terminal state, reloads jobs fresh from properties (`const freshJobs = loadJobs_()`) before scheduling the next trigger. This catches jobs that were enqueued while this batch was running.

**EMA throughput tracking:** At the end of each batch, `batchIPS = itemsThisRun / elapsedSeconds` is computed using `copyLoopStartedAt` — a timestamp captured *after* `countItems_()` so counting time doesn't contaminate the throughput measurement. The exponential moving average is `0.3 * batchIPS + 0.7 * previous`, seeding directly on the first batch. Only applied when `itemsThisRun > 0` and `batchElapsedMs > 500ms`.

### `pauseJob(jobId)` / `cancelJob(jobId)`

Two paths depending on status:
- **Running:** Write cooperative flag (`dc_pause`/`dc_cancel`) without acquiring the lock. Returns immediately.
- **Pending/paused:** Acquire brief lock, write status directly.

This two-path design exists because `processBatch` holds the user lock for its entire run — a direct write from `pauseJob` would block until `processBatch` finishes.

`cancelJob` only allows direct cancellation of `pending` or `paused` jobs. Terminal states (`done`/`error`/`skipped`/`cancelled`) are rejected.

### `resumeJob(jobId)`

Clears both `dc_pause` and `dc_cancel` flags before saving — prevents stale flags from immediately re-pausing or re-cancelling the resumed job on its first file. Schedules a 500ms trigger; never calls `processBatch` directly (would cause lock contention).

If another job is currently running, sets status to `'pending'` (re-queued) rather than `'running'`.

### `clearJob(jobId)` / `clearAllTerminal()`

Remove terminal jobs from `dc_jobs`. Active jobs (pending/running/paused) are never touched. Both operate inside a lock.

### `getJobsStatus()`

Returns `{ jobs, summary }`. Summary includes per-status counts, `overallPercent`, and `quota`.

`overallPercent` = `totalProcessed / totalItems` where `totalItems = sum(job.total - job.skipped - job.nativeSkipped)` across all non-cancelled jobs. Both `skipped` and `nativeSkipped` are excluded from the denominator — neither represents remaining work.

**Never exposes `workQueue` or `folderMap` data** — those stay in their separate property keys.

### `scanFolder(folderId)`

Returns `{ itemCount, sizeBytes, estimatedMB, capped }`. Capped at 5,000 items. `sizeBytes` is exact for binary files; Google Workspace files (Docs/Sheets/Slides/Forms) have no size in the Drive API and contribute 0 bytes.

### `getAdvancedSettings()` / `saveAdvancedSettings(settings)`

Load/save the `dc_advsettings` object. `saveAdvancedSettings` validates every field before persisting. It also syncs the daily schedule trigger: calls `clearScheduleTriggers_()` then creates a new `atHour().everyDays(1).inTimezone('America/Los_Angeles')` trigger if `scheduledCopying` is `true`.

### `runScheduled_()`

Top-level trigger handler. Called by the daily schedule trigger when `scheduledCopying` is enabled. Sets all `paused` jobs to `pending`, then fires `processBatch`. **Must remain a top-level function** — the trigger system calls it by name.

### `resetState()`

Nuclear option. Clears all properties and triggers. Preserves `dc_advsettings` by reading it before `deleteAllProperties()` and re-writing it after. Also re-creates the schedule trigger if settings had it enabled.

### `getAppInfo()`

Returns `{ email, appUrl }`. Email is from `Session.getActiveUser().getEmail()`. App URL is from `ScriptApp.getService().getUrl()`. Both used in the account popover — the URL for informational display only (not as a redirect target; see Known Limitations).

---

## 9. Backend — Internal Helpers

### `copyFileCached_(file, targetFolder, strategy, copyPerms, existingNames, copyGoogleFiles, parentPermsArr, batchQuota)`

Returns a string tag: `'copied'`, `'skipped'`, or `'nativeSkipped'`.

- `'nativeSkipped'` — file is a Google Workspace MIME type and `copyGoogleFiles` is false
- `'skipped'` — file already exists at destination and strategy is `'skip'` or `'update'`
- `'copied'` — file was successfully copied (any strategy that proceeds)

For Google-native files when `copyGoogleFiles` is true: uses `Drive.Files.copy()` via the Advanced Service (preserves native format). `makeCopy()` on native files silently exports to Office format — wrong behaviour.

`Drive.Files.copy()` is wrapped in `withRetry_()` — it hits user rate limits more readily than `makeCopy()`.

### `getOrCreateMappedFolder_(sourceFolder, targetParent, folderMap, strategy, batchQuota)`

Checks `folderMap[sourceId]` first (prevents duplicate folder creation if the same source is encountered twice across batch runs). Returns `{ folder, created: boolean }`.

### `applyPermsDiff_(sourceId, target, parentPermsArr, batchQuota)`

Applies only the explicit ACL entries on `sourceId` that aren't already in `parentPermsArr`. Two special cases:
- **Self-skip:** Gets `Session.getActiveUser().getEmail()` and skips any permission entry matching the current user. Without this, copying a folder you own generates a "you shared X with yourself" notification.
- **Owner → writer downgrade:** Entries with `role: 'owner'` are cloned with `role: 'writer'` before being applied. Ownership can't be transferred via the API; this ensures the original owner retains editor access on copies of their content.

Returns the merged permission key array for child items to inherit as their `parentPermsArr`. Capped at 50 keys to prevent `dc_wq_` property bloat.

### `getExplicitPerms_(fileId)`

Calls `Drive.Files.get({ fields: 'permissions(emailAddress,role,type,domain)' })`. Returns all permission entries including the owner (owner entries are handled by the caller, not filtered here).

### `withRetry_(fn, maxRetries, fileName)`

Retries on quota/rate-limit errors (`'rate limit'`, `'quota'`, `'user rate'` in error message). Exponential backoff: 1s, then 2s. Non-quota errors throw immediately without retrying.

### `countItems_(folderId, startedAt)`

Iterative BFS with a 60-second time budget (uses `startedAt` passed from `processBatch`) and a 5,000-item cap (consistent with `scanFolder`). Returns `{ count, partial }`. If `partial: true`, `processBatch` sets `job.total = 0` so the bar stays indeterminate rather than showing a wrong percentage.

Used in two places: at job activation when `total` is unknown, and inside the `update` cleanup pass to count items in folders being deleted.

### `cacheTargetFileNames_(folderId, batchQuota)`

One paginated `Drive.Files.list` call → JavaScript `Set` of all non-folder filenames in `folderId`. O(1) conflict lookups for every file in the loop. The single biggest speed win available without changing the copy mechanism itself.

### `isDescendant_(potentialChildId, ancestorId)`

Walks the parent chain up to 30 levels. Used to block destination-inside-source in `enqueueJob`. Returns `false` conservatively on any error.

### `saveJobs_(jobs)`

Includes auto-pruning: if the serialised jobs array exceeds `CONFIG.MAX_DC_JOBS_BYTES` (7KB), removes the oldest terminal jobs in order: `cancelled` first, then `error`, `skipped`, `done`. Active jobs are never pruned.

### `loadQuota_()` / `addQuota_(reads, writes)` / `saveQuota_(q)`

Rolling daily API call counters. `loadQuota_()` auto-resets when the stored Pacific date doesn't match today. `addQuota_()` is called at the end of every `processBatch` run with that batch's accumulated counts.

---

## 10. Frontend Architecture

### State variables

```javascript
// Folder browser
navStack         // breadcrumb stack: [{ token, name }, ...]
currentView      // currently-loaded getFolderView() result
currentSelection // single-clicked item: { id, name, token, isVirtual }

// Job setup
selectedSource   // { id, name }
selectedTarget   // { id, name }

// Preflight (two parallel API calls, pendingCount tracks completion)
preflightScan, preflightStorage, preflightPending

// Polling
pollTimer        // 2s setInterval handle
storageTimer     // 30s setInterval handle
lastStorageInfo  // cached for re-render when pendingJobBytes changes
pendingJobBytes  // sum of sizeBytes of pending/running jobs (storage bar overlay)

// Job transition tracking
prevJobStates    // { jobId: lastKnownStatus } — fires one-shot error alerts

// Settings and account
advancedSettings // in-memory; loaded from backend on page init
appInfo          // { email, appUrl }; loaded on page init
```

### Folder browser

Home screen shows "My Drive" and "Shared with me" rows as virtual roots (`isVirtual: true`). Clicking into them calls `getFolderView(token)`.

**Virtual root handling in `useSelectedAs(kind)`:**
- `SHARED_ROOT` → blocked with a specific message (it's a listing page, not a real folder)
- `ROOT` as destination → always allowed; passes `'ROOT'` to backend which resolves it to the real ID
- `ROOT` as source → gated by `advancedSettings.allowRootAsSource`; blocked with a message pointing to Advanced Settings when off

### Preflight modal

Triggered by "▶ Start copy". Fires `scanFolder()` and `getStorageInfo()` in parallel; `preflightPending` counts down from 2. Shows item count, size, free space, and a risk badge. Contains a four-option conflict strategy picker pre-selected to `advancedSettings.defaultConflict`.

On confirm, `settings.total` (from scan, or 0 if capped) and `settings.sizeBytes` are passed to `enqueueJob`. Passing the total allows the bar to start determinate; if 0, the backend counts and the bar starts indeterminate.

### Job card rendering

`diffJobList(jobs)` does an in-place DOM diff by `data-job-id` — updates existing cards, adds new ones, removes cleared ones. Never wipes and rebuilds the list, so there's no flicker.

`buildCardHTML(job)` — first render only. `updateJobCard(card, job)` — subsequent updates.

### Progress bars

**Per-job bar:** Two-segment design:
- Green fill: `barPercent(job)` = `processed / (total - skipped - nativeSkipped)`, capped at 100%. Returns 100 for both `done` and `skipped` status (both are terminal successes).
- Orange overflow segment: `skipPercent(job)` = `skipped / effective` capped at 50%. Positioned at `left: barPercent%` — visually represents conflict-skipped items beyond the green fill.
- Indeterminate (animated sweep) when `total === 0` and status is running/pending — except when `processed > 0` and `total === 0`, which is a transient polling race; treated as determinate.

**Global bar:** `sum(processed) / sum(total - skipped - nativeSkipped)` across all non-cancelled jobs. Snaps to 100% when all active jobs are `done` or `skipped`.

### ETA display

`etaLabel(job)` returns a string or `null`. Requires `itemsPerSecond > 0` (at least one complete batch) and `total > 0` (known total). Thresholds: `< 10s` → "almost done", `< 90s` → "~N sec remaining", `< 3600s` → "~N min remaining", otherwise ">1 hour remaining". Falls back to "Copying: [currentFolder]" when null. Only visible for multi-batch jobs (>150 items at default throttle) since small jobs complete before the frontend polls a running state with speed data.

### Alert system

`addAlert(level, title, body, actions?)` — levels: `info`, `warn`, `error`, `good`. Actions are `[{ label, callback }]` rendered as small inline buttons. Alerts prepend (newest first). An error alert with **Retry** + **Cancel** action buttons fires automatically when any job transitions to `error` status, exactly once per occurrence (tracked via `prevJobStates`).

### Advanced settings modal

Reuses `.preflight-overlay` / `.preflight-box` CSS. Exposes: throttle, default conflict strategy, allow-root-as-source toggle, scheduled copying toggle + hour picker, and a "Export CSV" button.

Save path: updates `advancedSettings` in memory immediately (so `useSelectedAs` and `openPreflightPanel` pick it up right away), then fires `saveAdvancedSettings()` backend call.

### Polling lifecycle

- Starts on page load, on job enqueue, on resume
- `allSettled` check: stops polling when every job is `done`/`error`/`cancelled`/`skipped`/`paused`
- `doResumeJob()` calls `startPolling()` so polling restarts when a paused job is resumed

### Copy log export

`exportJobLog()` calls `getJobsStatus()` then formats the jobs array as CSV entirely client-side. Triggers a `<a download>` blob URL. No extra backend function.

### Storage display

In the queue card header. Two fills in a single `display:flex` track:
- Solid coloured fill = `usedBytes / totalBytes`
- Desaturated green fill = `pendingJobBytes / totalBytes` (capped to available space)
- Colour: green (`free > 20%`), yellow (`free 5–20%`), red (`free < 5%`)
- Refreshes every 30s and whenever `pendingJobBytes` changes

### Quota display

In the queue card header, below storage. Hidden until D3 has made at least one API call in the current calendar day. Shows raw read/write counts + reset time. No percentage bars — Google doesn't expose actual remaining quota via any API, and the community-cited limits vary by account type.

---

## 11. Permission Copying

Enabled per-job via the "Copy permissions" toggle (off by default).

### How it works

`applyPermsDiff_(sourceId, target, parentPermsArr, batchQuota)` is called for each created folder and each copied file. It:

1. Gets only the **explicitly-set** permissions on the source item via `Drive.Files.get({ fields: 'permissions' })` — this excludes inherited permissions, which is what prevents the email notification flood
2. Diffs against `parentPermsArr` — a serialised set of permission keys already applied by ancestor folders — to skip re-applying permissions the target inherits from its parent
3. Skips the current user's own email — adding yourself as editor on a file you own generates a "you shared X with yourself" notification
4. Downgrades `owner` entries to `writer` — ownership can't be transferred via the API; this ensures the original owner of shared content retains editor access on your copy
5. Applies `anyone`/`domain` link-sharing via `setSharing()`
6. Returns the merged key set for child items to inherit

`parentPermsArr` is stored in each `dc_wq_` task so it survives across batch runs. It's capped at 50 entries to prevent property bloat.

### Known limitation

Link-sharing (`anyone with link` / `domain`) applied via `setSharing()` may be silently overridden by the destination folder's own sharing restrictions in some Drive configurations. This is a Drive API constraint, not a code bug — the call is made but Drive may not honour it.

---

## 12. Known Limitations

### Account switching

Apps Script web apps have no programmatic account switching. The OAuth session is set at the browser level before any code runs. There is no Google API (including Admin SDK) that can change which account a running script is authenticated as. To use D3 with a different account: open it in a private/incognito window or a separate browser profile.

### ETA only visible for large jobs

The ETA display requires at least one complete batch run. Jobs with ≤150 items (at normal throttle) complete in a single batch and transition directly from running to done — the frontend never polls a running state with throughput data. ETA is most useful for large multi-batch jobs.

### Copy speed ceiling

`makeCopy()` takes approximately 0.5–2 seconds per file. This is a Google-imposed limit — there is no way to copy files faster using native Apps Script APIs. Normal throughput is ~15–60 files per minute. For large folders this is the dominant time factor.

### `sizeBytes` undercount

`scanFolder` returns 0 bytes for Google Workspace files (Docs, Sheets, Slides, Forms, Drawings) because the Drive API does not return a file size for them — they are stored as metadata and don't consume Drive quota. The preflight size stat and risk assessment are accurate only for folders containing regular (binary) files.

### Progress bar indeterminate for very large folders

If `scanFolder` returns `capped: true` (5,000+ items), `total = 0` is passed to the backend. `countItems_()` is called at batch activation with a 60-second budget. If it also times out or caps, `job.total` stays 0 and the bar remains indeterminate for the entire job. Progress is still tracked numerically in `job.processed`.

### First-run permissions onboarding

Investigated and not feasible. Apps Script blocks all page access until Google's native OAuth consent screen completes. No code runs before it. `appsscript.json` can declare `oauthScopes` to control which permissions appear and add a description, but cannot inject custom UI before or during the screen.

### Clear button speed

`clearJob()` acquires lock + writes + re-reads all jobs. Typically 500ms–1s. Acceptable.

---

## 13. Design Decisions Reference

**Standalone web app only.** `doGet()` is the sole entry point. No Sheets add-on, no `onOpen()`, no `SpreadsheetApp`. Those will throw errors in this context.

**Sequential job execution.** One job runs at a time. Apps Script's single-threaded trigger model makes true parallel execution impractical — multiple concurrent `processBatch` runs would fight over the same lock.

**Deferred item count.** `countItems_()` runs at `processBatch` activation, not at `enqueueJob`. This keeps enqueueing instant regardless of folder size. The preflight scan pre-populates `total` when possible to skip the activation count.

**Dynamic save interval.** `saveInterval = max(1, floor(total / SAVE_CHECKPOINTS))`. Gives approximately 20 UI updates per job regardless of whether it has 10 items or 10,000, without excessive property write overhead.

**File-name caching per folder.** One `Drive.Files.list` per target folder yields a `Set` for O(1) lookups. The biggest available speed win without changing the copy mechanism.

**`makeCopy()` vs `Drive.Files.copy()`.** `makeCopy()` for binary files (fast, no quota concerns). `Drive.Files.copy()` for Google-native files when `copyGoogleFiles=true` — `makeCopy()` on native files silently exports to Office format. Getting it backwards is a silent data corruption.

**Backend string `'skip'` = UI label "Merge".** Renamed in the UI because "skip" confused users. The backend string is unchanged — renaming it would require migrating stored job data.

**`processBatch` holds the lock for its entire run.** The cooperative pause/cancel flag pattern exists entirely because of this. Never add new lock-requiring calls inside the batch loop.

**Error handler saves checkpoint state.** `dc_wq_` and `dc_fm_` are written in the catch block with `typeof` guards. This is what makes "retry" mean "resume" rather than "restart from scratch." Do not remove these saves.

**`'skipped'` status vs `'done'` with `skipped > 0`.** Only `conflictStrategy === 'skip'` jobs that actually skipped something get `status: 'skipped'`. Update/merge jobs that incidentally skipped items still end as `'done'`. This lets the UI use green for both but distinguishes the copy-was-partial case.

**`advancedSettings` is the in-memory source of truth in the frontend.** Loaded from the backend on page init. The modal reads from and writes to this object in memory; the backend call is just persistence. This means `useSelectedAs()` and `openPreflightPanel()` always use the latest settings without a round-trip.

**`quotaRow` and `storageRow` hidden on reset.** `resetAllState()` in the frontend hides both rows — they both contain stale data after a reset and will re-show on the next activity.

---

## 14. Critical Rules — Never Break These

1. **Never add `SpreadsheetApp`, `onOpen()`, or `showSidebar()`** — standalone web app only. These throw errors.

2. **`processBatch` and `runScheduled_` must remain top-level functions** — the Apps Script trigger system calls them by name. Nesting them inside any other function breaks triggers entirely.

3. **`TRIGGER_FUNCTION` and `SCHEDULE_FUNCTION` must exactly match the function names they refer to** — `clearProcessTriggers_()` and `clearScheduleTriggers_()` use these strings for trigger lookup. A mismatch means triggers are never deleted, causing runaway execution.

4. **Never use `PropertiesService.getScriptProperties()` or `LockService.getScriptLock()`** — these are shared across all users of the deployment. All state must use `getUserProperties()` and `getUserLock()`. Introducing script-scoped storage would mix data between users.

5. **`dc_jobs` must never contain workQueue or folderMap data** — those go in `dc_wq_<id>` and `dc_fm_<id>` separately. Embedding them in the jobs array will blow past the 9KB per-key limit.

6. **`processBatch` holds the user lock for its entire run** — never add new lock-requiring operations inside the batch loop. Use the cooperative flag pattern for anything that needs to signal the running batch.

7. **`makeCopy()` for binary files; `Drive.Files.copy()` for Google-native files** — getting these backwards silently exports Docs/Sheets/Slides to Office format with no error.

8. **`doGet()` references `'App'`** — the frontend HTML file is `App.html`. If it is ever renamed, `doGet()` must be updated to match or the app will return a 404.

9. **`copyPermissions` and `copyGoogleFiles` are captured at enqueue time** — changing toggles after a job is queued has no effect on that job. They are per-job settings, not global.

10. **Backend string `'skip'` = UI label "Merge"** — do not rename the backend value without a migration for stored jobs.

11. **`typeof workQueue !== 'undefined'` guards in the error handler are intentional** — the catch block can fire before these variables are assigned. Removing the guards will cause the error handler itself to throw.

12. **The Drive Advanced Service must be enabled** — without it, folder browsing, `scanFolder`, `getStorageInfo`, `getExplicitPerms_`, and all `Drive.Files.*` calls fail. It must be enabled in Apps Script Editor → Services → Drive API v3.
