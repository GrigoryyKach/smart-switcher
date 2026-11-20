# Smart Switcher

A local EN ⇄ RU keyboard layout auto-switcher for Windows, similar to Punto Switcher.
Type `ghbdtn` and press space: you get `привет`, and the layout switches to Russian by itself.
It works fully offline.

## Platforms

Windows only (Windows 10/11 x64). There is no Linux version, because the app depends on Windows-specific APIs. In the NIMVORO launcher on Linux it is not shown (`"platforms": ["windows"]` in `nimvoro.json`).

## Languages

The interface is available in English (default), Russian and Ukrainian, including the tray menu and notifications.
Pick the language and the theme (System / Light / Dark) in Settings → General.
The starting language comes from the app config, then from the NIMVORO install marker (`.nimvoro.json` next to the exe), and falls back to English.

## Run

```bash
npm install
npm start
```

`npm start` compiles the native helper and starts the app. The C# compiler is built into Windows (.NET Framework 4.x), so nothing extra is needed. An icon appears in the tray: a click opens the settings, a right click opens the menu.

Both the English and the Russian keyboard layouts must be installed in Windows.

## Features

- **Auto-correction** after space, Enter or Tab (configurable).
- **Pause** (or double Shift, double Ctrl):
  - while typing a word, converts it to the other layout;
  - right after an auto-correction, undoes it and remembers the word as an exception;
  - after a space, fixes the last word.
- **Shift+Pause** converts the selected text as a whole.
- Also fixes a short preceding preposition together with the next word: `yf cnjkt` → `на столе`.
- Exceptions for words and for apps: games, terminals, password managers.
- Word check in the settings: see what the app will do and why.
- Correction log for the session (kept in memory only).

## How it works

```
Electron (src/)                         Native helper (helper/, C#)
 ├ tray, settings window    JSON over   ├ global keyboard and mouse hook
 ├ config.json in %APPDATA% ◄────────►  ├ buffer of the current word
 └ log, statistics          stdin/out   ├ detector: dictionaries + trigram model
                                        └ replacement: Backspace×N → Unicode input → layout switch
```

- `helper/src/Engine.cs`: hook, buffer, auto-replacement, undo, selected text.
- `helper/src/Detector.cs`: decides whether the layout is right: dictionaries first, then a trigram model normalized per language.
- `helper/dict/*.txt`: dictionaries embedded into the exe. You can add words, one per line or separated by spaces.
- `src/main.js`: tray, helper start and restart, config; `src/settings/`: the interface; `src/i18n.js`: UI strings in all three languages.

If Electron exits, the helper exits too when its stdin closes, so no hooks are left hanging.

## Build the .exe

```bash
npm run package
```

The result is `dist/SmartSwitcher-win32-x64/SmartSwitcher.exe`. The folder can be moved anywhere; run the exe inside it. The application icon comes from `assets/icon.ico` and `assets/icon.png`.

## Tests

```bash
npm run selftest
```

## Updates

With the NIMVORO launcher installed, "Update" hands over to the launcher. Without it, the app updates itself: it downloads `SmartSwitcher-win-x64.zip` from the latest GitHub release, checks the SHA-256 against the release asset's `digest` (no digest, no install), extracts to `.update-staging`, swaps the files (rolling back on failure; `app.asar` is locked while the app runs, so a small helper swaps after the app exits) and restarts. Leftover `*.old` files are removed on the next start. If the app folder is not writable, the release page opens instead. Design: `tasks/selfupdate-design.md` in the NIMVORO workspace.

Test overrides: `SMART_SWITCHER_UPDATE_API` (release JSON URL), `SMART_SWITCHER_AUTO_UPDATE=1`, `NIMVORO_LAUNCHER_JSON`. Run `npm run test:update` for the unit tests.

## Support

If you find Smart Switcher useful, you can support its development: https://donatello.to/MicsGame
