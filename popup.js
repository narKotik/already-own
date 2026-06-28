// popup.js v1.5.0

const LIBRARY_KEY   = "elsLibrary";
const IGNORE_KEY    = "elsIgnoredGames";
const DISMISSED_KEY = "epicDismissedMatches";
const SETTINGS_KEY  = "elsSettings";

const DEFAULT_SETTINGS = {
  matchExact: true, matchPartial: true, matchFuzzy: true,
  uiLocale: "en-US", debugLogs: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────
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
const libSearchClear = document.getElementById("lib-search-clear");
const btnExport      = document.getElementById("btn-export");
const btnImport      = document.getElementById("btn-import");
const libIoStatus    = document.getElementById("lib-io-status");
const scanDesc       = document.getElementById("scan-desc");
const steamScanDesc  = document.getElementById("steam-scan-desc");
// Settings refs
const chkMatchExact   = document.getElementById("chk-match-exact");
const chkMatchPartial = document.getElementById("chk-match-partial");
const chkMatchFuzzy   = document.getElementById("chk-match-fuzzy");
const chkDebugLogs    = document.getElementById("chk-debug-logs");
const selUiLocale     = document.getElementById("sel-ui-locale");

// ── State ─────────────────────────────────────────────────────────────────
let i18n = {};
let currentSettings = { ...DEFAULT_SETTINGS };
let allGames     = [];
let allIgnored   = [];
let allDismissed = [];
let storedLogs   = [];
let hasAuth      = false;
let hasSteamAuth = false;
let initialLoad  = true;
let epicScanActive  = false; // true while a background Epic scan is running
let steamScanActive = false;

const normKey      = s => s.replace(/[™®©]/g, "").toLowerCase().trim();
const preferRicher = (a, b) => (/[™®©]/.test(b) && !/[™®©]/.test(a)) ? b : a;

// ── i18n ──────────────────────────────────────────────────────────────────
async function loadI18n(locale) {
  // Always load en-US as a base layer so any key missing from a translated
  // locale falls back to English instead of showing the raw key name.
  let base = {};
  try { base = await fetch(chrome.runtime.getURL("locales/en-US.json")).then(r => r.json()); } catch { /* */ }

  if (locale === "en-US") { i18n = base; return; }

  try {
    const r = await fetch(chrome.runtime.getURL(`locales/${locale}.json`));
    if (!r.ok) throw new Error(r.status);
    i18n = { ...base, ...(await r.json()) };
  } catch {
    i18n = base;
  }
}

function t(key, vars = {}) {
  let s = i18n[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.getElementById("ignored-hint-text").textContent = t("lib_ignored_hint");
  document.getElementById("dismissed-hint-text").textContent = t("lib_dismissed_hint");
  // What's New banner uses {v} interpolation, so it can't be a plain data-i18n
  // element — re-apply its text on every locale change while it's visible.
  if (document.getElementById("whatsnew")?.style.display === "flex") setWhatsNewText();
  // Scan button labels depend on auth state, not data-i18n attributes
  setAuthState(hasAuth);
  setSteamAuthState(hasSteamAuth);
}

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
  const raw = await new Promise(r => chrome.storage.local.get([SETTINGS_KEY, "epicDebugLogs"], r));
  const stored = raw[SETTINGS_KEY] ?? {};
  // Migrate old epicDebugLogs key
  if (raw.epicDebugLogs !== undefined && stored.debugLogs === undefined) {
    stored.debugLogs = !!raw.epicDebugLogs;
  }
  currentSettings = { ...DEFAULT_SETTINGS, ...stored };
  return currentSettings;
}

function saveSettings() {
  chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings });
}

function applySettingsToUI(s) {
  chkMatchExact.checked   = s.matchExact;
  chkMatchPartial.checked = s.matchPartial;
  chkMatchFuzzy.checked   = s.matchFuzzy;
  chkDebugLogs.checked    = s.debugLogs;
  selUiLocale.value       = s.uiLocale;
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
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (btn) btn.click();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, type = "") { statusEl.textContent = msg; statusEl.className = type; }

function timeAgo(ts) {
  if (!ts) return t("scan_never");
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60)    return t("time_now");
  if (d < 3600)  return t("time_min", { n: Math.floor(d / 60) });
  if (d < 86400) return t("time_hr",  { n: Math.floor(d / 3600) });
  return t("time_day", { n: Math.floor(d / 86400) });
}

function deduplicateList(arr) {
  const seen = new Map();
  for (const g of arr) {
    const k = normKey(g.title) + ":" + g.source;
    seen.set(k, seen.has(k) ? { ...g, title: preferRicher(seen.get(k).title, g.title) } : g);
  }
  return [...seen.values()];
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
  libCount.textContent = allGames.length === 1 ? t("lib_count_1", { n: 1 }) : t("lib_count", { n: allGames.length });

  if (allGames.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = t("lib_empty");
    gamesList.innerHTML = "";
    gamesList.appendChild(el);
    return;
  }
  if (sorted.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = t("lib_empty_filter", { q: filter });
    gamesList.innerHTML = "";
    gamesList.appendChild(el);
    return;
  }
  gamesList.innerHTML = "";
  sorted.forEach(g => {
    const item = document.createElement("div");
    item.className = "game-item";
    const badge = document.createElement("span");
    badge.className = `src-badge src-${g.source}`;
    badge.textContent = t(`src_${g.source}`) !== `src_${g.source}` ? t(`src_${g.source}`) : g.source;
    const name = document.createElement("span");
    name.className = "game-name";
    name.title = g.title;
    name.textContent = g.title;
    const ign = document.createElement("button");
    ign.className = "game-ignore";
    ign.title = t("lib_ignore_title");
    ign.textContent = "✕";
    ign.addEventListener("click", () => ignoreGame(g));
    item.append(badge, name, ign);
    gamesList.appendChild(item);
  });
}

function renderIgnored() {
  const toggleRow = document.getElementById("ignored-toggle-row");
  const section   = document.getElementById("ignored-section");
  const headerText = document.getElementById("ignored-header-text");
  const chevron   = document.getElementById("ignored-chevron");
  const list      = document.getElementById("ignored-list");

  headerText.textContent = "";
  const labelSpan = document.createElement("span");
  labelSpan.textContent = t("lib_ignored_header", { n: allIgnored.length });
  headerText.appendChild(labelSpan);

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
    badge.textContent = t(`src_${g.source}`) !== `src_${g.source}` ? t(`src_${g.source}`) : g.source;
    const name = document.createElement("span");
    name.className = "game-name";
    name.title = g.title;
    name.textContent = g.title;
    const restore = document.createElement("button");
    restore.className = "game-restore";
    restore.title = t("lib_restore_title");
    restore.textContent = "↩";
    restore.addEventListener("click", () => restoreGame(g));
    const del = document.createElement("button");
    del.className = "game-del";
    del.title = t("lib_delete_title");
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
  const headerText = document.getElementById("dismissed-header-text");
  const list      = document.getElementById("dismissed-list");

  headerText.textContent = "";
  const labelSpan = document.createElement("span");
  labelSpan.textContent = t("lib_dismissed_header", { n: allDismissed.length });
  headerText.appendChild(labelSpan);

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
    restore.title = t("lib_undismiss_title");
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
  chrome.storage.local.remove([LIBRARY_KEY, "epicLastScan", "steamLastScan", "epicOrderLastScan"], () => { allGames = []; loadData(); });
});

// ── Export / Import ───────────────────────────────────────────────────────
function setLibStatus(msg, type = "", duration = 3000) {
  libIoStatus.textContent = msg;
  libIoStatus.className = type;
  if (duration) setTimeout(() => { libIoStatus.textContent = ""; libIoStatus.className = ""; }, duration);
}

btnExport.addEventListener("click", () => {
  const data = { version: 2, exported: new Date().toISOString(), games: allGames, ignored: allIgnored, dismissed: allDismissed };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `epic-library-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setLibStatus(t("export_done", { n: allGames.length, i: allIgnored.length }));
});

btnImport.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("importer.html") });
});

// ── Logs ──────────────────────────────────────────────────────────────────
function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    const el = document.createElement("div");
    el.className = "log-empty";
    el.textContent = t("logs_empty");
    logContainer.innerHTML = "";
    logContainer.appendChild(el);
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
    btnCopyLog.textContent = t("logs_copied");
    setTimeout(() => { btnCopyLog.textContent = t("logs_copy"); }, 1500);
  });
});

btnClearLog.addEventListener("click", () => { storedLogs = []; renderLogs([]); });

// ── Debug / Logs tab ──────────────────────────────────────────────────────
function applyDebugState(enabled) {
  const logsTabBtn = document.getElementById("tab-btn-logs");
  logsTabBtn.style.display = enabled ? "" : "none";
  if (!enabled && logsTabBtn.classList.contains("active")) switchTab("library");
}

chkDebugLogs.addEventListener("change", () => {
  currentSettings.debugLogs = chkDebugLogs.checked;
  saveSettings();
  applyDebugState(chkDebugLogs.checked);
});

// ── Epic scan ─────────────────────────────────────────────────────────────
function setAuthState(auth) {
  hasAuth = auth;
  if (epicScanActive) return;
  btnScan.disabled = false;
  scanSpinner.style.display = "none";
  if (auth) {
    scanLabel.textContent = t("scan_epic_btn");
    scanDesc.textContent  = t("scan_epic_ready");
    scanDesc.classList.remove("warn");
  } else {
    scanLabel.textContent = t("scan_epic_btn_noauth");
    scanDesc.textContent  = t("scan_epic_noauth");
    scanDesc.classList.add("warn");
  }
}

btnScan.addEventListener("click", () => {
  if (!hasAuth) {
    chrome.tabs.create({ url: "https://store.epicgames.com" });
    setStatus(t("sign_in_epic"), "warn");
    scanDesc.textContent = t("sign_in_epic_desc");
    return;
  }
  epicScanActive = true;
  btnScan.disabled = true;
  scanSpinner.style.display = "block";
  scanLabel.textContent = t("scanning");
  setStatus("", "");

  chrome.runtime.sendMessage({ action: "doScan", authToken: null, accountId: null }, (response) => {
    epicScanActive = false;
    if (chrome.runtime.lastError) {
      setAuthState(hasAuth);
      setStatus(t("err_ext"), "err");
      return;
    }
    if (!response) {
      setAuthState(hasAuth);
      setStatus(t("err_no_response"), "err");
      return;
    }
    if (currentSettings.debugLogs && response.logs?.length) { storedLogs = response.logs; renderLogs(storedLogs); }

    if (!response.success) {
      const authErr = response.error?.includes("401") || response.error?.includes("403") || response.error?.includes("authenticated");
      if (authErr) {
        setAuthState(false);
        setStatus(t("noauth_epic"), "warn");
      } else {
        setAuthState(true);
        setStatus(`❌ ${response.error}`, "err");
        if (currentSettings.debugLogs) switchTab("logs");
      }
      return;
    }
    setAuthState(true);
    if (!response.games?.length) {
      setStatus(t("scan_zero_epic"), "warn");
    } else {
      setStatus(t("scan_ok_epic", { total: response.total, added: response.added, method: response.method }), "ok");
      loadData();
      switchTab("library");
    }
  });
});

// ── Steam scan ────────────────────────────────────────────────────────────
function setSteamAuthState(auth) {
  hasSteamAuth = auth;
  if (steamScanActive) return;
  btnSteamScan.disabled = false;
  steamSpinner.style.display = "none";
  if (auth) {
    steamLabel.textContent    = t("scan_steam_btn");
    steamScanDesc.textContent = t("scan_steam_ready");
    steamScanDesc.classList.remove("warn");
  } else {
    steamLabel.textContent    = t("scan_steam_btn_noauth");
    steamScanDesc.textContent = t("scan_steam_noauth");
    steamScanDesc.classList.add("warn");
  }
}

btnSteamScan.addEventListener("click", () => {
  if (!hasSteamAuth) {
    chrome.tabs.create({ url: "https://store.steampowered.com" });
    setStatus(t("sign_in_steam"), "warn");
    steamScanDesc.textContent = t("sign_in_steam_desc");
    return;
  }
  steamScanActive = true;
  btnSteamScan.disabled = true;
  steamSpinner.style.display = "block";
  steamLabel.textContent = t("scanning");
  setStatus("", "");

  chrome.runtime.sendMessage({ action: "doSteamScan" }, (response) => {
    steamScanActive = false;
    if (chrome.runtime.lastError) {
      setSteamAuthState(hasSteamAuth);
      setStatus(t("err_ext"), "err");
      return;
    }
    if (!response) {
      setSteamAuthState(hasSteamAuth);
      setStatus(t("err_no_response"), "err");
      return;
    }
    if (currentSettings.debugLogs && response.logs?.length) { storedLogs = response.logs; renderLogs(storedLogs); }

    if (!response.success) {
      const notLoggedIn = response.error?.includes("Not logged") || response.error?.includes("not logged") || response.error?.includes("Not signed");
      if (notLoggedIn) {
        setSteamAuthState(false);
        setStatus(t("noauth_steam"), "warn");
      } else {
        setSteamAuthState(true);
        setStatus(`❌ ${response.error}`, "err");
        if (currentSettings.debugLogs) switchTab("logs");
      }
      return;
    }
    setSteamAuthState(true);
    if (!response.games?.length) {
      setStatus(t("scan_zero_steam"), "warn");
    } else {
      setStatus(t("scan_ok_steam", { total: response.total, added: response.added }), "ok");
      loadData();
      switchTab("library");
    }
  });
});

// ── Settings panel ────────────────────────────────────────────────────────
[chkMatchExact, chkMatchPartial, chkMatchFuzzy].forEach(chk => {
  chk.addEventListener("change", function () {
    const anyChecked = chkMatchExact.checked || chkMatchPartial.checked || chkMatchFuzzy.checked;
    if (!anyChecked) { this.checked = true; return; }
    currentSettings.matchExact   = chkMatchExact.checked;
    currentSettings.matchPartial = chkMatchPartial.checked;
    currentSettings.matchFuzzy   = chkMatchFuzzy.checked;
    saveSettings();
  });
});

selUiLocale.addEventListener("change", async () => {
  currentSettings.uiLocale = selUiLocale.value;
  saveSettings();
  await loadI18n(currentSettings.uiLocale);
  applyI18n();
  // Re-render dynamic content that uses translated strings
  renderLibrary(libSearch.value);
  renderIgnored();
  renderDismissed();
  setAuthState(hasAuth);
  setSteamAuthState(hasSteamAuth);
  applyDebugState(currentSettings.debugLogs);
  // Update lib count
  libCount.textContent = allGames.length === 1 ? t("lib_count_1", { n: 1 }) : t("lib_count", { n: allGames.length });
});

// Clear data buttons
let pendingClearAction = null;
const settingsConfirm = document.getElementById("settings-confirm");

function showClearConfirm(action) {
  pendingClearAction = action;
  settingsConfirm.classList.add("visible");
}

document.getElementById("btn-clr-dismissed").addEventListener("click", () => showClearConfirm("dismissed"));
document.getElementById("btn-clr-ignored").addEventListener("click",   () => showClearConfirm("ignored"));
document.getElementById("btn-clr-library").addEventListener("click",   () => showClearConfirm("library"));

document.getElementById("btn-s-confirm-no").addEventListener("click", () => {
  pendingClearAction = null;
  settingsConfirm.classList.remove("visible");
});

document.getElementById("btn-s-confirm-yes").addEventListener("click", () => {
  settingsConfirm.classList.remove("visible");
  if (!pendingClearAction) return;
  if (pendingClearAction === "dismissed") {
    chrome.storage.local.remove(DISMISSED_KEY, () => loadData());
  } else if (pendingClearAction === "ignored") {
    chrome.storage.local.remove(IGNORE_KEY, () => loadData());
  } else if (pendingClearAction === "library") {
    chrome.storage.local.remove(
      [LIBRARY_KEY, IGNORE_KEY, DISMISSED_KEY, "epicLastScan", "steamLastScan", "epicOrderLastScan"],
      () => { allGames = []; allIgnored = []; allDismissed = []; loadData(); }
    );
  }
  pendingClearAction = null;
});

// ── What's New banner ─────────────────────────────────────────────────────
const CURRENT_VERSION = "1.7.1";
function setWhatsNewText() {
  document.getElementById("whatsnew-title").textContent = t("whatsnew_title", { v: CURRENT_VERSION });
  document.getElementById("whatsnew-body").textContent  = t("whatsnew_body");
}
function maybeShowWhatsNew() {
  // Clear the toolbar "NEW" badge now that the popup is open.
  chrome.action.setBadgeText({ text: "" });
  chrome.storage.local.get(["updatedToVersion", "whatsNewSeen"], (r) => {
    // Show only when an update flagged the current version and the user
    // hasn't dismissed this version's note yet.
    if (r.updatedToVersion !== CURRENT_VERSION || r.whatsNewSeen === CURRENT_VERSION) return;
    setWhatsNewText();
    document.getElementById("whatsnew").style.display = "flex";
  });
}
document.getElementById("whatsnew-close").addEventListener("click", () => {
  document.getElementById("whatsnew").style.display = "none";
  chrome.storage.local.set({ whatsNewSeen: CURRENT_VERSION });
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  const settings = await loadSettings();
  await loadI18n(settings.uiLocale);
  applyI18n();
  applySettingsToUI(settings);
  applyDebugState(settings.debugLogs);
  loadData();
  maybeShowWhatsNew();
  chrome.runtime.sendMessage({ action: "checkAuth" },      (r) => setAuthState(!!r?.hasAuth));
  chrome.runtime.sendMessage({ action: "checkSteamAuth" }, (r) => setSteamAuthState(!!r?.hasAuth));

  // Restore scanning UI if a scan was running when the popup was last closed.
  // Treat anything older than 7 minutes as stale (service worker died mid-scan).
  const STALE_MS = 5 * 60 * 1000;
  chrome.storage.local.get(["epicScanInProgress", "epicScanStartedAt", "steamScanInProgress", "steamScanStartedAt"], (r) => {
    const now = Date.now();
    if (r.epicScanInProgress) {
      if (now - (r.epicScanStartedAt || 0) < STALE_MS) {
        epicScanActive = true;
        btnScan.disabled = true;
        scanSpinner.style.display = "block";
        scanLabel.textContent = t("scanning");
        scanDesc.textContent = t("scan_resuming_epic");
        scanDesc.classList.remove("warn");
      } else {
        chrome.storage.local.remove(["epicScanInProgress", "epicScanStartedAt"]);
      }
    }
    if (r.steamScanInProgress) {
      if (now - (r.steamScanStartedAt || 0) < STALE_MS) {
        steamScanActive = true;
        btnSteamScan.disabled = true;
        steamSpinner.style.display = "block";
        steamLabel.textContent = t("scanning");
        steamScanDesc.textContent = t("scan_resuming_steam");
        steamScanDesc.classList.remove("warn");
      } else {
        chrome.storage.local.remove(["steamScanInProgress", "steamScanStartedAt"]);
      }
    }
  });
}

init();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Scan finished while popup was closed — clear active flag, reset UI, reload.
  // newValue is undefined when the key was removed via chrome.storage.local.remove().
  if ("epicScanInProgress" in changes && changes.epicScanInProgress.newValue === undefined) {
    epicScanActive = false;
    setAuthState(hasAuth);
    loadData();
  }
  if ("steamScanInProgress" in changes && changes.steamScanInProgress.newValue === undefined) {
    steamScanActive = false;
    setSteamAuthState(hasSteamAuth);
    loadData();
  }
  // Only show "import done" for actual file imports, not scan saves.
  if (LIBRARY_KEY in changes || IGNORE_KEY in changes) {
    loadData();
    if (!epicScanActive && !steamScanActive) setLibStatus(t("import_done"), "ok");
  }
});

setInterval(() => {
  chrome.storage.local.get(["epicLastScan", "steamLastScan"], r => {
    statScan.textContent      = timeAgo(r.epicLastScan);
    statSteamScan.textContent = timeAgo(r.steamLastScan);
  });
}, 30000);
