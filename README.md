# D³ — Duplicate Directories in Drive

**Free and unlimited folder copying for Google Drive.**

→ **[Try the live version](https://bit.ly/D3-drive-copier)**  

---

## The problem

Google Drive has no built-in way to duplicate a folder tree. If you want to copy a folder — along with all its subfolders and files — you have to do it manually, file by file, or pay for a third-party tool that either imposes its own quota limits or requires you to hand your Drive access to an external service.

That's the situation I was in. Every solution I found with google was either paid, limited, or sketchy. So I built one that isn't any of those things.

---

## What D3 does

D3 is a web app that recursively copies Google Drive folder trees — any depth, any size, completely free. You pick a source folder and a destination, choose how to handle conflicts, and it does the rest. You can close the browser tab and it keeps running in the background on Google's own servers. No third-party service ever touches your files.

### Features

- **Recursive folder copying** — all subfolders and files to any depth
- **Four conflict strategies** — Rename (keep both), Merge (copy new, keep existing), Update (mirror source into destination), Overwrite (replace everything)
- **Background copying** — close the tab and copying continues via Google's trigger system
- **Multi-job queue** — queue multiple copy jobs; they run sequentially
- **Pause, resume, cancel** — full job control at any time
- **Preflight check** — shows item count, estimated size, and free space before each job
- **Smart permission copying** — optionally copies explicit permissions without flooding everyone with notification emails
- **Google-native file support** — optionally copies Docs, Sheets, Slides, and Forms in their native format
- **ETA display** — estimated time remaining based on measured copy speed
- **Throttle control** — Normal / Careful / Slow presets to manage API usage
- **Scheduled copying** — auto-resume paused jobs at a set time daily
- **Copy log export** — download job history as CSV

---

## How it works

D3 is a [Google Apps Script](https://script.google.com) web app. It has no external server, no database, no third-party dependencies. Everything runs inside Google's infrastructure within your own Google account.

- **Copying** happens via Apps Script's time-based trigger system — scheduled execution that runs server-side even when your browser is closed
- **State** (job queue, progress, settings) is stored in Apps Script's `UserProperties` — scoped entirely to your Google account and inaccessible to anyone else
- **Folder browsing and file copying** use Google's Drive API v3 directly
- **The entire app is two files:** `Code.gs` (backend, ~1300 lines) and `App.html` (frontend UI, ~2700 lines)

---

## How this was made

I needed this tool, couldn't find a free one that worked, and decided to build it. I have no background in Apps Script or web development, so I used [Claude](https://claude.ai) to write all the code while I led the design process, defined the feature set, and tested each phase.

The project went through 20+ development phases and multiple conversations — starting from a basic copy loop and ending up with a full-featured app with a polished UI, smart permission handling, quota awareness, ETA calculation, and more. Every design decision was deliberate and is documented in the [HANDOFF document](HANDOFF.md).

The result is something I'm genuinely proud of and use myself. I'm sharing it because it solves a real problem and I couldn't find anything else at the time that did it this cleanly for free.

---

## Deploy your own copy

Because D3 is a Google Apps Script project, each person can run their own copy, for free, from within their own Google account. Deployment takes about 5 minutes.

### 1. Create the project

1. Go to [script.google.com](https://script.google.com) and sign in
2. Click **New project** and give it a name (e.g. `D3 - Drive Copier`)

### 2. Add the files

1. Click on `Code.gs` in the file list and **replace all its contents** with the contents of [`Code.gs`](Code.gs) from this repo along with any changes you made
2. Click the **+** icon next to Files → **HTML** → name it exactly `App` → replace its contents with [`App.html`](App.html) along with any changes you made
3. Optionally - In **Project Settings** (⚙️ gear icon) → check **"Show appsscript.json manifest file in editor"** → click `appsscript.json` and replace its contents with [`appsscript.json`](appsscript.json)

### 3. Enable the Drive Advanced Service

1. In the left sidebar click **Services** (+)
2. Find **Drive API**, select version **v3**, click **Add**

### 4. Deploy as a web app

1. Click **Deploy** → **New deployment** → gear icon → **Web app**
2. Set **Execute as** and **Who has access** to whatever suits your use case
3. Click **Deploy** and copy the `/exec` URL — that's your D3

> **Note:** When you open it for the first time Google will show an "unverified app" warning — this is standard for any self-deployed Apps Script project. Click **Advanced** → **Go to [your project name] (unsafe)** → review the permissions → **Allow**.

---

## Project status

This project is **complete and not being actively maintained** by me. I built it to solve a specific problem, it solves that problem well, and I consider it done.

That said — the full source is here, it's MIT licensed, and I genuinely encourage anyone who wants to add features or fix things to fork it and iterate. The codebase comes with a detailed [HANDOFF document](HANDOFF.md) that explains every design decision, the complete development history, architecture notes, and known limitations — written specifically so that someone new (or an AI assistant) can pick it up easily.

If you build something meaningful on top of this, I'd love to hear about it.

---

## Repository contents

| File | Description |
|------|-------------|
| `Code.gs` | Backend — copy engine, job queue, trigger management |
| `App.html` | Frontend — UI, CSS, JavaScript |
| `appsscript.json` | Project manifest — OAuth scopes, runtime settings |
| `README.md` | This file |
| `HANDOFF.md` | Full technical documentation — architecture, design decisions, phase history |
| `privacy.html` | Privacy policy (served via GitHub Pages) |
| `LICENSE` | MIT licence |

---

## Licence

MIT — see [LICENSE](LICENSE)

---

## Privacy

D3 accesses your Google Drive only to copy folders as directed by you. No data is sent to any external server outside Google's infrastructure. See the full [Privacy Policy](https://AOZ314.github.io/D3-drive-copier/privacy.html).
