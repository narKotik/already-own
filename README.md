# Already Own? — Chrome Extension

Cross-library ownership checker. Shows whether you already own a game on Epic or Steam before buying it on the other store.

If you find it useful: [☕ Buy me a coffee](https://ko-fi.com/aleadyown)

## Features

- **📚 Epic Library Scanner** — Reads your owned games from the Epic Games Store
- **🎮 Steam Library Scanner** — Reads your full Steam library via your Community profile page
- **🏷️ Store Badges** — Shows a "You already own this!" badge near the buy button on Steam and Epic store pages
- **🔍 Fuzzy Matching** — Handles title differences (subtitles, punctuation, trademark symbols, etc.)
- **📥 Export / Import** — Back up and restore your library as a JSON file
- **🔒 100% Local** — All data stored on your device via `chrome.storage.local`. No servers, no tracking.

## Installation (Developer Mode)

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** → select this folder
5. The extension icon appears in your toolbar ✅

## How to Use

### Scan your Epic library
1. Open [store.epicgames.com](https://store.epicgames.com) and sign in
2. Navigate to your library and scroll to the bottom (Epic lazy-loads)
3. Open the extension popup → **Scan** tab → click **Scan Epic Library**

### Scan your Steam library
1. Open [store.steampowered.com](https://store.steampowered.com) and sign in
2. Open the extension popup → **Scan** tab → click **Scan Steam Library**
3. The extension opens your Steam Community games page in a background tab, scrolls through the full list, and closes it automatically

> **Note:** Scanning your Steam library opens a temporary background tab on `steamcommunity.com`. If your Steam profile games list is set to **private**, the scan will fall back to a slower Steam API method. Make sure your game details are set to public for best results.

> **Warning:** Running Steam store scans very frequently (the slower API fallback path) may result in a temporary block on `store.steampowered.com/api/appdetails` requests. If badge lookups on Steam stop working, wait a few minutes for the block to lift.

### Browse stores
Visit any game page on `store.steampowered.com/app/…` or `store.epicgames.com/p/…`. If you own the game in your other library, a badge appears above the buy button automatically.

## Tips

- Re-scan after buying new games to keep the list up to date
- The badge shows match confidence: **Exact match**, **Title match**, or **Likely match**
- Click **✕** on a badge to dismiss it permanently for that page
- Use **Add game manually** (top of Scan tab) to add games the scanner missed

## How Title Matching Works

Titles are normalized (trademark symbols removed, punctuation stripped, whitespace collapsed) and matched at three levels:

1. **Exact** — normalized titles are identical
2. **Partial** — one title contains the other (handles "Game: Subtitle" vs "Game")
3. **Fuzzy** — ≥75% word overlap (words longer than 2 characters)

## Managing Your Library

From the **Library** tab you can:

- **Search** your saved games
- **Ignore** false positives (✕ next to a game) — moves them to the ignore list and skips them on future scans
- **Restore** ignored games (↩) back to your library
- **Delete** from the ignore list permanently (the game may reappear on the next scan)

### Ignore list

Ignored games are hidden from the badge and skipped on all future scans. Use ↩ to restore, or ✕ to permanently remove (after which the next scan treats them as new).

### Export / Import

Use **↑ Export library** and **↓ Import library** (Scan tab) to back up and restore your game list as a JSON file. Import merges with your existing library without creating duplicates.

## Troubleshooting

Enable **Debug logs** (checkbox at the bottom of the popup), run a scan, then open the **Logs** tab. The log shows which method was used, how many games were found, and any errors. Use **Copy** to share the log when reporting an issue.

## File Structure

```
├── manifest.json       # Extension config (Manifest V3)
├── background.js       # Service worker — all network requests happen here
├── content_epic.js     # Runs on epicgames.com — auth extraction + Epic store badge
├── content_steam.js    # Runs on steampowered.com — Steam store badge
├── popup.html / popup.js  # Extension popup UI
├── importer.html / importer.js  # Dedicated import tab (avoids popup-closes-on-file-picker)
└── icons/
```

## Limitations

- **DLC appears as separate entries** — Epic's API returns DLC packs as individual items, so your count will often be higher than the base game count in the launcher. Use the ignore list to hide DLC.
- **Private Steam profile** — if your Steam games list is private, the fast profile-page scan falls back to the slower `appdetails` API, which is rate-limited.
- **Steam scan rate limit** — the `appdetails` API fallback (used when the profile page is private) is rate-limited by Steam. Scanning too frequently may temporarily block those requests. If Steam store pages stop loading correctly, wait a few minutes.
- **Title mismatches** — games with very different names on Epic vs Steam (regional differences, publisher renames) may not match.
- **Epic lazy-loading** — scroll to the bottom of your Epic library before scanning so all titles are loaded into the page.

## Privacy

No data ever leaves your computer. The extension uses only `chrome.storage.local` to persist your game list between sessions.
