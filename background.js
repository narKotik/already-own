// background.js v1.4.1
// ALL network requests happen here — service workers are not subject to CORS.
// The content script just grabs auth tokens from the page and sends them here.

const LIBRARY_KEY = "elsLibrary";   // [{title, source}]  source: "epic"|"steam"|"other"
const IGNORE_KEY  = "elsIgnoredGames"; // [{title, source}]
const VERSION = "1.4.1";
let DEBUG = false; // set true (or via Debug logs checkbox in popup) to enable full title-list dumps

// ── Logger ────────────────────────────────────────────────────────────────
const logs = [];
function log(level, msg, data) {
  const entry = {
    time: new Date().toISOString().slice(11, 23),
    level,
    msg,
    data: data !== undefined ? String(JSON.stringify(data)).slice(0, 400) : undefined,
  };
  logs.push(entry);
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  data !== undefined ? fn(`[ELS BG ${level.toUpperCase()}]`, msg, data) : fn(`[ELS BG ${level.toUpperCase()}]`, msg);
}
const info  = (m, d) => log("info",  m, d);
const warn  = (m, d) => log("warn",  m, d);
const error = (m, d) => log("error", m, d);
// logDump: full-data dump for diagnosis — only runs when DEBUG = true
function logDump(msg, data) {
  if (!DEBUG) return;
  logs.push({ time: new Date().toISOString().slice(11, 23), level: "info", msg, data: JSON.stringify(data) });
}

// ── Get Epic auth token from cookies via chrome.cookies API ───────────────
async function getEpicAuthFromCookies() {
  info("Reading Epic cookies via chrome.cookies API");
  const cookieDomains = [
    { url: "https://store.epicgames.com", name: "EPIC_BEARER_TOKEN" },
    { url: "https://www.epicgames.com",   name: "EPIC_BEARER_TOKEN" },
    { url: "https://store.epicgames.com", name: "EPIC_EG1" },
    { url: "https://www.epicgames.com",   name: "EPIC_EG1" },
    { url: "https://store.epicgames.com", name: "EPIC_SSO_TOKEN" },
    { url: "https://www.epicgames.com",   name: "EPIC_SSO_TOKEN" },
    { url: "https://store.epicgames.com", name: "EPIC_EOS_TOKEN" },
    { url: "https://store.epicgames.com", name: "epic_access_token" },
    { url: "https://www.epicgames.com",   name: "epic_access_token" },
  ];

  // Real auth tokens are either EG1~<base64> or a raw JWT (header.payload.sig, each segment
  // substantial base64url). Tracking/session/analytics cookies won't match either pattern.
  const looksLikeToken = v => {
    if (!v) return false;
    if (v.toLowerCase().startsWith("eg1~")) return true;
    return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}$/.test(v);
  };

  for (const { url, name } of cookieDomains) {
    try {
      const cookie = await chrome.cookies.get({ url, name });
      if (looksLikeToken(cookie?.value)) {
        info(`Found auth cookie: ${name} (${cookie.value.length} chars)`);
        return cookie.value;
      } else if (cookie?.value) {
        info(`Skipping non-token cookie: ${name} (${cookie.value.length} chars)`);
      }
    } catch (e) {
      warn(`Cookie read failed for ${name}`, e.message);
    }
  }

  try {
    const all = await chrome.cookies.getAll({ domain: ".epicgames.com" });
    const tokenCookie = all.find(c =>
      !c.name.startsWith("_") &&
      !c.name.toUpperCase().includes("REFRESH") &&
      looksLikeToken(c.value)
    );
    if (tokenCookie) {
      info(`Found token in cookie: ${tokenCookie.name} (${tokenCookie.value.length} chars)`);
      return tokenCookie.value;
    }
    const refreshOnly = all.find(c => c.name.toUpperCase().includes("REFRESH") && looksLikeToken(c.value));
    if (refreshOnly) {
      info(`Only a refresh token found (${refreshOnly.name}) — session expired. Open store.epicgames.com in Chrome while signed in, then retry.`);
    } else {
      info(`No valid auth token found in cookies. Sign in at store.epicgames.com in Chrome.`);
    }
  } catch (e) {
    warn("Could not list cookies", e.message);
  }

  return null;
}

// ── Save games ────────────────────────────────────────────────────────────
const normKey     = t => t.replace(/[™®©]/g, "").toLowerCase().trim();
const preferRicher = (a, b) => (/[™®©]/.test(b) && !/[™®©]/.test(a)) ? b : a;

// titles: string[]   source: "epic" | "steam" | "other"
async function saveGames(titles, source) {
  const result = await chrome.storage.local.get([LIBRARY_KEY, IGNORE_KEY]);
  const existing = result[LIBRARY_KEY] || [];
  // Ignore is title-only (source-agnostic): an ignored title is skipped from all sources
  const ignored  = new Set((result[IGNORE_KEY] || []).map(g => normKey(g.title ?? g)));

  // Build dedup map: "normtitle:source" → {title, source}  (also fixes pre-existing dupes)
  const titleMap = new Map();
  for (const g of existing) {
    const k = normKey(g.title) + ":" + g.source;
    if (!ignored.has(normKey(g.title)))
      titleMap.set(k, titleMap.has(k) ? { ...g, title: preferRicher(titleMap.get(k).title, g.title) } : g);
  }

  let added = 0;
  for (const title of titles) {
    if (ignored.has(normKey(title))) continue;
    const k = normKey(title) + ":" + source;
    if (!titleMap.has(k)) { titleMap.set(k, { title, source }); added++; }
    else titleMap.set(k, { source, title: preferRicher(titleMap.get(k).title, title) });
  }

  const merged = [...titleMap.values()];
  const scanKey = source === "steam" ? "steamLastScan" : "epicLastScan";
  await chrome.storage.local.set({ [LIBRARY_KEY]: merged, [scanKey]: Date.now() });
  return { total: merged.filter(g => g.source === source).length, added };
}

// ── Get Steam ID from steamLoginSecure cookie ─────────────────────────────
async function getSteamIdFromCookie() {
  const urls = [
    "https://store.steampowered.com",
    "https://steamcommunity.com",
  ];
  for (const url of urls) {
    try {
      const cookie = await chrome.cookies.get({ url, name: "steamLoginSecure" });
      if (cookie?.value) {
        const steamId = decodeURIComponent(cookie.value).split("||")[0];
        if (/^\d{17}$/.test(steamId)) return steamId;
      }
    } catch (e) { warn(`Could not read Steam cookie from ${url}`, e.message); }
  }
  return null;
}

// ── Shared request headers ────────────────────────────────────────────────
const BASE_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://store.epicgames.com/",
  "Origin": "https://store.epicgames.com",
};

function authHeaders(authToken) {
  const h = { ...BASE_HEADERS };
  if (authToken) h["Authorization"] = `Bearer ${authToken}`;
  return h;
}

// ── Method 1: GraphQL (with Authorization header from cookie) ─────────────
async function fetchViaGraphQL(authToken) {
  // graphql.epicgames.com/graphql is decommissioned (404). Current endpoint is the store BFF.
  const GQL_URL = "https://store.epicgames.com/graphql";
  info("Method 1: GraphQL", GQL_URL);

  if (!authToken) {
    info("No auth token — attempting unauthenticated (will likely fail with 401)");
  } else {
    info("Using Bearer token", `present (${authToken.length} chars)`);
  }

  const headers = { ...authHeaders(authToken), "Content-Type": "application/json" };

  // Query namespace + catalogItemId (title was removed from OfferEntitlements schema).
  // Resolve real game names via catalog API using the same mechanism as Library Service.
  const queries = [
    {
      name: "GetMyEntitlements",
      body: JSON.stringify({
        query: `{
          Launcher {
            entitledOfferItems {
              namespace
              catalogItemId
            }
          }
        }`,
      }),
      extract: async (json) => {
        const items = json?.data?.Launcher?.entitledOfferItems;
        if (!items?.length) return null;
        info("GraphQL OfferEntitlements count", items.length);
        const titles = await fetchCatalogTitles(items, authToken, "graphql");
        return titles.length ? titles : null;
      },
    },
  ];

  for (const q of queries) {
    info(`GraphQL query: ${q.name}`);
    const resp = await fetch(GQL_URL, { method: "POST", headers, body: q.body, credentials: "include" });
    info(`GraphQL HTTP status (${q.name})`, resp.status);
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`HTTP ${resp.status}: Not authenticated — ensure you are logged in to the Epic Store`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      info(`GraphQL non-ok (${q.name}), trying next`, text.slice(0, 200));
      continue;
    }
    const json = await resp.json();
    if (json.errors) {
      info(`GraphQL errors (${q.name})`, json.errors.map(e => e.message).join("; "));
      continue;
    }
    const titles = await q.extract(json);
    if (titles === null) {
      info(`GraphQL unexpected shape (${q.name})`, json?.data);
      continue;
    }
    info(`GraphQL OK via ${q.name} — ${titles.length} titles`);
    return titles;
  }
  throw new Error("All GraphQL queries returned no data");
}

// ── Method 2: Account assets API ─────────────────────────────────────────
async function fetchViaAssetsAPI(authToken) {
  const URL = "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live";
  info("Method 2: Assets API", URL);

  const resp = await fetch(URL, { headers: authHeaders(authToken) });
  info(`Assets API HTTP status`, resp.status);
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`HTTP ${resp.status}: Not authenticated — this endpoint requires a launcher token`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!Array.isArray(json)) throw new Error(`Expected array, got ${typeof json}`);
  const names = json.map(a => a.appName).filter(Boolean);
  info(`Assets API OK — ${names.length} entries`);
  return names;
}

// ── Method 3: Library service API ────────────────────────────────────────
async function fetchViaLibraryAPI(authToken) {
  const BASE = "https://library-service.live.use1a.on.epicgames.com/library/api/public/items";
  info("Method 3: Library Service API", BASE);

  const allRecords = [];
  let cursor = null;
  let page = 0;

  while (true) {
    const url = new URL(BASE);
    url.searchParams.set("includeMetadata", "true");
    url.searchParams.set("pageSize", "1000"); // request max per page; API will cap at its own limit
    if (cursor) url.searchParams.set("cursor", cursor);
    else if (page > 0) url.searchParams.set("start", allRecords.length); // offset fallback

    const resp = await fetch(url.toString(), { headers: authHeaders(authToken) });
    info(`Library API HTTP status (page ${page})`, resp.status);
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`HTTP ${resp.status}: Not authenticated`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = await resp.json();
    const meta = json?.responseMetadata;
    if (page === 0) info("Library API responseMetadata", meta);

    const records = json?.records || json?.data || (Array.isArray(json) ? json : null);
    if (!records) throw new Error("Unexpected shape");

    info(`Library API page ${page}: ${records.length} records (total so far: ${allRecords.length + records.length})`);
    allRecords.push(...records);

    if (records.length === 0) break;

    // Cursor-based: keep going if a next cursor exists under any known field name
    cursor = meta?.nextCursor || meta?.cursor || meta?.nextToken || null;
    if (cursor) { page++; continue; }

    // Offset-based: keep going if total count says there's more
    const total = meta?.total ?? meta?.totalCount ?? null;
    if (total !== null && allRecords.length < total) { page++; continue; }

    // Last resort: if the page was full we might be mid-stream; stop if it looks partial
    if (records.length < 100) break;

    // Got a full page with no cursor and no total — try one more in case API is paginating silently
    page++;
    if (page > 100) { warn("Library API pagination safety limit reached"); break; }
  }

  info(`Library API total records (${page} page${page > 1 ? "s" : ""})`, allRecords.length);

  // Records with sandboxName "Live" = Bethesda/ZeniMax — no useful title from library endpoint.
  // Records with "UE Marketplace" are Unreal Engine asset packs — skip them entirely.
  // All others: call catalog API to get real titles (sandboxName is often an internal codename).
  const liveRecords   = allRecords.filter(r => r.sandboxName === "Live");
  const normalRecords = allRecords.filter(r => r.sandboxName !== "Live" && r.sandboxName !== "UE Marketplace");

  // Fetch real titles from catalog for all records in parallel
  const [normalCatalogTitles, liveCatalogTitles] = await Promise.all([
    normalRecords.length > 0 ? fetchCatalogTitles(normalRecords, authToken, "normal") : Promise.resolve([]),
    liveRecords.length   > 0 ? fetchCatalogTitles(liveRecords,   authToken, "live")   : Promise.resolve([]),
  ]);

  const rawTitles = [
    // Catalog-resolved titles (real game names — preferred over internal codenames)
    ...normalCatalogTitles,
    ...liveCatalogTitles,
    // Fallback: sandboxName/title field for records not resolved by catalog
    ...normalRecords.flatMap(r => {
      const sandbox = _isUUID(r.sandboxName) ? null : r.sandboxName;
      const root    = _isUUID(r.title)       ? null : r.title;
      const seen = new Set();
      const out = [];
      for (const t of [sandbox, root]) {
        if (t && t.length > 1 && !seen.has(t)) { seen.add(t); out.push(t); }
      }
      return out;
    }),
  ];

  const cleanTitles = rawTitles.filter(t => !_isJunkTitle(t));
  const uniqueTitles = [...new Set(cleanTitles)].sort((a, b) => a.localeCompare(b));
  info(`Library API: ${normalRecords.length} normal (${normalCatalogTitles.length} catalog) + ${liveRecords.length} Live (${liveCatalogTitles.length} catalog) → ${rawTitles.length - cleanTitles.length} junk filtered → ${uniqueTitles.length} unique titles`);

  // Full sorted lists for diagnosis — copy from the Logs tab
  logDump("FULL API titles (sorted)", uniqueTitles);
  logDump("FULL normal catalog titles (sorted)", [...new Set(normalCatalogTitles)].sort((a, b) => a.localeCompare(b)));
  logDump("FULL Live catalog titles (sorted)", [...new Set(liveCatalogTitles)].sort((a, b) => a.localeCompare(b)));

  info(`Library API OK — ${uniqueTitles.length} titles`);
  return uniqueTitles;
}

// ── Catalog API: resolve titles for records with sandboxName "Live" ───────
const _isUUID = t => !t || /^[a-f0-9-]{32,}$/i.test(t);

// Epic uses single-word geographic/food/element/animal names as internal project codenames.
// These appear as sandboxName values in the library API and must be filtered before saving.
const _EPIC_CODENAMES = new Set([
  "alabaster","amethyst","angora","brilliantrose","burbank",
  "capsicum","charlestongreen","corn","curium",
  "dewberry","diamond","dublin","dysprosium",
  "empanada","fregula","hydra","laurel","lemon","lion","lisbon",
  "mezzelune","moremi","munster","nebelung",
  "radicchio","risotto","seaborgium","strontium",
  "torshavn","toucan","yttrium",
]);

const _isJunkTitle = t => {
  if (!t) return true;
  const lower = t.toLowerCase();
  return (
    lower === "ut marketplace" ||
    /\bproduction\b/i.test(t) ||
    /^Mt[A-Z]/.test(t) ||
    _EPIC_CODENAMES.has(lower)
  );
};

async function fetchCatalogTitles(records, authToken, label = "catalog") {
  const CATALOG_BASE = "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace";

  const byNamespace = new Map();
  for (const r of records) {
    if (!r.namespace || !r.catalogItemId) continue;
    if (!byNamespace.has(r.namespace)) byNamespace.set(r.namespace, new Set());
    byNamespace.get(r.namespace).add(r.catalogItemId);
  }
  info(`Catalog API (${label}): ${records.length} records across ${byNamespace.size} namespaces`);

  let okCount = 0, failCount = 0, sampleLogged = false;

  const results = await Promise.all(
    Array.from(byNamespace.entries()).map(async ([namespace, ids]) => {
      try {
        const url = new URL(`${CATALOG_BASE}/${namespace}/bulk/items`);
        for (const id of ids) url.searchParams.append("id", id);
        url.searchParams.set("country", "US");
        url.searchParams.set("locale", "en-US");

        const resp = await fetch(url.toString(), { headers: authHeaders(authToken) });
        if (!resp.ok) {
          failCount++;
          if (failCount <= 2) warn(`Catalog API HTTP ${resp.status}`, namespace.slice(0, 8));
          return [];
        }
        okCount++;
        const json = await resp.json();
        if (!sampleLogged) { sampleLogged = true; info("Catalog API sample response", json); }

        const items = Array.isArray(json) ? json : Object.values(json);
        return items
          .map(item => item?.title)
          .filter(t => t && t.length > 1 && !_isUUID(t));
      } catch (e) {
        failCount++;
        if (failCount <= 1) warn("Catalog API exception", e.message);
        return [];
      }
    })
  );

  const titles = results.flat();
  info(`Catalog API (${label}): ${okCount} ok / ${failCount} failed → ${titles.length} titles`);
  return titles;
}

// ── Method 4: Epic account owned items (newer endpoint) ───────────────────
async function fetchViaOwnedItems(authToken, accountIdFromPage) {
  if (!accountIdFromPage) {
    // Try to get account ID from cookie
    try {
      const all = await chrome.cookies.getAll({ domain: ".epicgames.com" });
      accountIdFromPage = all.find(c => c.name.toLowerCase().includes("account_id"))?.value;
      info("Account ID from cookie", accountIdFromPage ? accountIdFromPage.slice(0, 8) + "..." : "not found");
    } catch (e) { /* ignore */ }
  }
  if (!accountIdFromPage) throw new Error("No account ID available");

  const URL = `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/${accountIdFromPage}`;
  info("Method 4: Account API", URL);
  const headers = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(URL, { headers });
  info(`Account API HTTP status`, resp.status);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  info("Account API response", Object.keys(json));
  // This returns account info, not library — but confirms auth works
  throw new Error("Account API confirms auth but doesn't list games — expected");
}

// ── Main scan ─────────────────────────────────────────────────────────────
async function doScan(authFromPage, accountIdFromPage) {
  logs.length = 0;
  const { epicDebugLogs } = await chrome.storage.local.get("epicDebugLogs");
  DEBUG = !!epicDebugLogs;
  info(`Already Own? v${VERSION} background scan started`);
  info("Auth token from page?", authFromPage ? `Yes (${authFromPage.length} chars)` : "No");
  info("Account ID from page?", accountIdFromPage ? accountIdFromPage.slice(0, 8) + "..." : "No");

  // Get auth from cookies as fallback/supplement
  const cookieToken = await getEpicAuthFromCookies();
  // Real auth tokens (JWT, EG1~) are always >100 chars. Short values from the page
  // extractor are often expiry timestamps or flags that matched a key name containing
  // "token". Prefer by format first, then by length.
  const authToken =
    (authFromPage?.startsWith("EG1~") ? authFromPage : null) ||
    (cookieToken?.startsWith("EG1~") ? cookieToken : null) ||
    ((authFromPage?.length || 0) >= 100 ? authFromPage : null) ||
    cookieToken ||
    authFromPage;
  if (!authToken) {
    warn("No auth token found from page or cookies. Make sure you are logged in to the Epic Store and try again.");
  } else {
    info("Final auth token", `${authToken.length} chars, EG1=${authToken.toLowerCase().startsWith("eg1~")}`);
  }

  const methods = [
    { name: "Library Service API", fn: () => fetchViaLibraryAPI(authToken) },
    { name: "GraphQL API",         fn: () => fetchViaGraphQL(authToken) },
    { name: "Assets API",          fn: () => fetchViaAssetsAPI(authToken) },
  ];

  for (const method of methods) {
    try {
      const titles = await method.fn();
      const games = [...new Set(titles)].filter(g => g && g.length > 1);
      info(`SUCCESS via ${method.name} — ${games.length} unique games`);
      const { total, added } = await saveGames(games, "epic");
      return { games, total, added, method: method.name, logs: [...logs] };
    } catch (e) {
      error(`FAILED — ${method.name}: ${e.message}`);
    }
  }

  error("All methods failed");
  throw { message: "All API methods failed — see Logs tab for details.", logs: [...logs] };
}

// ── Steam profile page DOM scraper ────────────────────────────────────────
// Opens a background tab to the user's public profile games list and reads
// all game names from the DOM — no rate limits, no API keys.
// Returns string[] on success or null if profile is private / page unreadable.
async function fetchNamesFromProfilePage(steamId) {
  let bgTab = null;
  try {
    const url = `https://steamcommunity.com/profiles/${steamId}/games/?tab=all&sort=name`;
    info("Profile page: opening", url);
    bgTab = await chrome.tabs.create({ url, active: false });

    // Wait for the page to fully load
    await new Promise((resolve, reject) => {
      const tid = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(fn);
        reject(new Error("profile tab load timeout"));
      }, 20000);
      function fn(tabId, changeInfo) {
        if (tabId !== bgTab.id || changeInfo.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(tid);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(fn);
    });

    // Brief pause for any JS rendering after load event
    await new Promise(resolve => setTimeout(resolve, 1500));

    const results = await chrome.scripting.executeScript({
      target: { tabId: bgTab.id },
      world: "MAIN",
      func: async () => {
        // 1. Old Steam profile: g_rgGames global variable (server-injected JSON)
        if (Array.isArray(window.g_rgGames) && window.g_rgGames.length > 0) {
          return { names: window.g_rgGames.map(g => g.name || g.strName).filter(Boolean), via: "g_rgGames" };
        }
        // Also check inline <script> tags for the variable
        for (const s of document.querySelectorAll("script")) {
          const m = s.textContent?.match(/var\s+g_rgGames\s*=\s*(\[[\s\S]*?\]);/);
          if (m) {
            try {
              const games = JSON.parse(m[1]);
              const names = games.map(g => g.name || g.strName).filter(Boolean);
              if (names.length > 0) return { names, via: "inline g_rgGames" };
            } catch { /* malformed JSON */ }
          }
        }

        // Bail out early if the page shows a "private profile" or error block
        if (document.querySelector(".profile_private_info, .error_ctn")) {
          return { names: null, via: "private-or-error" };
        }

        // 2. DOM scraping — handles both old server-rendered and new React-based layouts.
        //    For React virtual lists scroll down until no new names appear.
        const seen = new Set();
        const collect = () => {
          // New React UI (user-verified selector from desktop Steam web UI)
          for (const a of document.querySelectorAll("div.Panel[role=button] span a")) {
            const t = a.textContent?.trim();
            if (t) seen.add(t);
          }
          // Old server-rendered profile page
          for (const el of document.querySelectorAll("#games_list_rows .gameName, .gameListRow .gameName")) {
            const t = el.textContent?.trim();
            if (t) seen.add(t);
          }
        };

        collect();
        // Scroll until the set stops growing (handles React virtual-scroll lists)
        let prev = -1;
        while (seen.size !== prev) {
          prev = seen.size;
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise(r => setTimeout(r, 400));
          collect();
        }
        return seen.size > 0
          ? { names: [...seen], via: "dom" }
          : { names: null, via: "dom-empty" };
      },
    });

    const r = results?.[0]?.result;
    info("Profile page result", `via=${r?.via ?? "none"} names=${r?.names?.length ?? 0}`);
    return Array.isArray(r?.names) && r.names.length > 0 ? r.names : null;
  } catch (e) {
    warn("Profile page scan failed", e.message);
    return null;
  } finally {
    if (bgTab) chrome.tabs.remove(bgTab.id).catch(() => {});
  }
}

// ── Steam scan via store.steampowered.com ─────────────────────────────────
// Step 1: DOM scrape the user's Steam Community profile games page (primary path)
// Step 2: dynamicstore/userdata/ → owned app IDs (fallback path only)
// Step 3a: ISteamApps/GetAppList from service worker
// Step 3b/3c: relay GetAppList through a Steam Store tab (page origin bypasses any block)
// Step 4: appdetails for any IDs not covered above (paced to avoid rate limiting)
async function fetchSteamViaStoreApi(steamId) {
  // Step 1: profile page DOM scrape — fast, returns complete game names, no API rate limits.
  // This is the primary path; when it returns names we skip all subsequent API calls.
  info("Step 1: Steam Community profile page DOM scrape");
  const profilePageNames = await fetchNamesFromProfilePage(steamId);
  if (profilePageNames && profilePageNames.length > 50) {
    info(`Profile page: ${profilePageNames.length} names — scan complete`);
    return profilePageNames;
  }
  if (profilePageNames) info(`Profile page: only ${profilePageNames.length} names — continuing with API fallback`);
  else info("Profile page: no names (private profile or network error) — continuing with API fallback");

  // Step 2: get owned app IDs (needed only for the API fallback path below)
  info("Step 2: store.steampowered.com/dynamicstore/userdata");
  const udResp = await fetch("https://store.steampowered.com/dynamicstore/userdata/", {
    credentials: "include",
    headers: { "Accept": "application/json, */*" },
  });
  info("userdata HTTP status", udResp.status);
  if (!udResp.ok) throw new Error(`userdata HTTP ${udResp.status}`);

  const ud = await udResp.json();
  const rawIds = ud?.rgOwnedApps;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    error("Steam store session not active (rgOwnedApps empty)");
    throw { message: "Not signed in to Steam. Open store.steampowered.com in Chrome and sign in, then try again.", logs: [...logs] };
  }
  // Normalize to numbers — some Steam API variants return string IDs
  const ownedIds = rawIds.map(Number).filter(n => n > 0);
  info(`Owned app IDs: ${ownedIds.length}`);
  const ownedSet = new Set(ownedIds);

  // nameMap: appid (number) → name string — persists across all resolution steps
  const nameMap = new Map();

  // Step 3a: try GetAppList directly from the service worker
  const appListUrls = [
    "https://api.steampowered.com/ISteamApps/GetAppList/v0002/?format=json",
    "https://api.steampowered.com/ISteamApps/GetAppList/v2/?format=json",
    "https://api.steampowered.com/ISteamApps/GetAppList/v0001/?format=json",
  ];
  let getAppListWorked = false;
  for (const url of appListUrls) {
    try {
      info("Step 3a: GetAppList", url);
      const r = await fetch(url);
      info("GetAppList HTTP status", r.status);
      if (!r.ok) continue;
      const json = await r.json();
      const apps = json?.applist?.apps;
      if (!Array.isArray(apps) || apps.length === 0) continue;
      info(`GetAppList: ${apps.length} entries in catalog`);
      for (const a of apps) {
        const id = Number(a.appid);
        if (ownedSet.has(id) && a.name?.trim()) nameMap.set(id, a.name.trim());
      }
      info(`GetAppList matched ${nameMap.size} of ${ownedSet.size} owned IDs`);
      getAppListWorked = true;
      break;
    } catch (e) { warn("GetAppList attempt failed", e.message); }
  }

  // Step 3b/3c: relay GetAppList through a Steam Store page context.
  // Scripts in MAIN world run with the page's origin; api.steampowered.com accepts that origin
  // but returns 404 for Chrome-extension service-worker origins.
  if (!getAppListWorked) {
    const appListFuncInPage = async (ids) => {
      const owned = new Set(ids.map(Number));
      const urls = [
        "https://api.steampowered.com/ISteamApps/GetAppList/v0002/?format=json",
        "https://api.steampowered.com/ISteamApps/GetAppList/v2/?format=json",
      ];
      const diag = [];
      for (const url of urls) {
        const tag = url.includes("v0002") ? "v0002" : "v2";
        try {
          const r = await fetch(url);
          diag.push(`${tag}=${r.status}`);
          if (!r.ok) continue;
          const json = await r.json();
          // Steam changed response envelope in newer pagination API: response.apps instead of applist.apps
          const apps = json?.applist?.apps ?? json?.response?.apps;
          diag.push(`entries=${Array.isArray(apps) ? apps.length : "none"}`);
          if (!Array.isArray(apps) || apps.length === 0) continue;
          // Filter to owned IDs before returning to avoid transferring ~4 MB over the bridge
          const matched = apps
            .filter(a => owned.has(Number(a.appid)) && a.name?.trim())
            .map(a => [Number(a.appid), a.name.trim()]);
          return { games: matched, diag: diag.join(" | ") };
        } catch (e) { diag.push(`${tag}=err:${e.message.slice(0, 40)}`); }
      }
      return { games: null, diag: diag.join(" | ") };
    };

    // 2b: use an already-open Steam Store tab if available (zero overhead)
    let relayTabId = null;
    const existingTabs = await chrome.tabs.query({ url: "https://store.steampowered.com/*" });
    if (existingTabs.length > 0) {
      relayTabId = existingTabs[0].id;
      info(`Step 3b: relaying GetAppList via existing tab (id=${relayTabId})`);
    }

    // 2c: no tab open — create a silent background tab, use it, then close it
    let bgTab = null;
    if (relayTabId === null) {
      info("Step 3c: opening temporary background Steam tab for GetAppList relay");
      try {
        bgTab = await chrome.tabs.create({ url: "https://store.steampowered.com/", active: false });
        relayTabId = bgTab.id;
        // Wait for the tab to finish loading (max 15 s)
        await new Promise((resolve, reject) => {
          const tid = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(fn);
            reject(new Error("tab load timeout"));
          }, 15000);
          function fn(tabId, changeInfo) {
            if (tabId !== bgTab.id || changeInfo.status !== "complete") return;
            chrome.tabs.onUpdated.removeListener(fn);
            clearTimeout(tid);
            resolve();
          }
          chrome.tabs.onUpdated.addListener(fn);
        });
        info("Background tab loaded");
      } catch (e) {
        warn("Background tab creation/load failed", e.message);
        relayTabId = null;
      }
    }

    if (relayTabId !== null) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: relayTabId },
          world: "MAIN",
          args: [ownedIds],
          func: appListFuncInPage,
        });
        const relayResult = results?.[0]?.result;
        if (relayResult?.diag) info("GetAppList page context diagnostic", relayResult.diag);
        const pairs = relayResult?.games;
        if (Array.isArray(pairs) && pairs.length > 0) {
          for (const [id, name] of pairs) nameMap.set(id, name);
          info(`GetAppList relay: matched ${nameMap.size} names`);
          getAppListWorked = true;
        } else {
          info("GetAppList relay: no results from page context — falling back to appdetails");
        }
      } catch (e) {
        warn("GetAppList relay script failed", e.message);
      } finally {
        if (bgTab) chrome.tabs.remove(bgTab.id).catch(() => {});
      }
    }
  }

  // Step 4: appdetails for any IDs still unresolved.
  // Steam rate-limits around request ~300-450; strategy:
  //   - 100 ms between batches (slows burst rate, helps early range)
  //   - 20 s strategic pause every 300 requests (resets the sliding window)
  //   - retry on explicit 429
  const unresolvedIds = ownedIds.filter(id => !nameMap.has(id));
  if (unresolvedIds.length > 0) {
    info(`Step 4: appdetails for ${unresolvedIds.length} unresolved IDs`);
    const PARALLEL = 15;
    let i = 0;
    while (i < unresolvedIds.length) {
      const chunk = unresolvedIds.slice(i, i + PARALLEL);
      const results = await Promise.all(chunk.map(async (appid) => {
        try {
          // cc=us ensures consistent results regardless of user's region for the name lookup
          const r = await fetch(`https://store.steampowered.com/api/appdetails/?appids=${appid}&cc=us&l=english&filters=basic`);
          if (r.status === 429) return "ratelimit";
          if (!r.ok) return null;
          const data = await r.json();
          const d = data?.[String(appid)]?.data ?? data?.[appid]?.data;
          if (!d?.name) return null;
          const type = d.type ?? "game";
          if (type === "tool" || type === "music" || type === "video" || type === "advertising") return null;
          return { id: appid, name: d.name };
        } catch { return null; }
      }));

      const rateLimitHits = results.filter(r => r === "ratelimit").length;
      if (rateLimitHits > 0) {
        info(`Rate limited (${rateLimitHits}/${chunk.length}) — pausing 20 s`);
        await new Promise(resolve => setTimeout(resolve, 20000));
        continue; // retry same batch
      }

      for (const r of results) { if (r && r !== "ratelimit") nameMap.set(r.id, r.name); }
      i += PARALLEL;

      // Every 300 requests, take a longer break to let Steam's rate-limit window reset.
      // Poll storage every second during the pause to keep the service worker alive
      // (Chrome MV3 may terminate idle workers; storage API calls extend the lifetime).
      if (i > 0 && i % 300 === 0 && i < unresolvedIds.length) {
        info(`Strategic pause at ${i}/${unresolvedIds.length} (${nameMap.size} names) — 20 s rate-limit reset`);
        const pauseEnd = Date.now() + 20000;
        while (Date.now() < pauseEnd) {
          await chrome.storage.local.get(LIBRARY_KEY); // keeps SW alive during wait
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else if (i < unresolvedIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (i % 150 === 0 || i >= unresolvedIds.length) {
        info(`appdetails progress: ${nameMap.size} total names (checked ${Math.min(i, unresolvedIds.length)}/${unresolvedIds.length})`);
      }
    }
  }

  const names = [...nameMap.values()].filter(Boolean);
  info(`Resolved ${names.length} names from ${ownedSet.size} owned IDs`);
  return names.length > 0 ? names : null;
}

// ── Steam scan ────────────────────────────────────────────────────────────
async function doSteamScan() {
  logs.length = 0;
  const { epicDebugLogs } = await chrome.storage.local.get("epicDebugLogs");
  DEBUG = !!epicDebugLogs;
  info(`Already Own? v${VERSION} Steam scan started`);

  const steamId = await getSteamIdFromCookie();
  if (!steamId) throw { message: "Not logged into Steam in Chrome — open store.steampowered.com and sign in.", logs: [...logs] };
  info(`Steam ID found`, steamId.slice(0, 8) + "...");

  let names = null;
  try {
    names = await fetchSteamViaStoreApi(steamId);
  } catch (e) {
    if (e.logs) throw e;
    error("Store API method failed", e.message);
    throw {
      message: `Steam scan failed: ${e.message}. Make sure you are signed into store.steampowered.com in Chrome.`,
      logs: [...logs],
    };
  }

  if (!names || names.length === 0) {
    throw { message: "Steam scan found 0 games — no games returned from Steam Store API.", logs: [...logs] };
  }

  const { total, added } = await saveGames(names, "steam");
  return { success: true, games: names, total, added, method: "Steam Store API", logs: [...logs] };
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log(`Already Own? v${VERSION} installed`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "doScan") {
    doScan(msg.authToken || null, msg.accountId || null)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message || String(err), logs: err.logs || logs }));
    return true; // async
  }

  if (msg.action === "doSteamScan") {
    doSteamScan()
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message || String(err), logs: err.logs || logs }));
    return true;
  }

  if (msg.action === "checkAuth") {
    getEpicAuthFromCookies().then(token => sendResponse({ hasAuth: !!token }));
    return true;
  }

  if (msg.action === "checkSteamAuth") {
    getSteamIdFromCookie().then(id => sendResponse({ hasAuth: !!id }));
    return true;
  }
});
