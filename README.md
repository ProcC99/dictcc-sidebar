# dict.cc Sidebar

An Obsidian plugin that lets you look up any German or English word on [dict.cc](https://www.dict.cc/) without leaving your vault.

**Right-click any selected word → "dict.cc: word" → bilingual translation table appears in the sidebar.**

## Features

- Works in both **editor view** and **reading view**
- Shows **grouped translation tables** with section headers (Verbs, Nouns, etc.)
- **Misspelling suggestions** — click any suggestion to re-search instantly
- **Direction filter** in settings: DE ↔ EN (both), DE → EN, or EN → DE
- **Max results** slider to control how many rows are displayed
- Respects Obsidian's **light and dark themes** via CSS variables
- Desktop only

## Installation

### From the Community Plugin Browser (recommended)
1. Open Obsidian → Settings → Community Plugins → Browse
2. Search for **dict.cc Sidebar**
3. Install and enable

### Manual installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Copy them to `.obsidian/plugins/dictcc-sidebar/` in your vault
3. Enable the plugin in Settings → Community Plugins

## Usage
1. Select a word in any note (editor or reading view)
2. Right-click → **dict.cc: "word"**
3. The sidebar opens with bilingual translation results

Or use the Command Palette: **Look up selection in dict.cc**

## Settings
Open Settings → dict.cc Sidebar:
- **Translation direction**: show both directions, only DE→EN, or only EN→DE
- **Max results**: limit how many translation rows are shown

## License
MIT — forked from [wiktionary-sidebar](https://github.com/jonas-karneboge/wiktionary-sidebar) by Jonas Karneboge
