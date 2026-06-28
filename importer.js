// importer.js — runs in the dedicated import tab
const LIBRARY_KEY   = "elsLibrary";
const IGNORE_KEY    = "elsIgnoredGames";
const DISMISSED_KEY = "epicDismissedMatches";

const normKey      = t => t.replace(/[™®©]/g, "").toLowerCase().trim();
const preferRicher = (a, b) => (/[™®©]/.test(b) && !/[™®©]/.test(a)) ? b : a;

function deduplicateList(arr) {
  const seen = new Map();
  for (const g of arr) {
    const k = normKey(g.title) + ":" + g.source;
    seen.set(k, seen.has(k) ? { ...g, title: preferRicher(seen.get(k).title, g.title) } : g);
  }
  return [...seen.values()];
}

const dropZone  = document.getElementById("drop-zone");
const importFile = document.getElementById("import-file");
const statusEl  = document.getElementById("status");

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function processFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setStatus("File too large (max 5 MB)", "err"); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data.games) && !Array.isArray(data.ignored) && !Array.isArray(data.dismissed)) throw new Error();

      const sanitizeEntry = g => {
        if (typeof g === "string" && g.length > 0 && g.length <= 300)
          return { title: g, source: "other" };
        if (g && typeof g === "object" && typeof g.title === "string" && g.title.length > 0 && g.title.length <= 300) {
          const src = ["epic", "steam", "other"].includes(g.source) ? g.source : "other";
          return { title: g.title, source: src };
        }
        return null;
      };
      const sanitize = arr => (arr || []).map(sanitizeEntry).filter(Boolean).slice(0, 10000);
      const newGames     = sanitize(data.games);
      const newIgnored   = sanitize(data.ignored);
      const newDismissed = Array.isArray(data.dismissed)
        ? data.dismissed.filter(d => d && typeof d === "object" && (typeof d.pageId === "string" || typeof d.appId === "string")).slice(0, 10000)
        : [];

      chrome.storage.local.get([LIBRARY_KEY, IGNORE_KEY, DISMISSED_KEY], (result) => {
        const allGames     = result[LIBRARY_KEY]   || [];
        const allIgnored   = result[IGNORE_KEY]    || [];
        const allDismissed = result[DISMISSED_KEY] || [];

        const mergedGames   = deduplicateList([...allGames,   ...newGames]);
        const mergedIgnored = deduplicateList([...allIgnored, ...newIgnored]);
        const ignoredKeys   = new Set(mergedIgnored.map(g => normKey(g.title)));

        // Remove "other"-source entries whose title already exists as "steam"/"epic"
        // to prevent v1-format imports from creating duplicates alongside scan results.
        const specificTitles = new Set(
          mergedGames.filter(g => g.source === "steam" || g.source === "epic").map(g => normKey(g.title))
        );
        const dedupedGames = mergedGames.filter(g =>
          g.source !== "other" || !specificTitles.has(normKey(g.title))
        );
        const finalGames = dedupedGames.filter(g => !ignoredKeys.has(normKey(g.title)));

        const existingKeys = new Set(allGames.map(g => normKey(g.title) + ":" + g.source));
        const addedCount = finalGames.filter(g => !existingKeys.has(normKey(g.title) + ":" + g.source)).length;

        // Merge dismissed: deduplicate by pageId+matchedTitle
        const dismissedSeen = new Set(allDismissed.map(d => `${d.pageId ?? d.appId}|${d.matchedTitle ?? d.epicTitle}`));
        const addedDismissed = newDismissed.filter(d => !dismissedSeen.has(`${d.pageId ?? d.appId}|${d.matchedTitle ?? d.epicTitle}`));
        const mergedDismissed = [...allDismissed, ...addedDismissed];

        chrome.storage.local.set({ [LIBRARY_KEY]: finalGames, [IGNORE_KEY]: mergedIgnored, [DISMISSED_KEY]: mergedDismissed }, () => {
          if (chrome.runtime.lastError) {
            setStatus("Save failed: " + chrome.runtime.lastError.message, "err");
            return;
          }
          const ignoredMsg   = newIgnored.length   ? `, ${newIgnored.length} ignored`               : "";
          const dismissedMsg = addedDismissed.length ? `, ${addedDismissed.length} dismissed`       : "";
          const msg = addedCount > 0
            ? `✅ ${addedCount} games added (${finalGames.length} total)${ignoredMsg}${dismissedMsg}`
            : `ℹ️ No new games — library has ${finalGames.length}${ignoredMsg}${dismissedMsg}`;
          setStatus(msg, "ok");
          setTimeout(() => window.close(), 2000);
        });
      });
    } catch {
      setStatus("Invalid file — expected a JSON export from this extension", "err");
    }
  };
  reader.readAsText(file);
}

dropZone.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  importFile.value = "";
  processFile(file);
});

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("over");
  processFile(e.dataTransfer.files[0]);
});
