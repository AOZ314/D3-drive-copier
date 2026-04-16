// ═══════════════════════════════════════════════════════════════════════════════
// D3 — Duplicate Directories in Drive
// ═══════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('App').setTitle('D3 – Drive Copier');
}

// ─── STORAGE MODEL ───────────────────────────────────────────────────────────
// All persistent state uses PropertiesService.getUserProperties() and
// LockService.getUserLock() — both are scoped to the current user. This means
// each Google account that accesses the web app has a completely separate queue,
// job history, quota counters, and advanced settings. There is no shared state
// between accounts. (The old getScriptProperties()/getScriptLock() was shared
// across all users of the same deployment — a critical multi-user bug fixed here.)




const CONFIG = {
  MAX_BATCH_MS:         5.5 * 60 * 1000,   // stay under 6-min execution limit
  TRIGGER_FUNCTION:     'processBatch',    // must match the function name exactly
  SCHEDULE_FUNCTION:    'runScheduled_',   // daily schedule trigger handler
  // Progress is saved roughly every (total / SAVE_CHECKPOINTS) items so the
  // UI gets ~20 updates per job regardless of size, without excessive writes.
  SAVE_CHECKPOINTS: 20,
  // Per-job ScriptProperties size guards.
  MAX_LAST_ERROR_CHARS: 500,  // truncate lastError to avoid bloating dc_jobs
  MAX_DC_JOBS_BYTES:    7168, // ~7KB — prune terminal jobs if dc_jobs exceeds this
};

const KEYS = {
  JOBS:         'dc_jobs',
  ACTIVE_JOB:   'dc_active',
  PAUSE_REQ:    'dc_pause',
  CANCEL_REQ:   'dc_cancel',
  QUOTA:        'dc_quota',        // rolling daily API call counters
  ADV_SETTINGS: 'dc_advsettings',  // user-configured advanced settings
};

// Named throttle tiers. maxItems caps the copy loop; interBatchMs is
// the delay between processBatch trigger runs.
const THROTTLE_PRESETS_ = {
  normal:  { maxItems: 150, interBatchMs: 60  * 1000 },
  careful: { maxItems: 75,  interBatchMs: 90  * 1000 },
  slow:    { maxItems: 30,  interBatchMs: 120 * 1000 },
};

const jobWqKey = id => 'dc_wq_' + id;
const jobFmKey = id => 'dc_fm_' + id;

// ─── GOOGLE-NATIVE MIME TYPES ─────────────────────────────────────
// makeCopy() silently exports these to Office format — wrong behaviour.
// When copyGoogleFiles is enabled, Drive.Files.copy() is used instead,
// which preserves the native Google format.
const GOOGLE_NATIVE_MIMES_ = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.drawing',
]);


// ─── FOLDER BROWSER ──────────────────────────────────────────────────────────

function getFolderView(folderToken) {
  const rootId = DriveApp.getRootFolder().getId();

  if (folderToken === 'SHARED_ROOT') {
    const res = Drive.Files.list({
      q: "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
    });
    const children = (res.files || []).map(f => ({ id: f.id, name: f.name }));
    return { token: 'SHARED_ROOT', id: null, name: 'Shared with me',
             parentToken: null, isRoot: true, children };
  }

  const isRoot = !folderToken || folderToken === 'ROOT';
  const folder = isRoot ? DriveApp.getRootFolder() : DriveApp.getFolderById(folderToken);

  let children = [];
  if (!isRoot) {
    children = getSharedFolderChildren_(folder.getId());
  } else {
    const it = folder.getFolders();
    while (it.hasNext()) {
      const c = it.next();
      children.push({ id: c.getId(), name: c.getName() });
    }
  }
  children.sort((a, b) => a.name.localeCompare(b.name));

  let parentToken = null;
  if (!isRoot) {
    const parents = folder.getParents();
    parentToken = parents.hasNext() ? parents.next().getId() : rootId;
  }

  return {
    token: isRoot ? 'ROOT' : folder.getId(),
    id:    folder.getId(),
    name:  folder.getName(),
    parentToken,
    isRoot,
    children,
  };
}

function getSharedFolderChildren_(folderId) {
  const res = Drive.Files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
  });
  return (res.files || []).map(f => ({ id: f.id, name: f.name }));
}


// ─── enqueueJob ──────────────────────────────────────────────────────────────
//
// All slow work (validation, folder lookups) happens BEFORE acquiring the lock.
// The lock wraps only the ~4-line property write, so rapid clicks never block.
// Item counting is deferred to processBatch to keep this call fast.

function enqueueJob(sourceFolderId, destFolderId, settings) {
  if (!sourceFolderId || !destFolderId) {
    throw new Error('Both source and destination folders are required.');
  }

  // Resolve the 'ROOT' virtual token to the real My Drive folder ID.
  // The frontend passes 'ROOT' when the user assigns My Drive root as a source
  // or destination; DriveApp.getFolderById() cannot accept that token, but
  // DriveApp.getRootFolder() always returns the real folder object.
  if (sourceFolderId === 'ROOT') sourceFolderId = DriveApp.getRootFolder().getId();
  if (destFolderId   === 'ROOT') destFolderId   = DriveApp.getRootFolder().getId();

  if (sourceFolderId === destFolderId) {
    throw new Error('Source and destination must be different folders.');
  }
  if (isDescendant_(destFolderId, sourceFolderId)) {
    throw new Error('Destination cannot be a subfolder of the source.');
  }

  const source = DriveApp.getFolderById(sourceFolderId);
  const dest   = DriveApp.getFolderById(destFolderId);

  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) throw new Error('System is busy — please try again.');

  let shouldKickoff = false;
  try {
    const jobs  = loadJobs_();
    const props = PropertiesService.getUserProperties();

    const job = {
      id:               generateId_(),
      sourceId:         sourceFolderId,
      sourceName:       source.getName(),
      destId:           destFolderId,
      destName:         dest.getName(),
      status:           'pending',
      copyPermissions:  !!(settings && settings.copyPermissions),
      copyGoogleFiles:  !!(settings && settings.copyGoogleFiles),
      conflictStrategy: (settings && settings.conflictStrategy) || 'rename',
      processed:        0,
      skipped:          0,   // items skipped by the 'skip/update' conflict strategy
      deleted:          0,   // items trashed by the 'update' cleanup pass
      nativeSkipped:    0,   // Google-native files not copied (copyGoogleFiles=false)
      total:            (settings && settings.total > 0) ? settings.total : 0,
      sizeBytes:        (settings && settings.sizeBytes) || 0,
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
      currentFolder:    '',
      lastError:        '',
      itemsPerSecond:   0,   // EMA of copy throughput; used for ETA display
    };

    jobs.push(job);
    saveJobs_(jobs);

    props.setProperty(jobWqKey(job.id), JSON.stringify([{
      sourceId:       sourceFolderId,
      targetParentId: destFolderId,
      parentPerms:    [],   // Explicit permission keys inherited from parent
    }]));
    props.setProperty(jobFmKey(job.id), JSON.stringify({}));

    shouldKickoff = !jobs.some(j => j.id !== job.id && j.status === 'running');
  } finally {
    lock.releaseLock();
  }

  if (shouldKickoff) {
    clearProcessTriggers_();
    ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(1000).create();
  }

  return getJobsStatus();
}


// ─── processBatch ────────────────────────────────────────────────────────────
//
// Speed optimisations vs the naive approach:
//   1. Item count deferred here (not in enqueueJob) so enqueueing is instant.
//   2. Target folder file names cached once per folder via Drive.Files.list
//      instead of one getFilesByName() API call per source file.
//   3. Progress saved every (total / SAVE_CHECKPOINTS) items, not every item.
//   4. After any terminal state, jobs are reloaded fresh from properties before
//      deciding whether to schedule the next trigger, so newly-enqueued jobs
//      that arrived while this batch was running are never missed.

function processBatch() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;

  try {
    const props = PropertiesService.getUserProperties();
    let   jobs  = loadJobs_();

    // ── Activate a job ────────────────────────────────────────────────────────
    let activeId = props.getProperty(KEYS.ACTIVE_JOB);
    let job      = jobs.find(j => j.id === activeId && j.status === 'running');

    let justActivated = false;
    if (!job) {
      job = jobs.find(j => j.status === 'pending');
      if (!job) {
        clearProcessTriggers_();
        props.deleteProperty(KEYS.ACTIVE_JOB);
        return;
      }
      job.status    = 'running';
      job.updatedAt = Date.now();
      activeId      = job.id;
      props.setProperty(KEYS.ACTIVE_JOB, activeId);
      justActivated = true;
    }

    const jobIdx = jobs.findIndex(j => j.id === job.id);

    // startedAt declared here so countItems_ can respect the batch
    // time budget (it gets up to 60s of the total 5.5min window).
    const startedAt = Date.now();

    // Count items if not yet done. This MUST live outside the if(!job) activation
    // block to handle the "resume from pending-pause" path:
    //   enqueueJob → status=pending, total=0
    //   pauseJob   → status=paused,  total=0  (never ran, so never counted)
    //   resumeJob  → status=running, ACTIVE_JOB set  ← processBatch finds it HERE
    //                and skips the activation block above, leaving total===0 forever.
    // Pre-populates total from the preflight scan; if non-zero, skip counting.
    if (job.total === 0) {
      const counted = countItems_(job.sourceId, startedAt);
      // If partial (timed out or capped at 5000), keep total=0 so the bar
      // stays indeterminate rather than showing a wrong percentage.
      job.total     = counted.partial ? 0 : counted.count;
      justActivated = true;  // ensure we persist the newly-set total
    }
    if (justActivated) saveJobs_(jobs);

    // ── Per-batch settings ────────────────────────────────────────────────────
    let workQueue    = loadJson_(jobWqKey(job.id), []);
    let folderMap    = loadJson_(jobFmKey(job.id), {});
    let itemsThisRun = 0;
    const copyPerms  = job.copyPermissions;
    const conflict   = job.conflictStrategy || 'skip';
    let interrupted  = false;

    // Read user-configured throttle tier; fall back to 'normal' defaults.
    const advSettings    = loadAdvancedSettings_();
    const throttle       = THROTTLE_PRESETS_[advSettings.throttle] || THROTTLE_PRESETS_.normal;
    const maxItemsBatch  = throttle.maxItems;
    const interBatchMs   = throttle.interBatchMs;

    // Batch-level API call counters — flushed to ScriptProperties at
    // the end of each processBatch run (inside the lock, so no race condition).
    const batchQuota = { reads: 0, writes: 0 };

    // Save every N items where N = total / SAVE_CHECKPOINTS (min 1)
    // This gives ~20 UI updates per job without excessive ScriptProperties writes.
    const saveInterval = job.total > 0
      ? Math.max(1, Math.floor(job.total / CONFIG.SAVE_CHECKPOINTS))
      : 5;

    // Start the copy-loop timer here, AFTER countItems_ and property loads,
    // so IPS reflects actual copy throughput only (not counting or I/O setup time).
    const copyLoopStartedAt = Date.now();

    // ── Main loop ─────────────────────────────────────────────────────────────
    outer:
    while (
      workQueue.length > 0 &&
      itemsThisRun < maxItemsBatch &&
      (Date.now() - startedAt) < CONFIG.MAX_BATCH_MS
    ) {
      const task         = workQueue.shift();
      const sourceFolder = DriveApp.getFolderById(task.sourceId);
      const targetParent = DriveApp.getFolderById(task.targetParentId);
      const result       = getOrCreateMappedFolder_(sourceFolder, targetParent, folderMap, conflict, batchQuota);
      const targetFolder = result.folder;
      job.currentFolder  = sourceFolder.getName();

      // Count the folder toward the batch pace limiter regardless of outcome.
      itemsThisRun++;

      // mergedPerms = the permission keys that children should treat as
      // "already inherited". Starts as the parent's set; expands if we copy perms
      // onto a newly-created folder so subfolders don't redundantly re-apply them.
      let mergedPerms = task.parentPerms || [];

      if (!result.created && (conflict === 'skip' || conflict === 'update')) {
        // Merged into an existing folder — counts as skipped, NOT as processed.
        // processed should only reflect items that were actually created/copied.
        job.skipped = (job.skipped || 0) + 1;
      } else {
        // New folder created (any strategy) — counts as processed work done.
        job.processed++;
        if (result.created && copyPerms) {
          // Use explicit-only diff instead of getEditors()/getViewers().
          mergedPerms = applyPermsDiff_(sourceFolder.getId(), targetFolder, task.parentPerms || [], batchQuota);
        }
      }

      // ── Optimized file copy: cache existing names once per folder ───────────
      // This replaces N individual getFilesByName() calls (one per source file)
      // with a single Drive.Files.list call, saving O(n) API calls per folder.
      const existingNames = cacheTargetFileNames_(targetFolder.getId(), batchQuota);

      const files = sourceFolder.getFiles();
      while (
        files.hasNext() &&
        itemsThisRun < maxItemsBatch &&
        (Date.now() - startedAt) < CONFIG.MAX_BATCH_MS
      ) {
        const file      = files.next();
        const copyResult = copyFileCached_(file, targetFolder, conflict, copyPerms, existingNames, job.copyGoogleFiles, mergedPerms, batchQuota);

        if (copyResult === 'copied') {
          job.processed++;
          itemsThisRun++;

          // ── Periodic progress save ────────────────────────────────────────
          if (itemsThisRun % saveInterval === 0) {
            job.updatedAt = Date.now();
            jobs[jobIdx]  = job;
            saveJobs_(jobs);
            props.setProperty(jobWqKey(job.id), JSON.stringify(workQueue));
          }
        } else if (copyResult === 'skipped') {
          // File already exists at destination — conflict strategy said skip it.
          job.skipped = (job.skipped || 0) + 1;
        } else if (copyResult === 'nativeSkipped') {
          // Google-native file skipped because copyGoogleFiles is off.
          job.nativeSkipped = (job.nativeSkipped || 0) + 1;
        }

        // ── Cooperative pause/cancel checks — runs on every file, skip or not ──
        // Ensures pause/cancel is honoured promptly even in skip-heavy batches
        // where itemsThisRun may never advance to the old check position.
        const cancelReq = props.getProperty(KEYS.CANCEL_REQ);
        if (cancelReq === job.id) {
          props.deleteProperty(KEYS.CANCEL_REQ);
          job.status          = 'cancelled';
          job.currentFolder   = '';
          job.itemsPerSecond  = 0;   // Clear stale speed so retry starts fresh
          props.deleteProperty(jobWqKey(job.id));
          props.deleteProperty(jobFmKey(job.id));
          props.deleteProperty(KEYS.ACTIVE_JOB);
          interrupted = true;
          break outer;
        }

        const pauseReq = props.getProperty(KEYS.PAUSE_REQ);
        if (pauseReq === job.id) {
          props.deleteProperty(KEYS.PAUSE_REQ);
          job.status = 'paused';
          // Re-enter this folder on resume. Files already in the target will be
          // skipped by copyFileCached_ and, thanks to the didCopy gate, will not
          // re-increment job.processed — so the count stays correct.
          workQueue.unshift(task);
          props.setProperty(jobWqKey(job.id), JSON.stringify(workQueue));
          props.setProperty(jobFmKey(job.id), JSON.stringify(folderMap));
          props.deleteProperty(KEYS.ACTIVE_JOB);
          interrupted = true;
          break outer;
        }
      }

      if (interrupted) break;

      const subs = sourceFolder.getFolders();
      while (subs.hasNext()) {
        const sub = subs.next();
        workQueue.push({
          sourceId:       sub.getId(),
          targetParentId: targetFolder.getId(),
          parentPerms:    mergedPerms,   // Propagate permission context
        });
      }

      // ── Update strategy: remove destination items not present in source ──────
      // After copying source contents into the target folder, trash any files and
      // subfolders in the destination that have no matching name in the source.
      // This makes the destination mirror the source by filename without blindly
      // replacing everything (unlike overwrite which replaces on conflict).
      if (conflict === 'update') {
        // Build sets of source names
        const srcFileNames   = new Set();
        const srcFolderNames = new Set();
        const sf = sourceFolder.getFiles();
        while (sf.hasNext()) srcFileNames.add(sf.next().getName());
        const sd = sourceFolder.getFolders();
        while (sd.hasNext()) srcFolderNames.add(sd.next().getName());

        // Trash destination files not in source, count each one
        const df = targetFolder.getFiles();
        while (df.hasNext()) {
          const f = df.next();
          if (!srcFileNames.has(f.getName())) {
            f.setTrashed(true);
            job.deleted = (job.deleted || 0) + 1;
          }
        }
        // Trash destination subfolders not in source, recursively count their contents
        const dd = targetFolder.getFolders();
        while (dd.hasNext()) {
          const d = dd.next();
          if (!srcFolderNames.has(d.getName())) {
            job.deleted = (job.deleted || 0) + countItems_(d.getId());
            d.setTrashed(true);
          }
        }
      }

    }   // ── end outer: while (workQueue.length > 0 …) ──────────────────────────

    // ── Update throughput EMA for ETA display ──────────────────────
    // Uses copyLoopStartedAt (not startedAt) so counting and I/O setup time are
    // excluded — batchIPS reflects actual file copy throughput only.
    // Guard: >500ms elapsed and at least one item processed to avoid noise.
    const batchElapsedMs = Date.now() - copyLoopStartedAt;
    if (itemsThisRun > 0 && batchElapsedMs > 500) {
      const batchIPS = itemsThisRun / (batchElapsedMs / 1000);
      // EMA: new = 0.3 * latest + 0.7 * previous. First batch seeds directly.
      job.itemsPerSecond = job.itemsPerSecond > 0
        ? 0.3 * batchIPS + 0.7 * job.itemsPerSecond
        : batchIPS;
    }

    // ── Final persist ─────────────────────────────────────────────────────────
    job.updatedAt = Date.now();
    const isDone  = !interrupted && workQueue.length === 0;

    if (isDone) {
      // A skip-strategy job that actually skipped at least one file gets its own
      // terminal status so the UI can distinguish "fully copied" from "some skipped".
      job.status        = (job.conflictStrategy === 'skip' && job.skipped > 0) ? 'skipped' : 'done';
      job.currentFolder = '';
      props.deleteProperty(jobWqKey(job.id));
      props.deleteProperty(jobFmKey(job.id));
      props.deleteProperty(KEYS.ACTIVE_JOB);
    } else if (!interrupted) {
      props.setProperty(jobWqKey(job.id), JSON.stringify(workQueue));
      props.setProperty(jobFmKey(job.id), JSON.stringify(folderMap));
    }

    jobs[jobIdx] = job;
    saveJobs_(jobs);

    // Persist accumulated API call counts for quota awareness display.
    addQuota_(batchQuota.reads, batchQuota.writes);

    clearProcessTriggers_();

    if (!isDone && !interrupted) {
      // More work remaining for this job — wait the throttle-configured inter-batch delay.
      ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(interBatchMs).create();
    } else {
      // Job reached terminal state (done / paused / cancelled).
      // Reload jobs fresh from properties — a new job may have been enqueued
      // while this batch was running and won't be in the local in-memory copy.
      const freshJobs = loadJobs_();
      if (freshJobs.some(j => j.status === 'pending')) {
        ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(3000).create();
      }
    }

  } catch (err) {
    try {
      const props    = PropertiesService.getUserProperties();
      const jobs     = loadJobs_();
      const activeId = props.getProperty(KEYS.ACTIVE_JOB);
      const job      = jobs.find(j => j.id === activeId);
      if (job) {
        job.status         = 'error';
        job.itemsPerSecond = 0;          // clear so retry re-measures from scratch
        job.updatedAt      = Date.now();
        // Truncate to avoid bloating dc_jobs (ScriptProperties 9KB per-key limit).
        const errStr  = String(err && err.message ? err.message : err);
        job.lastError = errStr.length > CONFIG.MAX_LAST_ERROR_CHARS
          ? errStr.slice(0, CONFIG.MAX_LAST_ERROR_CHARS) + '…'
          : errStr;
        saveJobs_(jobs);
        // Persist the current work queue and folder map so that when the user
        // clicks Retry, processBatch resumes from the last checkpoint rather
        // than re-creating destination folders from scratch (which caused the
        // "new copy instead of continue" bug on Drive API rate-limit errors).
        if (typeof workQueue !== 'undefined') {
          props.setProperty(jobWqKey(job.id), JSON.stringify(workQueue));
        }
        if (typeof folderMap !== 'undefined') {
          props.setProperty(jobFmKey(job.id), JSON.stringify(folderMap));
        }
      }
      props.deleteProperty(KEYS.ACTIVE_JOB);
    } catch (_) {}
    clearProcessTriggers_();
    throw err;
  } finally {
    lock.releaseLock();
  }
}


// ─── pauseJob ────────────────────────────────────────────────────────────────

function pauseJob(jobId) {
  const jobs = loadJobs_();
  const job  = jobs.find(j => j.id === jobId);
  if (!job) throw new Error('Job not found: ' + jobId);

  if (job.status === 'running') {
    PropertiesService.getUserProperties().setProperty(KEYS.PAUSE_REQ, jobId);
    return getJobsStatus();
  }

  if (job.status === 'pending') {
    const lock = LockService.getUserLock();
    if (!lock.tryLock(3000)) throw new Error('System is busy — try again shortly.');
    try {
      // Load once, find, mutate, save — no second load needed inside the same lock.
      const jobs2 = loadJobs_();
      const j2    = jobs2.find(j => j.id === jobId);
      if (j2 && j2.status === 'pending') {
        j2.status    = 'paused';
        j2.updatedAt = Date.now();
        saveJobs_(jobs2);
      }
    } finally { lock.releaseLock(); }
    return getJobsStatus();
  }

  throw new Error('Cannot pause a job with status "' + job.status + '".');
}


// ─── resumeJob ───────────────────────────────────────────────────────────────

function resumeJob(jobId) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) throw new Error('System is busy.');
  let shouldKickoff = false;
  try {
    const props = PropertiesService.getUserProperties();
    const jobs  = loadJobs_();
    const job   = jobs.find(j => j.id === jobId);
    if (!job) throw new Error('Job not found: ' + jobId);
    if (job.status !== 'paused' && job.status !== 'error') {
      throw new Error('Only paused or errored jobs can be resumed.');
    }

    const hasRunning = jobs.some(j => j.id !== jobId && j.status === 'running');
    if (hasRunning) {
      job.status = 'pending';
    } else {
      job.status = 'running';
      props.setProperty(KEYS.ACTIVE_JOB, jobId);
      shouldKickoff = true;
    }
    job.lastError = '';
    job.updatedAt = Date.now();

    // BUG-B fix: clear any stale cooperative flags left over from a pause or
    // cancel request that arrived after the job finished its file loop and was
    // never consumed. Without this, processBatch would immediately re-pause
    // or re-cancel the job on the very first file of the resumed run.
    props.deleteProperty(KEYS.PAUSE_REQ);
    props.deleteProperty(KEYS.CANCEL_REQ);

    saveJobs_(jobs);
  } finally {
    lock.releaseLock();
  }

  if (shouldKickoff) {
    clearProcessTriggers_();
    ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(500).create();
  }
  return getJobsStatus();
}


// ─── cancelJob ───────────────────────────────────────────────────────────────

function cancelJob(jobId) {
  const jobs = loadJobs_();
  const job  = jobs.find(j => j.id === jobId);
  if (!job) throw new Error('Job not found: ' + jobId);

  if (job.status === 'running') {
    PropertiesService.getUserProperties().setProperty(KEYS.CANCEL_REQ, jobId);
    return getJobsStatus();
  }

  // Only pending and paused jobs can be directly cancelled here.
  // 'running' is handled via the cooperative flag above.
  // Terminal states (done / cancelled / error / skipped) are not cancellable.
  if (job.status === 'pending' || job.status === 'paused') {
    const lock = LockService.getUserLock();
    if (!lock.tryLock(3000)) throw new Error('System is busy — try again shortly.');
    let advance = false;
    try {
      const props  = PropertiesService.getUserProperties();
      const jobs2  = loadJobs_();
      const j2     = jobs2.find(j => j.id === jobId);
      if (j2) {
        j2.status           = 'cancelled';
        j2.currentFolder    = '';
        j2.itemsPerSecond   = 0;
        j2.updatedAt        = Date.now();
        props.deleteProperty(jobWqKey(jobId));
        props.deleteProperty(jobFmKey(jobId));
        if (props.getProperty(KEYS.ACTIVE_JOB) === jobId) {
          props.deleteProperty(KEYS.ACTIVE_JOB);
          clearProcessTriggers_();
          advance = true;
        }
        saveJobs_(jobs2);
      }
    } finally { lock.releaseLock(); }
    if (advance) {
      ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(3000).create();
    }
  }
  return getJobsStatus();
}


// ─── clearJob ────────────────────────────────────────────────────────────────

function clearJob(jobId) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) throw new Error('System is busy.');
  try {
    const jobs = loadJobs_();
    const idx  = jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      if (!['done', 'cancelled', 'error', 'skipped'].includes(jobs[idx].status)) {
        throw new Error('Only completed, cancelled, skipped, or errored jobs can be cleared.');
      }
      jobs.splice(idx, 1);
      saveJobs_(jobs);
    }
  } finally {
    lock.releaseLock();
  }
  return getJobsStatus();
}


// ─── clearAllTerminal ─────────────────────────────────────────────────────────
// Removes all terminal jobs (done / skipped / cancelled / error) in one lock.
// Active jobs (pending / running / paused) are untouched.

function clearAllTerminal() {
  const TERMINAL = new Set(['done', 'skipped', 'cancelled', 'error']);
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) throw new Error('System is busy.');
  try {
    const jobs    = loadJobs_();
    const kept    = jobs.filter(j => !TERMINAL.has(j.status));
    const removed = jobs.filter(j =>  TERMINAL.has(j.status));
    if (removed.length > 0) saveJobs_(kept);
  } finally {
    lock.releaseLock();
  }
  return getJobsStatus();
}


function getJobsStatus() {
  const jobs     = loadJobs_();
  const activeId = PropertiesService.getUserProperties().getProperty(KEYS.ACTIVE_JOB) || '';

  const summary = {
    totalJobs:     jobs.length,
    pendingJobs:   jobs.filter(j => j.status === 'pending').length,
    runningJobs:   jobs.filter(j => j.status === 'running').length,
    pausedJobs:    jobs.filter(j => j.status === 'paused').length,
    doneJobs:      jobs.filter(j => j.status === 'done').length,
    skippedJobs:   jobs.filter(j => j.status === 'skipped').length,
    errorJobs:     jobs.filter(j => j.status === 'error').length,
    cancelledJobs: jobs.filter(j => j.status === 'cancelled').length,
    activeJobId:   activeId,
  };

  // Include all non-cancelled jobs in the global bar.
  // Denominator excludes both conflict-skipped and native-skipped items —
  // neither counts as "remaining work" against completion percentage.
  const active         = jobs.filter(j => j.status !== 'cancelled');
  const totalProcessed = active.reduce((s, j) => s + j.processed, 0);
  const totalItems     = active.reduce((s, j) => s + (j.total - (j.skipped || 0) - (j.nativeSkipped || 0)), 0);
  summary.overallPercent = totalItems > 0
    ? Math.min(100, Math.floor(totalProcessed / totalItems * 100))
    : 0;

  // Attach quota usage so the frontend can display today's API call counts.
  // Percentages are intentionally omitted — Google doesn't expose remaining quota
  // via any API, and the commonly-cited free-tier limits vary by account type.
  const quota = loadQuota_();
  summary.quota = {
    reads:        quota.reads,
    writes:       quota.writes,
    resetMinutes: (function() {
      // Minutes remaining until midnight Pacific — when the daily quota resets.
      try {
        const laTime = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'HH:mm');
        const parts  = laTime.split(':');
        return (24 * 60) - (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10));
      } catch (_) { return 0; }
    })(),
  };

  return { jobs, summary };
}


// ─── scanFolder / getStorageInfo ─────────────────────────────────────────────

function scanFolder(folderId) {
  const ITEM_CAP = 5000;
  let itemCount = 0, sizeBytes = 0, capped = false;

  function scan(id) {
    if (capped) return;
    let pageToken;
    do {
      const res = Drive.Files.list({
        q: `'${id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'nextPageToken, files(id, size)', pageSize: 1000,
        pageToken: pageToken || undefined,
      });
      for (const f of (res.files || [])) {
        itemCount++; sizeBytes += Number(f.size || 0);
        if (itemCount >= ITEM_CAP) { capped = true; return; }
      }
      pageToken = res.nextPageToken;
    } while (pageToken && !capped);

    const sub = Drive.Files.list({
      q: `'${id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: 'files(id)', pageSize: 1000,
    });
    for (const f of (sub.files || [])) {
      if (capped) return;
      itemCount++;
      scan(f.id);
    }
  }

  itemCount++;
  scan(folderId);
  return { itemCount, sizeBytes, estimatedMB: Math.round(sizeBytes / 1048576 * 10) / 10, capped };
}

function getStorageInfo() {
  try {
    const about = Drive.About.get({ fields: 'storageQuota' });
    const q     = about.storageQuota || {};
    const used  = Number(q.usageInDrive || 0);
    const total = Number(q.limit        || 0);
    return { usedBytes: used, totalBytes: total,
             availableBytes: total > 0 ? total - used : -1, unlimited: total === 0 };
  } catch (e) {
    return { usedBytes: 0, totalBytes: 0, availableBytes: -1, unlimited: true,
             error: String(e && e.message ? e.message : e) };
  }
}


// ─── Account display ─────────────────────────────────────────────────────────
//
// Returns the active user's email for the header avatar, and the app URL for
// informational display in the account popover.
// There is no in-app account switching API for Apps Script web apps — the OAuth
// account is determined at the browser level before any code runs.

function getAppInfo() {
  try {
    const email  = Session.getActiveUser().getEmail();
    const appUrl = ScriptApp.getService().getUrl();
    return { email: email || '', appUrl: appUrl || '' };
  } catch (e) {
    return { email: '', appUrl: '', error: String(e && e.message ? e.message : e) };
  }
}

const ADV_DEFAULTS_ = {
  throttle:          'normal',   // 'normal' | 'careful' | 'slow'
  defaultConflict:   'rename',   // 'rename' | 'skip' | 'update' | 'overwrite'
  allowRootAsSource: false,      // let user set My Drive root as copy source
  scheduledCopying:  false,      // auto-resume paused jobs at a set hour (Pacific)
  scheduleHour:      2,          // hour (0–23 Pacific) at which to run; default 2am
};

function loadAdvancedSettings_() {
  const raw = PropertiesService.getUserProperties().getProperty(KEYS.ADV_SETTINGS);
  if (!raw) return Object.assign({}, ADV_DEFAULTS_);
  try {
    // Merge stored values over defaults so new fields always have a safe fallback.
    return Object.assign({}, ADV_DEFAULTS_, JSON.parse(raw));
  } catch (_) { return Object.assign({}, ADV_DEFAULTS_); }
}

function getAdvancedSettings() {
  return loadAdvancedSettings_();
}

function saveAdvancedSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  const hour = parseInt(settings.scheduleHour, 10);
  const safe = {
    throttle:          ['normal','careful','slow'].includes(settings.throttle)
                         ? settings.throttle : ADV_DEFAULTS_.throttle,
    defaultConflict:   ['rename','skip','update','overwrite'].includes(settings.defaultConflict)
                         ? settings.defaultConflict : ADV_DEFAULTS_.defaultConflict,
    allowRootAsSource: !!settings.allowRootAsSource,
    scheduledCopying:  !!settings.scheduledCopying,
    scheduleHour:      (!isNaN(hour) && hour >= 0 && hour <= 23) ? hour : ADV_DEFAULTS_.scheduleHour,
  };
  PropertiesService.getUserProperties()
    .setProperty(KEYS.ADV_SETTINGS, JSON.stringify(safe));

  // Sync the daily schedule trigger with the new settings.
  clearScheduleTriggers_();
  if (safe.scheduledCopying) {
    ScriptApp.newTrigger(CONFIG.SCHEDULE_FUNCTION)
      .timeBased().atHour(safe.scheduleHour).everyDays(1)
      .inTimezone('America/Los_Angeles').create();
  }
}

function resetState() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return;
  try {
    clearProcessTriggers_();
    clearScheduleTriggers_();
    // Preserve advanced settings — they are user preferences, not job state.
    const props    = PropertiesService.getUserProperties();
    const advRaw   = props.getProperty(KEYS.ADV_SETTINGS);
    props.deleteAllProperties();
    if (advRaw) props.setProperty(KEYS.ADV_SETTINGS, advRaw);
    // Restore the schedule trigger if scheduled copying was enabled.
    if (advRaw) {
      try {
        const adv = JSON.parse(advRaw);
        if (adv.scheduledCopying && typeof adv.scheduleHour === 'number') {
          ScriptApp.newTrigger(CONFIG.SCHEDULE_FUNCTION)
            .timeBased().atHour(adv.scheduleHour).everyDays(1)
            .inTimezone('America/Los_Angeles').create();
        }
      } catch (_) {}
    }
  } finally {
    lock.releaseLock();
  }
}

// ─── Scheduled copy trigger ───────────────────────────────────────────────────
//
// runScheduled_ is called by the daily time-based trigger created when the user
// enables "Scheduled copying" in Advanced Settings. It resumes all paused jobs
// and marks all pending jobs to kick off, then fires the batch trigger if needed.
// Must be top-level (Apps Script trigger system calls it by name).

function runScheduled_() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return;
  try {
    const jobs = loadJobs_();
    let kicked = false;

    jobs.forEach(function(job) {
      // Resume paused jobs; re-queue pending ones (they'll start automatically).
      if (job.status === 'paused') {
        job.status    = 'pending';
        job.lastError = '';
        job.updatedAt = Date.now();
        kicked = true;
      }
    });

    if (kicked) {
      saveJobs_(jobs);
    }
  } finally {
    lock.releaseLock();
  }

  // Fire the batch processor — it will pick up pending jobs.
  clearProcessTriggers_();
  ScriptApp.newTrigger(CONFIG.TRIGGER_FUNCTION).timeBased().after(5000).create();
}

function clearScheduleTriggers_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === CONFIG.SCHEDULE_FUNCTION) ScriptApp.deleteTrigger(t);
  }
}


// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

function generateId_() {
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadJobs_()     { return loadJson_(KEYS.JOBS, []); }

// Persists the jobs array, auto-pruning the oldest terminal jobs first if the
// serialised size would exceed CONFIG.MAX_DC_JOBS_BYTES. This prevents the
// dc_jobs key from approaching the 9KB ScriptProperties per-key limit as
// completed jobs accumulate over many sessions.
// Terminal order: cancelled first (least useful to keep), then error, skipped, done.
function saveJobs_(jobs) {
  const TERMINAL_ORDER = ['cancelled', 'error', 'skipped', 'done'];
  let serialised = JSON.stringify(jobs);
  if (serialised.length > CONFIG.MAX_DC_JOBS_BYTES) {
    // Work through terminal statuses from least-useful to most-useful, removing
    // the oldest entry of that type on each pass until we're under the limit.
    let pruned = jobs.slice();
    for (const status of TERMINAL_ORDER) {
      while (serialised.length > CONFIG.MAX_DC_JOBS_BYTES) {
        const idx = pruned.findIndex(j => j.status === status);
        if (idx === -1) break;
        pruned.splice(idx, 1);
        serialised = JSON.stringify(pruned);
      }
    }
    jobs = pruned;
  }
  PropertiesService.getUserProperties().setProperty(KEYS.JOBS, serialised);
}

function loadJson_(key, fallback) {
  const raw = PropertiesService.getUserProperties().getProperty(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function isDescendant_(potentialChildId, ancestorId) {
  try {
    const rootId = DriveApp.getRootFolder().getId();
    let folder   = DriveApp.getFolderById(potentialChildId);
    for (let d = 0; d < 30; d++) {
      const parents = folder.getParents();
      if (!parents.hasNext()) return false;
      const parent = parents.next();
      const pid    = parent.getId();
      if (pid === ancestorId) return true;
      if (pid === rootId)     return false;
      folder = parent;
    }
  } catch (_) {}
  return false;
}

// ─── cacheTargetFileNames_ ───────────────────────────────────────────────────
//
// Returns a Set of all non-folder filenames currently in a target folder.
// Called once per source folder — replaces N individual getFilesByName() calls
// (one per source file) with a single paginated list, saving O(n) API calls.

function cacheTargetFileNames_(folderId, batchQuota) {
  const names = new Set();
  try {
    let pageToken;
    do {
      const res = Drive.Files.list({
        q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'nextPageToken, files(name)',
        pageSize: 1000,
        pageToken: pageToken || undefined,
      });
      if (batchQuota) batchQuota.reads++;   // Count each list page
      (res.files || []).forEach(f => names.add(f.name));
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (_) {}
  return names;
}

// ─── copyFileCached_ ─────────────────────────────────────────────────────────
//
// Like copyFileWithStrategy_ but uses a pre-built name Set for the skip check
// instead of a per-file API call. Updates the Set after copying so subsequent
// files in the same folder see accurate state.

// Returns a result tag:
//   'copied'        — file was actually copied/created at the destination
//   'skipped'       — file skipped due to conflict strategy (already exists)
//   'nativeSkipped' — Google-native file skipped because copyGoogleFiles is off
function copyFileCached_(file, targetFolder, strategy, copyPerms, existingNames, copyGoogleFiles, parentPermsArr, batchQuota) {
  const name     = file.getName();
  const mimeType = file.getMimeType();
  const isNative = GOOGLE_NATIVE_MIMES_.has(mimeType);

  // Skip Google-native files when copyGoogleFiles is disabled.
  // They can't be meaningfully copied with makeCopy() anyway.
  if (isNative && !copyGoogleFiles) return 'nativeSkipped';

  if ((strategy === 'skip' || strategy === 'update') && existingNames.has(name)) return 'skipped';

  if (strategy === 'overwrite') {
    const ex = targetFolder.getFilesByName(name);
    while (ex.hasNext()) ex.next().setTrashed(true);
    existingNames.delete(name);
  }

  let destName = name;
  if (strategy === 'rename' && existingNames.has(name)) {
    const dot  = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext  = dot > 0 ? name.slice(dot)    : '';
    let n = 1;
    do {
      const suffix = n === 1 ? ' (copy)' : ' (copy' + n + ')';
      destName = base + suffix + ext;
      n++;
    } while (existingNames.has(destName));
  }

  try {
    let copied;
    if (isNative && copyGoogleFiles) {
      // Drive.Files.copy preserves native Google format.
      // Wrapped in withRetry_ — Drive.Files.copy hits user rate limits
      // more readily than makeCopy() and most quota errors resolve within seconds.
      const resource = { name: destName, parents: [targetFolder.getId()] };
      const driveFile = withRetry_(function() {
        return Drive.Files.copy(resource, file.getId(), { fields: 'id' });
      }, 2, name);
      if (batchQuota) batchQuota.writes++;
      // Wrap in a DriveApp file object for the permissions call below.
      copied = DriveApp.getFileById(driveFile.id);
    } else {
      copied = file.makeCopy(destName, targetFolder);
      if (batchQuota) batchQuota.writes++;
    }
    existingNames.add(destName);
    // Apply only explicit permissions not already on the parent folder.
    if (copyPerms) applyPermsDiff_(file.getId(), copied, parentPermsArr || [], batchQuota);
  } catch (e) {
    throw new Error('Could not copy "' + name + '": ' + (e.message || e));
  }
  return 'copied';
}

// strategy is applied to folders just like files:
//   skip/overwrite/update → merge into an existing same-name folder (files inside
//                           are handled individually by copyFileCached_)
//   update additionally   → after copy, trashes destination items not in source
//   rename                → create a uniquely-named folder: (copy), (copy2), …
function getOrCreateMappedFolder_(sourceFolder, targetParent, folderMap, strategy, batchQuota) {
  const sourceId = sourceFolder.getId();
  if (folderMap[sourceId]) {
    try { return { folder: DriveApp.getFolderById(folderMap[sourceId]), created: false }; } catch (_) {}
  }

  const name = sourceFolder.getName();

  if (strategy === 'skip' || strategy === 'overwrite' || strategy === 'update') {
    // Use an existing same-name folder if one exists; individual file conflicts
    // inside are resolved by copyFileCached_ per the chosen strategy.
    const existing = targetParent.getFoldersByName(name);
    if (existing.hasNext()) {
      const existingFolder = existing.next();
      folderMap[sourceId]  = existingFolder.getId();
      return { folder: existingFolder, created: false };
    }
  } else if (strategy === 'rename') {
    // If a same-name folder exists at the destination, pick a unique name.
    if (targetParent.getFoldersByName(name).hasNext()) {
      let n = 1, destName;
      do {
        destName = name + (n === 1 ? ' (copy)' : ' (copy' + n + ')');
        n++;
      } while (targetParent.getFoldersByName(destName).hasNext());
      const renamed       = targetParent.createFolder(destName);
      if (batchQuota) batchQuota.writes++;
      folderMap[sourceId] = renamed.getId();
      return { folder: renamed, created: true };
    }
  }

  // No conflict found, or strategy=rename with no conflict — create normally.
  const fresh         = targetParent.createFolder(name);
  if (batchQuota) batchQuota.writes++;
  folderMap[sourceId] = fresh.getId();
  return { folder: fresh, created: true };
}

// ─── Smart permission helpers ────────────────────────────────────
//
// The old copyPermissions_() used DriveApp.getEditors() / getViewers(), which
// returns ALL editors/viewers including those who only have access via a parent
// folder. Re-applying those to the copy triggers an email notification for every
// inherited user on every file and folder — the "email flood" bug.
//
// The fix: Drive.Files.get({ fields: 'permissions' }) returns ONLY the ACL
// entries explicitly set on that specific item, not inherited ones. We then diff
// that list against the parent folder's already-applied permissions so we only
// call addEditor/addViewer for permissions that are genuinely new at this level.
//
// parentPerms is serialised as a plain string array (JSON-safe) stored in each
// workQueue task so it survives across batch boundaries in ScriptProperties.

// Returns explicit (non-inherited) permission objects for a file/folder.
// Each entry: { emailAddress, role, type, domain }
// Includes owner entries — applyPermsDiff_ downgrades them to writer so the
// original owner retains access to copies they don't own.
function getExplicitPerms_(fileId) {
  try {
    const res = Drive.Files.get(fileId, {
      fields: 'permissions(emailAddress,role,type,domain)',
    });
    return res.permissions || [];
  } catch (_) { return []; }
}

// Stable string key for a permission entry — used to deduplicate against the
// parent folder's permission set so inherited entries are never re-applied.
function permKey_(p) {
  if (p.type === 'user' || p.type === 'group') {
    return p.type + ':' + (p.emailAddress || '').toLowerCase();
  }
  if (p.type === 'domain') return 'domain:' + (p.domain || '');
  return 'anyone';  // type === 'anyone'
}

// Applies to `target` only the explicit permissions on `sourceId` that are not
// already present in `parentPermsArr` (i.e. not inherited from a parent folder).
// Returns the merged permission-key array for child items to use as their parent.
// `target` must be a DriveApp File or Folder object.
//
// Two special cases vs the raw permission list:
//   • owner → downgraded to writer (editor). Ownership can't be transferred via
//     the API; this ensures the original owner still has access to the copy.
//   • current user → skipped entirely. Adding yourself as editor on a file you
//     already own triggers a "you shared X with yourself" notification — wrong.
function applyPermsDiff_(sourceId, target, parentPermsArr, batchQuota) {
  const explicit   = getExplicitPerms_(sourceId);
  if (batchQuota) batchQuota.reads++;
  const parentSet  = new Set(parentPermsArr || []);
  const mergedKeys = new Set(parentSet);

  // Get the current user's email once so we can skip self-sharing.
  let selfEmail = '';
  try { selfEmail = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (_) {}

  for (var i = 0; i < explicit.length; i++) {
    const p = explicit[i];

    // Downgrade owner → writer so the original owner retains access.
    // Clone to avoid mutating the original object.
    const entry = (p.role === 'owner') ? { type: p.type, role: 'writer', emailAddress: p.emailAddress, domain: p.domain } : p;

    const key = permKey_(entry);
    mergedKeys.add(key);
    if (parentSet.has(key)) continue;   // already inherited — skip to avoid email

    // Skip the current user — they already own the copy; adding them as editor
    // sends a "you shared X with yourself" notification.
    if ((entry.type === 'user' || entry.type === 'group') &&
        (entry.emailAddress || '').toLowerCase() === selfEmail) continue;

    try {
      if (entry.type === 'user' || entry.type === 'group') {
        if (entry.role === 'writer' || entry.role === 'fileOrganizer' || entry.role === 'organizer') {
          target.addEditor(entry.emailAddress);
          if (batchQuota) batchQuota.writes++;
        } else if (entry.role === 'reader' || entry.role === 'commenter') {
          target.addViewer(entry.emailAddress);
          if (batchQuota) batchQuota.writes++;
        }
      } else if (entry.type === 'anyone') {
        const perm = (entry.role === 'writer') ? DriveApp.Permission.EDIT : DriveApp.Permission.VIEW;
        target.setSharing(DriveApp.Access.ANYONE_WITH_LINK, perm);
        if (batchQuota) batchQuota.writes++;
      } else if (entry.type === 'domain') {
        const perm = (entry.role === 'writer') ? DriveApp.Permission.EDIT : DriveApp.Permission.VIEW;
        target.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, perm);
        if (batchQuota) batchQuota.writes++;
      }
    } catch (_) {}  // best-effort; permission errors must not abort the copy
  }

  // Cap the returned array to prevent dc_wq_ property bloat.
  const capped = Array.from(mergedKeys);
  if (capped.length > 50) capped.length = 50;
  return capped;
}

// ─── withRetry_ ──────────────────────────────────────────────────────────────
//
// Calls fn() and retries up to maxRetries times on transient Drive API quota
// errors ("rate limit", "user rate limit", "quota"). Uses exponential backoff:
// 1s after the first failure, 2s after the second. Non-quota errors throw
// immediately without retrying (e.g. permission denied, file not found).
// fileName is used only for the informative log message.

function withRetry_(fn, maxRetries, fileName) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e).toLowerCase();
      const isQuota = msg.includes('rate limit') || msg.includes('quota') || msg.includes('user rate');
      if (!isQuota) throw e;   // non-quota error — fail fast, no retry
      if (attempt < maxRetries) {
        Utilities.sleep(1000 * Math.pow(2, attempt));  // 1s, then 2s
      }
    }
  }
  throw lastErr;
}

function clearProcessTriggers_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === CONFIG.TRIGGER_FUNCTION) ScriptApp.deleteTrigger(t);
  }
}

// ─── Quota tracking helpers ──────────────────────────────────────

function getPacificDateStr_() {
  // Utilities.formatDate handles DST automatically for America/Los_Angeles.
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function loadQuota_() {
  const today = getPacificDateStr_();
  const raw   = PropertiesService.getUserProperties().getProperty(KEYS.QUOTA);
  if (!raw) return { date: today, reads: 0, writes: 0 };
  try {
    const q = JSON.parse(raw);
    // If stored date doesn't match today (Pacific), quota has rolled over — reset.
    if (q.date !== today) return { date: today, reads: 0, writes: 0 };
    return q;
  } catch (_) { return { date: today, reads: 0, writes: 0 }; }
}

function saveQuota_(q) {
  PropertiesService.getUserProperties().setProperty(KEYS.QUOTA, JSON.stringify(q));
}

// Called at the end of each processBatch run (inside the ScriptLock) to
// accumulate API call counts into the rolling daily ScriptProperties total.
function addQuota_(reads, writes) {
  if (reads === 0 && writes === 0) return;
  const q = loadQuota_();
  q.reads  += reads;
  q.writes += writes;
  saveQuota_(q);
}

// ─── countItems_ ─────────────────────────────────────────────────────────────
//
// Iterative BFS with a 60-second time-budget and a
// 5000-item cap (consistent with scanFolder). The old recursive DFS had neither
// guard, so on a 10,000+ item folder it could exhaust the 6-minute execution
// limit while holding ScriptLock, killing the batch before any copying happened.
//
// Returns { count, partial }. If partial=true, processBatch sets job.total=0
// so the progress bar stays indeterminate (rather than showing a wrong %).

function countItems_(folderId, startedAt) {
  const CAP      = 5000;
  const DEADLINE = (startedAt || Date.now()) + 60 * 1000;  // max 60s for counting

  const queue = [folderId];
  let count   = 0;

  while (queue.length > 0) {
    if (count >= CAP || Date.now() > DEADLINE) return { count, partial: true };

    const folder = DriveApp.getFolderById(queue.shift());
    count++;  // the folder itself

    const files = folder.getFiles();
    while (files.hasNext()) {
      files.next();
      count++;
      if (count >= CAP) return { count, partial: true };
    }

    const subs = folder.getFolders();
    while (subs.hasNext()) queue.push(subs.next().getId());
  }

  return { count, partial: false };
}