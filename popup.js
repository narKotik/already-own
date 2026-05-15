// popup.js v1.4.0

const LIBRARY_KEY    = "elsLibrary";
const IGNORE_KEY     = "elsIgnoredGames";
const DISMISSED_KEY  = "epicDismissedMatches";

const btnScan        = document.getElementById("btn-scan");
const btnSteamScan   = document.getElementById("btn-steam-scan");
const btnClear       = document.getElementById("btn-clear");
const btnAddGame     = document.getElementById("btn-add-game");
const btnCopyLog     = document.getElementById("btn-copy-log");
const btnClearLog    = document.getElementById("btn-clear-log");
const scanSpinner    = document.getElementById("scan-spinner");
const scanLabel      = document.getElementById("scan-label");
const steamSpinner   = document.getElementById("steam-spinner");
const steamLabel     = document.getElementById("steam-label");
const statusEl       = document.getElementById("status");
const statScan       = document.getElementById("stat-scan");
const statSteamScan  = document.getElementById("stat-steam-scan");
const gamesList      = document.getElementById("games-list");
const libCount       = document.getElementById("lib-count");
const libSearch      = document.getElementById("lib-search");
const libAddInput    = document.getElementById("lib-add-input");
const libAddSource   = document.getElementById("lib-add-source");
const logContainer   = document.getElementById("log-container");
const chkDebugLogs   = document.getElementById("chk-debug-logs");
const libSearchClear = document.getElementById("lib-search-clear");
const btnExport      = document.getElementById("btn-export");
const btnImport      = document.getElementById("btn-import");
const libIoStatus    = document.getElementById("lib-io-status");
const scanDesc       = document.getElementById("scan-desc");
const steamScanDesc  = document.getElementById("steam-scan-desc");

let allGames     = [];  // [{title, source}]
let allIgnored   = [];  // [{title, source}]
let allDismissed = [];
let storedLogs   = [];
let hasAuth      = false;
let hasSteamAuth = false;
let initialLoad  = true;

const normKey     = s => s.replace(/[™®©]/g, "").toLowerCase().trim();
const preferRicher = (a, b) => (/[™®©]/.test(b) && !/[™®©]/.test(a)) ? b : a;

function deduplicateList(arr) {
  const seen = new Map();
  for (const g of arr) {
    const k = normKey(g.title) + ":" + g.source;
    seen.set(k, seen.has(k) ? { ...g, title: preferRicher(seen.get(k).title, g.title) } : g);
  }
  return [...seen.values()];
}

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

function switchTab(name) {
  document.querySelector(`[data-tab="${name}"]`).click();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, type = "") { statusEl.textContent = msg; statusEl.className = type; }

function timeAgo(ts) {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}

// ── Library ───────────────────────────────────────────────────────────────
function loadData() {
  chrome.storage.local.get([LIBRARY_KEY, IGNORE_KEY, DISMISSED_KEY, "epicLastScan", "steamLastScan"], (result) => {
    const rawGames   = result[LIBRARY_KEY]  || [];
    const rawIgnored = result[IGNORE_KEY]   || [];
    allGames     = deduplicateList(rawGames);
    allIgnored   = deduplicateList(rawIgnored);
    allDismissed = result[DISMISSED_KEY] || [];
    if (allGames.length !== rawGames.length || allIgnored.length !== rawIgnored.length) {
      chrome.storage.local.set({ [LIBRARY_KEY]: allGames, [IGNORE_KEY]: allIgnored });
    }
    statScan.textContent      = timeAgo(result.epicLastScan);
    statSteamScan.textContent = timeAgo(result.steamLastScan);
    renderLibrary(libSearch.value);
    renderIgnored();
    renderDismissed();
    if (initialLoad) {
      initialLoad = false;
      if (allGames.length === 0) switchTab("scan");
    }
  });
}

function renderLibrary(filter = "") {
  const q = filter.toLowerCase().trim();
  const filtered = q ? allGames.filter(g => g.title.toLowerCase().includes(q)) : allGames;
  const sorted = filtered.slice().sort((a, b) => a.title.localeCompare(b.title));
  libCount.textContent = `${allGames.length} game${allGames.length !== 1 ? "s" : ""}`;

  if (allGames.length === 0) {
    gamesList.innerHTML = `<div class="empty-state">No games saved yet.<br>Go to Scan tab to import your library.</div>`;
    return;
  }
  if (sorted.length === 0) {
    gamesList.innerHTML = `<div class="empty-state">No games match "${filter}"</div>`;
    return;
  }
  gamesList.innerHTML = "";
  sorted.forEach(g => {
    const item = document.createElement("div");
    item.className = "game-item";
    const badge = document.createElement("span");
    badge.className = `src-badge src-${g.source}`;
    badge.textContent = g.source;
    const name = document.createElement("span");
    name.className = "game-name";
    name.title = g.title;
    name.textContent = g.title;
    const ign = document.createElement("button");
    ign.className = "game-ignore";
    ign.title = "Move to ignore list";
    ign.textContent = "✕";
    ign.addEventListener("click", () => ignoreGame(g));
    item.append(badge, name, ign);
    gamesList.appendChild(item);
  });
}

function renderIgnored() {
  const toggleRow = document.getElementById("ignored-toggle-row");
  const section   = document.getElementById("ignored-section");
  const countEl   = document.getElementById("ignored-count");
  const chevron   = document.getElementById("ignored-chevron");
  const list      = document.getElementById("ignored-list");

  countEl.textContent = allIgnored.length;

  if (allIgnored.length === 0) {
    toggleRow.style.display = "none";
    section.style.display   = "none";
    return;
  }
  toggleRow.style.display = "block";

  const sorted = allIgnored.slice().sort((a, b) => a.title.localeCompare(b.title));
  list.innerHTML = "";
  sorted.forEach(g => {
    const item = document.createElement("div");
    item.className = "game-item";
    const dot = document.createElement("div");
    dot.className = "game-dot-muted";
    const badge = document.createElement("span");
    badge.className = `src-badge src-${g.source}`;
    badge.textContent = g.source;
    const name = document.createElement("span");
    name.className = "game-name";
    name.title = g.title;
    name.textContent = g.title;
    const restore = document.createElement("button");
    restore.className = "game-restore";
    restore.title = "Restore to library";
    restore.textContent = "↩";
    restore.addEventListener("click", () => restoreGame(g));
    const del = document.createElement("button");
    del.className = "game-del";
    del.title = "Remove from ignore list";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteFromIgnored(g));
    item.append(dot, badge, name, restore, del);
    list.appendChild(item);
  });
}

document.getElementById("btn-ignored-toggle").addEventListener("click", () => {
  const section = document.getElementById("ignored-section");
  const chevron = document.getElementById("ignored-chevron");
  const open = section.style.display === "flex";
  section.style.display = open ? "none" : "flex";
  chevron.textContent   = open ? "▸" : "▾";
});

function renderDismissed() {
  const toggleRow = document.getElementById("dismissed-toggle-row");
  const section   = document.getElementById("dismissed-section");
  const countEl   = document.getElementById("dismissed-count");
  const list      = document.getElementById("dismissed-list");

  countEl.textContent = allDismissed.length;
  if (allDismissed.length === 0) {
    toggleRow.style.display = "none";
    section.style.display   = "none";
    return;
  }
  toggleRow.style.display = "block";

  const sorted = allDismissed.slice().sort((a, b) => {
    const at = a.pageTitle ?? a.steamTitle ?? "";
    const bt = b.pageTitle ?? b.steamTitle ?? "";
    return at.localeCompare(bt);
  });
  list.innerHTML = "";
  sorted.forEach(d => {
    const item = document.createElement("div");
    item.className = "game-item";
    const dot = document.createElement("div");
    dot.className = "game-dot-muted";
    const pageTitle    = d.pageTitle    ?? d.steamTitle ?? "?";
    const matchedTitle = d.matchedTitle ?? d.epicTitle  ?? "?";
    const pageId       = d.pageId       ?? d.appId;
    const storeLabel   = d.pageStore === "epic" ? "Epic" : "Steam";
    const name = document.createElement("span");
    name.className = "game-name";
    name.title = `Dismissed on ${storeLabel}: "${matchedTitle}"`;
    name.textContent = `${pageTitle}  ·  ${matchedTitle}`;
    const restore = document.createElement("button");
    restore.className = "game-restore";
    restore.title = "Restore badge for this page";
    restore.textContent = "↩";
    restore.addEventListener("click", () => undismiss(pageId, matchedTitle));
    item.append(dot, name, restore);
    list.appendChild(item);
  });
}

function undismiss(pageId, matchedTitle) {
  allDismissed = allDismissed.filter(d => {
    const dPageId = d.pageId ?? d.appId;
    const dTitle  = d.matchedTitle ?? d.epicTitle;
    return !(dPageId === pageId && dTitle === matchedTitle);
  });
  chrome.storage.local.set({ [DISMISSED_KEY]: allDismissed }, () => loadData());
}

document.getElementById("btn-dismissed-toggle").addEventListener("click", () => {
  const section = document.getElementById("dismissed-section");
  const chevron = document.getElementById("dismissed-chevron");
  const open = section.style.display === "flex";
  section.style.display = open ? "none" : "flex";
  chevron.textContent   = open ? "▸" : "▾";
});

function ignoreGame(game) {
  allGames = allGames.filter(x => !(normKey(x.title) === normKey(game.title) && x.source === game.source));
  if (!allIgnored.some(x => normKey(x.title) === normKey(game.title) && x.source === game.source)) {
    allIgnored.push(game);
  }
  chrome.storage.local.set({ [LIBRARY_KEY]: allGames, [IGNORE_KEY]: allIgnored }, () => loadData());
}

function restoreGame(game) {
  allIgnored = allIgnored.filter(x => !(normKey(x.title) === normKey(game.title) && x.source === game.source));
  if (!allGames.some(x => normKey(x.title) === normKey(game.title) && x.source === game.source)) {
    allGames.push(game);
  }
  chrome.storage.local.set({ [LIBRARY_KEY]: allGames, [IGNORE_KEY]: allIgnored }, () => loadData());
}

function deleteFromIgnored(game) {
  allIgnored = allIgnored.filter(x => !(normKey(x.title) === normKey(game.title) && x.source === game.source));
  chrome.storage.local.set({ [IGNORE_KEY]: allIgnored }, () => loadData());
}

function addGame() {
  const name = libAddInput.value.trim();
  if (!name) { libAddInput.value = ""; return; }
  const source = libAddSource.value;
  const lower = normKey(name);
  if (allGames.some(x => normKey(x.title) === lower && x.source === source)) { libAddInput.value = ""; return; }
  // If already ignored with same title+source, restore it instead of adding a duplicate
  if (allIgnored.some(x => normKey(x.title) === lower && x.source === source)) {
    allIgnored = allIgnored.filter(x => !(normKey(x.title) === lower && x.source === source));
    allGames.push({ title: name, source });
    chrome.storage.local.set({ [LIBRARY_KEY]: allGames, [IGNORE_KEY]: allIgnored }, () => { loadData(); libAddInput.value = ""; });
    return;
  }
  allGames.push({ title: name, source });
  chrome.storage.local.set({ [LIBRARY_KEY]: allGames }, () => { loadData(); libAddInput.value = ""; });
}

btnAddGame.addEventListener("click", addGame);
libAddInput.addEventListener("keydown", e => { if (e.key === "Enter") addGame(); });
libSearch.addEventListener("input", () => {
  libSearchClear.style.display = libSearch.value ? "block" : "none";
  renderLibrary(libSearch.value);
});
libSearchClear.addEventListener("click", () => {
  libSearch.value = "";
  libSearchClear.style.display = "none";
  renderLibrary("");
  libSearch.focus();
});
const clearConfirm = document.getElementById("clear-confirm");
btnClear.addEventListener("click", () => clearConfirm.classList.add("visible"));
document.getElementById("btn-clear-no").addEventListener("click", () => clearConfirm.classList.remove("visible"));
document.getElementById("btn-clear-yes").addEventListener("click", () => {
  clearConfirm.classList.remove("visible");
  chrome.storage.local.remove([LIBRARY_KEY, "epicLastScan", "steamLastScan"], () => { allGames = []; loadData(); });
});

// ── Export / Import ───────────────────────────────────────────────────────
function setLibStatus(msg, type = "", duration = 3000) {
  libIoStatus.textContent = msg;
  libIoStatus.className = type;
  if (duration) setTimeout(() => { libIoStatus.textContent = ""; libIoStatus.className = ""; }, duration);
}

btnExport.addEventListener("click", () => {
  const data = { version: 2, exported: new Date().toISOString(), games: allGames, ignored: allIgnored };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `epic-library-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setLibStatus(`Exported ${allGames.length} games, ${allIgnored.length} ignored`);
});

// Import opens a dedicated tab so the OS file-picker doesn't close the extension popup.
btnImport.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("importer.html") });
});

// ── Logs ──────────────────────────────────────────────────────────────────
function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logContainer.innerHTML = `<div class="log-empty">No logs yet — run a scan first.</div>`;
    return;
  }
  const box = document.createElement("div");
  box.className = "log-box";
  logs.forEach(entry => {
    const el = document.createElement("div");
    el.className = `log-entry ${entry.level}`;
    const dataStr = entry.data ? ` → ${entry.data}` : "";
    el.innerHTML = `<span class="log-time">${entry.time}</span>${entry.msg}${dataStr}`;
    box.appendChild(el);
  });
  logContainer.innerHTML = "";
  logContainer.appendChild(box);
  setTimeout(() => { box.scrollTop = box.scrollHeight; }, 50);
}

btnCopyLog.addEventListener("click", () => {
  const text = storedLogs.map(e =>
    `[${e.time}] [${e.level.toUpperCase()}] ${e.msg}${e.data ? " → " + e.data : ""}`
  ).join("\n");
  navigator.clipboard.writeText(text || "(no logs)").then(() => {
    btnCopyLog.textContent = "Copied!";
    setTimeout(() => { btnCopyLog.textContent = "Copy"; }, 1500);
  });
});

btnClearLog.addEventListener("click", () => { storedLogs = []; renderLogs([]); });

// ── Epic scan ─────────────────────────────────────────────────────────────
function setAuthState(auth) {
  hasAuth = auth;
  btnScan.disabled = false;
  scanSpinner.style.display = "none";
  if (auth) {
    scanLabel.textContent = "🎮 Scan Epic Library";
    scanDesc.textContent = "Reads your owned games from Epic's API using your browser session.";
    scanDesc.classList.remove("warn");
  } else {
    scanLabel.textContent = "🔗 Open Epic Store & Scan";
    scanDesc.textContent = "You're not signed in to Epic. Click to open the store, sign in, then scan.";
    scanDesc.classList.add("warn");
  }
}

chrome.runtime.sendMessage({ action: "checkAuth" }, (r) => setAuthState(!!r?.hasAuth));

btnScan.addEventListener("click", () => {
  if (!hasAuth) {
    chrome.tabs.create({ url: "https://store.epicgames.com" });
    setStatus("Sign in to Epic, then reopen this popup and click Scan.", "warn");
    scanDesc.textContent = "Sign in to Epic in the tab that just opened, then come back here and click Scan.";
    return;
  }

  btnScan.disabled = true;
  scanSpinner.style.display = "block";
  scanLabel.textContent = "Scanning…";
  setStatus("", "");

  chrome.runtime.sendMessage({ action: "doScan", authToken: null, accountId: null }, (response) => {
    if (chrome.runtime.lastError) {
      setAuthState(hasAuth);
      setStatus("Extension error — try reloading.", "err");
      return;
    }
    if (!response) {
      setAuthState(hasAuth);
      setStatus("No response received.", "err");
      return;
    }

    if (response.logs?.length) {
      storedLogs = response.logs;
      renderLogs(storedLogs);
    }

    if (!response.success) {
      const authErr = response.error?.includes("401") || response.error?.includes("403") || response.error?.includes("authenticated");
      if (authErr) {
        setAuthState(false);
        setStatus("Not signed in to Epic in Chrome — click the button to open the store and log in.", "warn");
      } else {
        setAuthState(true);
        setStatus(`❌ ${response.error}`, "err");
        switchTab("logs");
      }
      return;
    }

    setAuthState(true);
    if (!response.games?.length) {
      setStatus("⚠️ Scan ran but found 0 games — check Logs tab.", "warn");
      switchTab("logs");
    } else {
      setStatus(`✅ ${response.total} Epic games saved (${response.added} new) via ${response.method}`, "ok");
      loadData();
      switchTab("library");
    }
  });
});

// ── Steam scan ────────────────────────────────────────────────────────────
function setSteamAuthState(auth) {
  hasSteamAuth = auth;
  btnSteamScan.disabled = false;
  steamSpinner.style.display = "none";
  if (auth) {
    steamLabel.textContent = "🎮 Scan Steam Library";
    steamScanDesc.textContent = "Reads your owned games from Steam using your browser session.";
    steamScanDesc.classList.remove("warn");
  } else {
    steamLabel.textContent = "🔗 Open Steam & Scan";
    steamScanDesc.textContent = "You're not signed in to Steam. Click to open the store, sign in, then scan.";
    steamScanDesc.classList.add("warn");
  }
}

chrome.runtime.sendMessage({ action: "checkSteamAuth" }, (r) => setSteamAuthState(!!r?.hasAuth));

btnSteamScan.addEventListener("click", () => {
  if (!hasSteamAuth) {
    chrome.tabs.create({ url: "https://store.steampowered.com" });
    setStatus("Sign in to Steam, then reopen this popup and click Scan.", "warn");
    steamScanDesc.textContent = "Sign in to Steam in the tab that just opened, then come back here and click Scan.";
    return;
  }

  btnSteamScan.disabled = true;
  steamSpinner.style.display = "block";
  steamLabel.textContent = "Scanning…";
  setStatus("", "");

  chrome.runtime.sendMessage({ action: "doSteamScan" }, (response) => {
    if (chrome.runtime.lastError) {
      setSteamAuthState(hasSteamAuth);
      setStatus("Extension error — try reloading.", "err");
      return;
    }
    if (!response) {
      setSteamAuthState(hasSteamAuth);
      setStatus("No response received.", "err");
      return;
    }

    if (response.logs?.length) {
      storedLogs = response.logs;
      renderLogs(storedLogs);
    }

    if (!response.success) {
      const notLoggedIn = response.error?.includes("Not logged") || response.error?.includes("not logged");
      if (notLoggedIn) {
        setSteamAuthState(false);
        setStatus("Not signed in to Steam — click the button to open the store and log in.", "warn");
      } else {
        setSteamAuthState(true);
        setStatus(`❌ ${response.error}`, "err");
        switchTab("logs");
      }
      return;
    }

    setSteamAuthState(true);
    if (!response.games?.length) {
      setStatus("⚠️ Steam scan ran but found 0 games — check Logs tab.", "warn");
      switchTab("logs");
    } else {
      setStatus(`✅ ${response.total} Steam games saved (${response.added} new)`, "ok");
      loadData();
      switchTab("library");
    }
  });
});

// ── Debug logs toggle (footer checkbox) ───────────────────────────────────
function applyDebugState(enabled) {
  const logsTabBtn = document.getElementById("tab-btn-logs");
  logsTabBtn.style.display = enabled ? "" : "none";
  if (!enabled && logsTabBtn.classList.contains("active")) switchTab("library");
}

chrome.storage.local.get("epicDebugLogs", (r) => {
  const enabled = !!r.epicDebugLogs;
  chkDebugLogs.checked = enabled;
  applyDebugState(enabled);
});

chkDebugLogs.addEventListener("change", () => {
  const enabled = chkDebugLogs.checked;
  chrome.storage.local.set({ epicDebugLogs: enabled });
  applyDebugState(enabled);
});

// ── Init ──────────────────────────────────────────────────────────────────
loadData();

// Refresh library if the importer tab writes new data while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (LIBRARY_KEY in changes || IGNORE_KEY in changes)) {
    loadData();
    setLibStatus("Library updated from import", "ok");
  }
});
setInterval(() => {
  chrome.storage.local.get(["epicLastScan", "steamLastScan"], r => {
    statScan.textContent      = timeAgo(r.epicLastScan);
    statSteamScan.textContent = timeAgo(r.steamLastScan);
  });
}, 30000);
