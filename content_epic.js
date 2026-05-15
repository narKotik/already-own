// content_epic.js v1.4.1
// Runs on epicgames.com pages.
// Its ONLY job: extract auth tokens/account ID from the page and send to background.
// All network calls happen in background.js (no CORS there).

(function () {
  "use strict";

  // ── Extract auth token from page context ──────────────────────────────────
  // Epic stores auth in Redux state, window globals, localStorage, or sessionStorage.
  function extractAuth() {
    const result = { authToken: null, accountId: null, source: [] };

    function scanStorage(storage, label) {
      try {
        const keys = Object.keys(storage);
        for (const key of keys) {
          try {
            const val = storage.getItem(key);
            if (!val) continue;
            // Epic's current EG1 token format
            if (val.startsWith("EG1~") && !result.authToken) {
              result.authToken = val;
              result.source.push(`${label} EG1:${key}`);
              continue;
            }
            // Raw token strings by key name — require >50 chars to skip expiry timestamps and other short date/flag values
            if ((key.toLowerCase().includes("token") || key.toLowerCase().includes("auth") || key.toLowerCase().includes("bearer")) && val.length > 50) {
              result.authToken = result.authToken || val;
              result.source.push(`${label}:${key}`);
            }
            // Account ID
            if ((key.toLowerCase().includes("account") || key.toLowerCase().includes("user")) && val.length === 32) {
              result.accountId = result.accountId || val;
              result.source.push(`accountId from ${label}:${key}`);
            }
            // Try JSON
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

    // 1. Check localStorage and sessionStorage
    scanStorage(localStorage, "localStorage");
    scanStorage(sessionStorage, "sessionStorage");

    // 2. Check window globals Epic might set
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
      // Next.js apps expose initial server-side props here
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

    // 3. Check cookies accessible from JS (httpOnly ones are not, background gets those)
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

  // ── Show toast ────────────────────────────────────────────────────────────
  function showToast(message, color = "#4CAF50") {
    document.getElementById("els-toast")?.remove();
    const s = document.createElement("style");
    s.textContent = `@keyframes elsFadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
    const t = document.createElement("div");
    t.id = "els-toast";
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:${color};color:#fff;font-family:'Segoe UI',sans-serif;font-size:13px;font-weight:600;padding:12px 18px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.4);z-index:999999;display:flex;align-items:center;gap:8px;animation:elsFadeIn .3s ease;max-width:340px;`;
    t.innerHTML = `<span style="font-size:18px">🎮</span><span>${message}</span>`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // ── Listen for scan trigger from popup ────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scanEpicLibrary") {
      const auth = extractAuth();

      // Forward to background service worker which can make cross-origin requests
      chrome.runtime.sendMessage(
        { action: "doScan", authToken: auth.authToken, accountId: auth.accountId },
        (response) => {
          sendResponse(response);
          if (response?.success) {
            showToast(
              response.games?.length === 0
                ? "⚠️ Scan ran but found 0 games"
                : `✅ ${response.total} games saved via ${response.method}`,
              response.games?.length === 0 ? "#e67e22" : "#4CAF50"
            );
          } else {
            showToast("❌ Scan failed — check Logs tab", "#e74c3c");
          }
        }
      );
      return true; // async
    }
  });

  console.log("[AO] v1.4.1 content script ready on", location.hostname);

  // ── Badge on Epic store game pages ────────────────────────────────────────
  // Shows when you own the game on Steam or Other (so you don't double-buy on Epic)
  const ELS_LIBRARY_KEY   = "elsLibrary";
  const ELS_DISMISSED_KEY = "epicDismissedMatches";

  function elsNormalize(title) {
    return title.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }
  function elsSigWords(s) { return s.split(" ").filter(w => w.length > 2 || /^\d+$/.test(w)); }
  function elsIsMatch(pageTitle, libraryTitles) {
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

  function injectEpicBadge(slug, pageTitle, matchedTitle, matchedSource, confidence) {
    if (document.getElementById("els-epic-badge")) return;

    // Prefer a narrow element inside the purchase panel so the badge sits flush
    // above the price/CTA row rather than floating above the whole sidebar.
    const buyArea =
      document.querySelector('[data-component="OfferDetail"]') ||
      document.querySelector('[data-testid="purchase-cta-section"]') ||
      document.querySelector('aside') ||
      document.querySelector('.css-1myjdqe');
    if (!buyArea) return;

    const sourceLabel = matchedSource === "steam" ? "Steam" : "your library";
    const sourceColor = matchedSource === "steam" ? "#67c1f5" : "#6e7681";
    const confidenceLabel = confidence === "exact" ? "Exact match" : confidence === "partial" ? "Title match" : "Likely match";
    const confidenceColor = confidence === "exact" ? "#00c853" : confidence === "partial" ? "#00b0ff" : "#ff9800";

    const badge = document.createElement("div");
    badge.id = "els-epic-badge";
    badge.innerHTML = `
      <div id="els-epic-badge-inner">
        <div id="els-epic-badge-icon">🎮</div>
        <div id="els-epic-badge-text">
          <span id="els-epic-badge-title">You already own this on <span style="color:${sourceColor}">${sourceLabel}</span>!</span>
          <span id="els-epic-badge-sub">"${matchedTitle.replace(/"/g, "&quot;")}" · <span style="color:${confidenceColor}">${confidenceLabel}</span></span>
        </div>
        <div id="els-epic-badge-close" title="Dismiss">✕</div>
      </div>`;

    const style = document.createElement("style");
    style.textContent = `
      #els-epic-badge { margin:12px 0; animation:elsBadgeIn2 .4s cubic-bezier(.175,.885,.32,1.275) both; }
      @keyframes elsBadgeIn2 { from{opacity:0;transform:scale(.92) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
      #els-epic-badge-inner { display:flex; align-items:center; gap:12px; background:linear-gradient(135deg,#0d1b2a,#1a2d45);
        border:1px solid #30363d; border-left:4px solid ${sourceColor}; border-radius:8px; padding:12px 16px;
        box-shadow:0 2px 16px rgba(0,0,0,.3); }
      #els-epic-badge-icon { font-size:24px; flex-shrink:0; }
      #els-epic-badge-text { flex:1; display:flex; flex-direction:column; gap:3px; }
      #els-epic-badge-title { color:#fff; font-size:14px; font-weight:700; font-family:'Segoe UI',sans-serif; }
      #els-epic-badge-sub { color:#8ba3be; font-size:11px; font-family:'Segoe UI',sans-serif; }
      #els-epic-badge-close { color:#4a6580; font-size:12px; cursor:pointer; padding:4px; border-radius:4px;
        flex-shrink:0; transition:color .2s,background .2s; line-height:1; }
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

    // "afterbegin" inserts as first child *inside* the panel, so the badge
    // stays adjacent to the price/buy button instead of floating above the sidebar.
    // The aside has a single content wrapper as its first child; all price/CTA elements
    // live inside that wrapper. Walk up from the buy button to find which direct child
    // of that wrapper is the CTA block, then insert before the price row above it.
    const ctaBtn = buyArea.querySelector('[data-testid="purchase-cta-button"]');
    if (ctaBtn) {
      const sidebarContent = buyArea.firstElementChild ?? buyArea;
      let ctaBlock = ctaBtn.parentElement;
      while (ctaBlock && ctaBlock.parentElement !== sidebarContent) {
        ctaBlock = ctaBlock.parentElement;
      }
      if (ctaBlock) {
        // previousElementSibling is the price row — badge lands right above price+CTA
        const anchor = ctaBlock.previousElementSibling ?? ctaBlock;
        anchor.insertAdjacentElement("beforebegin", badge);
      } else {
        sidebarContent.insertAdjacentElement("afterbegin", badge);
      }
    } else {
      (buyArea.firstElementChild ?? buyArea).insertAdjacentElement("afterbegin", badge);
    }
  }

  function runEpicBadge() {
    if (!/\/p\//i.test(location.pathname)) return; // only on game pages
    const slug = getEpicSlug();
    chrome.storage.local.get([ELS_LIBRARY_KEY, ELS_DISMISSED_KEY], (result) => {
      const library = result[ELS_LIBRARY_KEY] || [];
      // On Epic pages show badge only for steam + other sources
      const entries = library.filter(g => g.source === "steam" || g.source === "other");
      if (entries.length === 0) return;

      const dismissed = result[ELS_DISMISSED_KEY] || [];
      const dismissedTitles = new Set(
        dismissed.filter(d => d.pageId === slug && d.pageStore === "epic").map(d => d.matchedTitle)
      );
      const candidates = entries.filter(g => !dismissedTitles.has(g.title));
      if (candidates.length === 0) return;

      const pageTitle = getEpicGameTitle();
      if (!pageTitle) return;

      const { match, matchedTitle, confidence } = elsIsMatch(pageTitle, candidates.map(g => g.title));
      if (match) {
        const matchedSource = candidates.find(g => g.title === matchedTitle)?.source || "other";
        injectEpicBadge(slug, pageTitle, matchedTitle, matchedSource, confidence);
      }
    });
  }

  if (document.readyState === "complete") { runEpicBadge(); }
  else { window.addEventListener("load", runEpicBadge); }
})();
