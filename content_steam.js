// content_steam.js — Runs on Steam store app pages
// Checks if current game is in your library (Epic or other sources) and injects a badge

(function () {
  "use strict";

  const LIBRARY_KEY   = "elsLibrary";
  const DISMISSED_KEY = "epicDismissedMatches";
  const SETTINGS_KEY  = "elsSettings";

  const DEFAULT_SETTINGS = {
    matchExact: true, matchPartial: true, matchFuzzy: true,
    uiLocale: "en-US",
  };

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function loadLocale(locale) {
    try {
      const url = chrome.runtime.getURL(`locales/${locale}.json`);
      return await fetch(url).then(r => r.json());
    } catch {
      if (locale !== "en-US") {
        try { return await fetch(chrome.runtime.getURL("locales/en-US.json")).then(r => r.json()); } catch { /**/ }
      }
      return {};
    }
  }

  function tr(strings, key, vars = {}) {
    let s = strings[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }

  // ── Normalize title for fuzzy comparison ──────────────────────────────────
  function normalize(title) {
    return title.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  function sigWords(s) { return s.split(" ").filter(w => w.length > 2 || /^\d+$/.test(w)); }

  function isMatch(steamTitle, epicTitles, settings) {
    const sn = normalize(steamTitle);
    const sWords = new Set(sigWords(sn));
    const RANK = { exact: 3, partial: 2, fuzzy: 1 };
    let best = null;

    for (const et of epicTitles) {
      const en = normalize(et);
      let confidence = null;

      if (sn === en) {
        confidence = "exact";
      } else if (sn.includes(en) || en.includes(sn)) {
        confidence = "partial";
      } else {
        const eWords = sigWords(en);
        if (eWords.length > 0) {
          const overlap = eWords.filter(w => sWords.has(w)).length;
          if (overlap / Math.max(sWords.size, eWords.length) >= 0.75) confidence = "fuzzy";
        }
      }

      // Skip confidence levels disabled in settings
      if (confidence === "exact"   && !settings.matchExact)   confidence = null;
      if (confidence === "partial" && !settings.matchPartial) confidence = null;
      if (confidence === "fuzzy"   && !settings.matchFuzzy)   confidence = null;

      if (confidence && (!best || RANK[confidence] > RANK[best.confidence] ||
          (confidence === best.confidence && en.length > normalize(best.epicTitle).length))) {
        best = { match: true, epicTitle: et, confidence };
        if (confidence === "exact") break;
      }
    }

    return best || { match: false };
  }

  // ── Get current Steam game title ──────────────────────────────────────────
  function getSteamTitle() {
    return (
      document.querySelector("#appHubAppName")?.innerText?.trim() ||
      document.querySelector(".apphub_AppName")?.innerText?.trim() ||
      document.querySelector('[itemprop="name"]')?.innerText?.trim() ||
      document.title?.replace("on Steam", "").replace("Save ", "").trim()
    );
  }

  // ── Inject the "You own this" badge ───────────────────────────────────────
  function injectBadge(appId, steamTitle, matchedTitle, matchedSource, confidence, strings) {
    if (document.getElementById("els-epic-badge")) return;

    const buyArea =
      document.querySelector(".game_purchase_action") ||
      document.querySelector(".game_area_purchase_game") ||
      document.querySelector("#game_area_purchase") ||
      document.querySelector(".leftcol");

    if (!buyArea) return;

    const badge = document.createElement("div");
    badge.id = "els-epic-badge";

    // Show the real source: Epic-branded for "epic", neutral "in your library"
    // for "other" (and any future source) instead of mislabeling it as Epic.
    const isEpic = matchedSource === "epic";
    const titleKey = isEpic ? "badge_own_epic" : "badge_own_library";
    const accent   = isEpic ? "#0078f2" : "#6e7681";
    const glow     = isEpic ? "rgba(0,120,242,.25)" : "rgba(0,0,0,.3)";
    const logoHtml = isEpic
      ? `<svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M16 2C8.268 2 2 8.268 2 16s6.268 14 14 14 14-6.268 14-14S23.732 2 16 2z" fill="#0078f2"/>
            <path d="M10 11h12v2.5H13v2h8v2.5h-8v2H22V22.5H10V11z" fill="white"/>
          </svg>`
      : `<div style="font-size:24px;line-height:1;">🎮</div>`;

    const confidenceKey = confidence === "exact" ? "badge_exact" : confidence === "partial" ? "badge_partial" : "badge_fuzzy";
    const confidenceLabel = tr(strings, confidenceKey);
    const confidenceColor = confidence === "exact" ? "#00c853" : confidence === "partial" ? "#00b0ff" : "#ff9800";

    badge.innerHTML = `
      <div id="els-badge-inner">
        <div id="els-badge-logo">${logoHtml}</div>
        <div id="els-badge-text">
          <span id="els-badge-title">${escHtml(tr(strings, titleKey))}</span>
          <span id="els-badge-sub">"${escHtml(matchedTitle)}" · <span style="color:${confidenceColor}">${escHtml(confidenceLabel)}</span></span>
        </div>
        <div id="els-badge-close" title="${escHtml(tr(strings, "badge_dismiss"))}">✕</div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #els-epic-badge { margin:12px 0; padding:0; font-family:'Motiva Sans',Arial,sans-serif; animation:elsBadgeIn .4s cubic-bezier(.175,.885,.32,1.275) both; }
      @keyframes elsBadgeIn { from{opacity:0;transform:scale(.92) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
      #els-badge-inner { display:flex; align-items:center; gap:12px; background:linear-gradient(135deg,#0d1b2a,#1a2d45); border:1px solid ${accent}; border-left:4px solid ${accent}; border-radius:8px; padding:12px 16px; box-shadow:0 2px 16px ${glow},inset 0 1px 0 rgba(255,255,255,.05); position:relative; }
      #els-badge-logo { flex-shrink:0; filter:drop-shadow(0 0 6px ${glow}); }
      #els-badge-text { flex:1; display:flex; flex-direction:column; gap:3px; }
      #els-badge-title { color:#fff; font-size:14px; font-weight:700; letter-spacing:.01em; }
      #els-badge-sub { color:#8ba3be; font-size:11px; }
      #els-badge-close { color:#4a6580; font-size:12px; cursor:pointer; padding:4px; border-radius:4px; flex-shrink:0; transition:color .2s,background .2s; line-height:1; }
      #els-badge-close:hover { color:#fff; background:rgba(255,255,255,.1); }
    `;
    document.head.appendChild(style);

    badge.querySelector("#els-badge-close").addEventListener("click", () => {
      if (appId) {
        chrome.storage.local.get(DISMISSED_KEY, (r) => {
          const list = r[DISMISSED_KEY] || [];
          if (!list.some(d => (d.pageId ?? d.appId) === appId && (d.matchedTitle ?? d.epicTitle) === matchedTitle)) {
            list.push({ pageId: appId, pageStore: "steam", pageTitle: steamTitle, matchedTitle });
            chrome.storage.local.set({ [DISMISSED_KEY]: list });
          }
        });
      }
      badge.style.transition = "opacity .3s,transform .3s";
      badge.style.opacity = "0";
      badge.style.transform = "scale(.95)";
      setTimeout(() => badge.remove(), 300);
    });

    buyArea.insertAdjacentElement("beforebegin", badge);
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const appId = location.pathname.match(/\/app\/(\d+)/)?.[1] || null;

    const stored = await new Promise(r => chrome.storage.local.get([SETTINGS_KEY, LIBRARY_KEY, DISMISSED_KEY], r));
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
    const strings  = await loadLocale(settings.uiLocale);

    const library = stored[LIBRARY_KEY] || [];
    const entries = library.filter(g => g.source === "epic" || g.source === "other");
    if (entries.length === 0) return;

    const dismissed = stored[DISMISSED_KEY] || [];
    const dismissedTitles = new Set(
      dismissed.filter(d => (d.pageId ?? d.appId) === appId).map(d => d.matchedTitle ?? d.epicTitle)
    );
    const candidates = entries.filter(g => !dismissedTitles.has(g.title));
    if (candidates.length === 0) return;

    const steamTitle = getSteamTitle();
    if (!steamTitle) return;

    const { match, epicTitle, confidence } = isMatch(steamTitle, candidates.map(g => g.title), settings);
    if (match) {
      const matchedSource = candidates.find(g => g.title === epicTitle)?.source || "other";
      injectBadge(appId, steamTitle, epicTitle, matchedSource, confidence, strings);
    }
  }

  if (document.readyState === "complete") {
    run();
  } else {
    window.addEventListener("load", run);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "refreshSteamCheck") run();
  });
})();
