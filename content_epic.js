// content_epic.js v1.6.0
// Runs on epicgames.com pages.
// Its ONLY job: extract auth tokens/account ID from the page and send to background.
// All network calls happen in background.js (no CORS there).

(function () {
  "use strict";

  const LIBRARY_KEY     = "elsLibrary";
  const DISMISSED_KEY   = "epicDismissedMatches";
  const SETTINGS_KEY    = "elsSettings";

  const DEFAULT_SETTINGS = {
    matchExact: true, matchPartial: true, matchFuzzy: true,
    uiLocale: "en-US", showToasts: true,
  };

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

  // ── Extract auth token from page context ──────────────────────────────────
  function extractAuth() {
    const result = { authToken: null, accountId: null, source: [] };

    function scanStorage(storage, label) {
      try {
        const keys = Object.keys(storage);
        for (const key of keys) {
          try {
            const val = storage.getItem(key);
            if (!val) continue;
            if (val.startsWith("EG1~") && !result.authToken) {
              result.authToken = val;
              result.source.push(`${label} EG1:${key}`);
              continue;
            }
            if ((key.toLowerCase().includes("token") || key.toLowerCase().includes("auth") || key.toLowerCase().includes("bearer")) && val.length > 50) {
              result.authToken = result.authToken || val;
              result.source.push(`${label}:${key}`);
            }
            if ((key.toLowerCase().includes("account") || key.toLowerCase().includes("user")) && val.length === 32) {
              result.accountId = result.accountId || val;
              result.source.push(`accountId from ${label}:${key}`);
            }
            if (val.startsWith("{")) {
              const obj = JSON.parse(val);
              if (obj.access_token && !result.authToken) { result.authToken = obj.access_token; result.source.push(`JSON ${label}:${key}.access_token`); }
              if (obj.token && !result.authToken) { result.authToken = obj.token; result.source.push(`JSON ${label}:${key}.token`); }
              if (obj.accountId && !result.accountId) { result.accountId = obj.accountId; result.source.push(`JSON ${label}:${key}.accountId`); }
              if (obj.id && !result.accountId && typeof obj.id === "string" && obj.id.length === 32) { result.accountId = obj.id; }
            }
          } catch (e) { /* ignore parse errors */ }
        }
      } catch (e) { /* storage may be unavailable */ }
    }

    scanStorage(localStorage, "localStorage");
    scanStorage(sessionStorage, "sessionStorage");

    try {
      const w = window;
      if (w.__epic_auth?.access_token) { result.authToken = result.authToken || w.__epic_auth.access_token; result.source.push("window.__epic_auth"); }
      if (w.EpicGames?.user?.accessToken) { result.authToken = result.authToken || w.EpicGames.user.accessToken; result.source.push("window.EpicGames.user"); }
      if (w.__REDUX_STATE__?.auth?.accessToken) { result.authToken = result.authToken || w.__REDUX_STATE__.auth.accessToken; result.source.push("window.__REDUX_STATE__"); }
      if (w.__store__) {
        const state = w.__store__.getState?.();
        if (state?.auth?.accessToken) { result.authToken = result.authToken || state.auth.accessToken; result.source.push("Redux store"); }
        if (state?.user?.accountId) { result.accountId = result.accountId || state.user.accountId; }
      }
      if (w.__NEXT_DATA__) {
        const nd = w.__NEXT_DATA__;
        const token = nd?.props?.pageProps?.accessToken ||
                      nd?.props?.pageProps?.authToken ||
                      nd?.props?.initialState?.auth?.accessToken;
        if (token && !result.authToken) { result.authToken = token; result.source.push("window.__NEXT_DATA__"); }
        const acctId = nd?.props?.pageProps?.accountId || nd?.props?.pageProps?.userId;
        if (acctId && !result.accountId) { result.accountId = acctId; }
      }
    } catch (e) { /* ignore */ }

    try {
      const cookies = document.cookie.split(";").map(c => c.trim());
      for (const c of cookies) {
        const [name, ...rest] = c.split("=");
        const val = rest.join("=");
        if (val.startsWith("EG1~") && !result.authToken) {
          result.authToken = val;
          result.source.push(`js-cookie EG1:${name}`);
        } else if ((name.toUpperCase().includes("TOKEN") || name.toUpperCase().includes("BEARER")) && val.length > 20) {
          result.authToken = result.authToken || val;
          result.source.push(`js-cookie:${name}`);
        }
      }
    } catch (e) { /* ignore */ }

    return result;
  }

  // ── Listen for scan trigger from popup ────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scanEpicLibrary") {
      const auth = extractAuth();
      chrome.runtime.sendMessage(
        { action: "doScan", authToken: auth.authToken, accountId: auth.accountId },
        (response) => { sendResponse(response); }
      );
      return true; // async
    }
  });

  console.log("[AO] v1.6.0 content script ready on", location.hostname);

  // ── Badge on Epic store game pages ────────────────────────────────────────
  const ELS_DISMISSED_KEY = "epicDismissedMatches";

  function elsNormalize(title) {
    return title.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }
  function elsSigWords(s) { return s.split(" ").filter(w => w.length > 2 || /^\d+$/.test(w)); }

  function elsIsMatch(pageTitle, libraryTitles, settings) {
    const sn = elsNormalize(pageTitle);
    const sWords = new Set(elsSigWords(sn));
    const RANK = { exact: 3, partial: 2, fuzzy: 1 };
    let best = null;
    for (const lt of libraryTitles) {
      const en = elsNormalize(lt);
      let confidence = null;
      if (sn === en) { confidence = "exact"; }
      else if (sn.includes(en) || en.includes(sn)) { confidence = "partial"; }
      else {
        const eWords = elsSigWords(en);
        if (eWords.length > 0) {
          const overlap = eWords.filter(w => sWords.has(w)).length;
          if (overlap / Math.max(sWords.size, eWords.length) >= 0.75) confidence = "fuzzy";
        }
      }
      // Filter by settings
      if (confidence === "exact"   && !settings.matchExact)   confidence = null;
      if (confidence === "partial" && !settings.matchPartial) confidence = null;
      if (confidence === "fuzzy"   && !settings.matchFuzzy)   confidence = null;

      if (confidence && (!best || RANK[confidence] > RANK[best.confidence] ||
          (confidence === best.confidence && en.length > elsNormalize(best.matchedTitle).length))) {
        best = { match: true, matchedTitle: lt, confidence };
        if (confidence === "exact") break;
      }
    }
    return best || { match: false };
  }

  function getEpicGameTitle() {
    return (
      document.querySelector('[data-component="PDPTitleHeader"] h1')?.innerText?.trim() ||
      document.querySelector('h1[data-testid="title"]')?.innerText?.trim() ||
      document.querySelector('.css-1gty6cv h1')?.innerText?.trim() ||
      document.querySelector('h1')?.innerText?.trim() ||
      document.title?.split(" - ")[0]?.trim()
    );
  }

  function getEpicSlug() {
    return location.pathname.match(/\/p\/([^/?#]+)/i)?.[1]?.toLowerCase() || null;
  }

  function injectEpicBadge(slug, pageTitle, matchedTitle, matchedSource, confidence, strings) {
    if (document.getElementById("els-epic-badge")) return;

    const buyArea =
      document.querySelector('[data-component="OfferDetail"]') ||
      document.querySelector('[data-testid="purchase-cta-section"]') ||
      document.querySelector('aside') ||
      document.querySelector('.css-1myjdqe');
    if (!buyArea) return;

    const sourceKey   = matchedSource === "steam" ? "badge_own_steam" : "badge_own_library";
    const sourceLabel = matchedSource === "steam" ? "Steam" : tr(strings, "badge_own_library").replace("!", "").replace(/^.+on /, "");
    const sourceColor = matchedSource === "steam" ? "#67c1f5" : "#6e7681";
    const confKey     = confidence === "exact" ? "badge_exact" : confidence === "partial" ? "badge_partial" : "badge_fuzzy";
    const confidenceLabel = tr(strings, confKey);
    const confidenceColor = confidence === "exact" ? "#00c853" : confidence === "partial" ? "#00b0ff" : "#ff9800";

    const titleText = tr(strings, sourceKey);

    const badge = document.createElement("div");
    badge.id = "els-epic-badge";
    badge.innerHTML = `
      <div id="els-epic-badge-inner">
        <div id="els-epic-badge-icon">🎮</div>
        <div id="els-epic-badge-text">
          <span id="els-epic-badge-title" style="color:${sourceColor}">${titleText}</span>
          <span id="els-epic-badge-sub">"${matchedTitle.replace(/"/g, "&quot;")}" · <span style="color:${confidenceColor}">${confidenceLabel}</span></span>
        </div>
        <div id="els-epic-badge-close" title="${tr(strings, "badge_dismiss")}">✕</div>
      </div>`;

    const style = document.createElement("style");
    style.textContent = `
      #els-epic-badge { margin:12px 0; animation:elsBadgeIn2 .4s cubic-bezier(.175,.885,.32,1.275) both; }
      @keyframes elsBadgeIn2 { from{opacity:0;transform:scale(.92) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
      #els-epic-badge-inner { display:flex; align-items:center; gap:12px; background:linear-gradient(135deg,#0d1b2a,#1a2d45); border:1px solid #30363d; border-left:4px solid ${sourceColor}; border-radius:8px; padding:12px 16px; box-shadow:0 2px 16px rgba(0,0,0,.3); }
      #els-epic-badge-icon { font-size:24px; flex-shrink:0; }
      #els-epic-badge-text { flex:1; display:flex; flex-direction:column; gap:3px; }
      #els-epic-badge-title { font-size:14px; font-weight:700; font-family:'Segoe UI',sans-serif; }
      #els-epic-badge-sub { color:#8ba3be; font-size:11px; font-family:'Segoe UI',sans-serif; }
      #els-epic-badge-close { color:#4a6580; font-size:12px; cursor:pointer; padding:4px; border-radius:4px; flex-shrink:0; transition:color .2s,background .2s; line-height:1; }
      #els-epic-badge-close:hover { color:#fff; background:rgba(255,255,255,.1); }`;
    document.head.appendChild(style);

    badge.querySelector("#els-epic-badge-close").addEventListener("click", () => {
      if (slug) {
        chrome.storage.local.get(ELS_DISMISSED_KEY, (r) => {
          const list = r[ELS_DISMISSED_KEY] || [];
          if (!list.some(d => d.pageId === slug && d.matchedTitle === matchedTitle)) {
            list.push({ pageId: slug, pageStore: "epic", pageTitle: pageTitle, matchedTitle });
            chrome.storage.local.set({ [ELS_DISMISSED_KEY]: list });
          }
        });
      }
      badge.style.transition = "opacity .3s,transform .3s";
      badge.style.opacity = "0"; badge.style.transform = "scale(.95)";
      setTimeout(() => badge.remove(), 300);
    });

    const ctaBtn = buyArea.querySelector('[data-testid="purchase-cta-button"]');
    if (ctaBtn) {
      const sidebarContent = buyArea.firstElementChild ?? buyArea;
      let ctaBlock = ctaBtn.parentElement;
      while (ctaBlock && ctaBlock.parentElement !== sidebarContent) {
        ctaBlock = ctaBlock.parentElement;
      }
      if (ctaBlock) {
        const anchor = ctaBlock.previousElementSibling ?? ctaBlock;
        anchor.insertAdjacentElement("beforebegin", badge);
      } else {
        sidebarContent.insertAdjacentElement("afterbegin", badge);
      }
    } else {
      (buyArea.firstElementChild ?? buyArea).insertAdjacentElement("afterbegin", badge);
    }
  }

  async function runEpicBadge() {
    if (!/\/p\//i.test(location.pathname)) return;
    const slug = getEpicSlug();

    const stored = await new Promise(r => chrome.storage.local.get([SETTINGS_KEY, LIBRARY_KEY, ELS_DISMISSED_KEY], r));
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
    const strings  = await loadLocale(settings.uiLocale);

    const library = stored[LIBRARY_KEY] || [];
    const entries = library.filter(g => g.source === "steam" || g.source === "other");
    if (entries.length === 0) return;

    const dismissed = stored[ELS_DISMISSED_KEY] || [];
    const dismissedTitles = new Set(
      dismissed.filter(d => d.pageId === slug && d.pageStore === "epic").map(d => d.matchedTitle)
    );
    const candidates = entries.filter(g => !dismissedTitles.has(g.title));
    if (candidates.length === 0) return;

    const pageTitle = getEpicGameTitle();
    if (!pageTitle) return;

    const { match, matchedTitle, confidence } = elsIsMatch(pageTitle, candidates.map(g => g.title), settings);
    if (match) {
      const matchedSource = candidates.find(g => g.title === matchedTitle)?.source || "other";
      injectEpicBadge(slug, pageTitle, matchedTitle, matchedSource, confidence, strings);
    }
  }

  if (document.readyState === "complete") { runEpicBadge(); }
  else { window.addEventListener("load", runEpicBadge); }
})();
