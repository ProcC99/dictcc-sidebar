import {
  App,
  Editor,
  ItemView,
  Menu,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  requestUrl,
} from "obsidian";

// ── Types ───────────────────────────────────────────────────────────────────

type Direction = "both" | "de-en" | "en-de";

interface DictEntry {
  section: string;
  english: string;
  german: string;
}

interface DictResult {
  term: string;
  entries: DictEntry[];
  suggestions: string[];
  notFound: boolean;
}

interface DictCCSettings {
  direction: Direction;
  maxResults: number;
}

const DEFAULT_SETTINGS: DictCCSettings = {
  direction: "both",
  maxResults: 40,
};

const VIEW_TYPE = "dictcc-sidebar";

// ── HTML helpers ─────────────────────────────────────────────────────────────

function decodeHtml(str: string): string {
  return str
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_: string, n: string) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(str: string): string {
  return decodeHtml(str.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeCell(cellHtml: string): string {
  let s = cellHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  return stripTags(s)
    .replace(/\s*\[\s*/g, " [")
    .replace(/\s*\]\s*/g, "] ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

// ── dict.cc fetch + parse ────────────────────────────────────────────────────

async function fetchDictCC(term: string): Promise<DictResult> {
  const url = `https://www.dict.cc/?s=${encodeURIComponent(term)}`;

  let html: string;
  try {
    const res = await requestUrl({
      url,
      headers: { "accept-language": "en,de;q=0.9" },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    html = res.text;
  } catch {
    return { term, entries: [], suggestions: [], notFound: true };
  }

  // ── Extract suggestions from c1Entry / "Ähnliche Begriffe" / failed_kw ──
  const suggestions: string[] = [];

  // failed_kw in URL means this is a corrected search — the original bad term
  const failedKw = html.match(/failed_kw=([^&"'>\s]+)/i);
  if (failedKw) {
    const bad = decodeURIComponent(failedKw[1].replace(/\+/g, " "));
    suggestions.push(bad);
  }

  // Suggestion links appearing in similar-words blocks
  const suggLinkRe = /<a[^>]+href="[^"]*\?s=([^"&]+)[^"]*"[^>]*class="[^"]*(?:col1Entry|did-you-mean)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = suggLinkRe.exec(html))) {
    const t2 = stripTags(sm[2]).replace(/^[•·-]\s*/, "");
    if (t2 && !suggestions.includes(t2)) suggestions.push(t2);
  }

  // Also scan the "Ähnliche Begriffe" / similar section for plain word links
  const simBlock = html.match(/hnliche Begriffe([\s\S]{0,3000}?)(?:back to top|home|©)/i)?.[1] ?? "";
  const simRe = /<a[^>]+href="[^"]*\?s=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sg: RegExpExecArray | null;
  while ((sg = simRe.exec(simBlock))) {
    const t3 = stripTags(sg[2]).replace(/^[•·-]\s*/, "");
    if (t3 && t3.length < 50 && !suggestions.includes(t3)) suggestions.push(t3);
  }

  // ── Extract translation rows ─────────────────────────────────────────────
  // dict.cc embeds translations in a JS variable: var c1Arr = [...];
  // Each entry is: [id, [en_html, de_html], pos, tags]
  // Fallback: parse HTML table rows
  const entries: DictEntry[] = [];
  let currentSection = "Entries";

  // Try JS variable extraction first (most reliable)
  const jsArr = html.match(/var\s+c1Arr\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (jsArr) {
    try {
      // eslint-disable-next-line no-eval -- dict.cc embeds translations in a JS variable
      const arr = JSON.parse(jsArr[1]) as Array<[number, [string, string], string, string[]]>;
      for (const row of arr) {
        if (!Array.isArray(row) || !Array.isArray(row[1])) continue;
        const [en, de] = row[1];
        const sec = typeof row[2] === "string" && row[2] ? row[2] : "Entries";
        const english = normalizeCell(en);
        const german = normalizeCell(de);
        if (english && german) entries.push({ section: sec, english, german });
      }
    } catch {
      // fallthrough to HTML table parse
    }
  }

  // HTML table fallback
  if (!entries.length) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(html))) {
      const rowHtml = rm[1];
      // Section header rows (colspan)
      const sectionOnly = rowHtml.match(/<td[^>]*colspan=["']?\d+["']?[^>]*>([\s\S]*?)<\/td>/i);
      if (sectionOnly && !/<td[^>]*>[\s\S]*?<td/i.test(rowHtml)) {
        const st = normalizeCell(sectionOnly[1]);
        if (st && !/dict\.cc|Impressum|back to top/i.test(st)) currentSection = st;
        continue;
      }
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const cleaned = cells.map(normalizeCell);
      const english = cleaned[0];
      const german = cleaned[1];
      if (!english || !german) continue;
      if (/^English$/i.test(english) || /^German$/i.test(german)) continue;
      if (/dict\.cc|Impressum|©/.test(english)) continue;
      entries.push({ section: currentSection, english, german });
    }
  }

  const notFound = entries.length === 0;
  return { term, entries, suggestions: suggestions.slice(0, 10), notFound };
}

// ── ItemView (Sidebar) ────────────────────────────────────────────────────────

class DictCCSidebarView extends ItemView {
  private plugin: DictCCPlugin;
  private currentSuggestions: string[] = [];
  private currentTerm = "";

  constructor(leaf: WorkspaceLeaf, plugin: DictCCPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "dict.cc"; }
  getIcon(): string { return "languages"; }

  async onOpen(): Promise<void> { this.renderEmpty(); }
  async onClose(): Promise<void> {}

  async lookup(term: string): Promise<void> {
    this.currentTerm = term;
    this.renderLoading(term);
    const result = await fetchDictCC(term);
    this.renderResult(result);
  }

  private container(): HTMLElement {
    return this.containerEl.children[1] as HTMLElement;
  }

  private renderEmpty(): void {
    const c = this.container();
    c.empty();
    c.addClass("dictcc-container");
    c.createEl("p", { cls: "dictcc-placeholder", text: "Select a word and right-click → dict.cc lookup" });
  }

  private renderLoading(term: string): void {
    const c = this.container();
    c.empty();
    c.addClass("dictcc-container");
    c.createEl("p", { cls: "dictcc-loading", text: `Looking up "${term}"…` });
  }

  private renderResult(result: DictResult): void {
    const c = this.container();
    c.empty();
    c.addClass("dictcc-container");

    // Header
    const header = c.createEl("div", { cls: "dictcc-header" });
    header.createEl("h2", { cls: "dictcc-word", text: result.term });
    header.createEl("a", {
      cls: "dictcc-source-link",
      text: "dict.cc ↗",
      href: `https://www.dict.cc/?s=${encodeURIComponent(result.term)}`,
    });

    // Suggestions (misspelling / similar terms)
    if (result.suggestions.length > 0) {
      const sugBlock = c.createEl("div", { cls: "dictcc-suggestions" });
      sugBlock.createEl("p", { cls: "dictcc-sug-label", text: "Did you mean:" });
      const sugList = sugBlock.createEl("div", { cls: "dictcc-sug-list" });
      for (const sug of result.suggestions) {
        const btn = sugList.createEl("button", { cls: "dictcc-sug-btn", text: sug });
        btn.addEventListener("click", () => {
          this.lookup(sug).catch(console.error);
        });
      }
    }

    if (result.notFound) {
      c.createEl("p", { cls: "dictcc-not-found", text: `No translations found for "${result.term}".` });
      return;
    }

    // Filter by direction
    let entries = result.entries;
    const dir = this.plugin.settings.direction;
    if (dir === "de-en") {
      entries = entries.filter(
        (e) => e.german.toLowerCase().includes(result.term.toLowerCase())
      );
    } else if (dir === "en-de") {
      entries = entries.filter(
        (e) => e.english.toLowerCase().includes(result.term.toLowerCase())
      );
    }

    const maxR = this.plugin.settings.maxResults;
    entries = entries.slice(0, maxR);

    // Group by section
    const sections = new Map<string, DictEntry[]>();
    for (const e of entries) {
      if (!sections.has(e.section)) sections.set(e.section, []);
      sections.get(e.section)!.push(e);
    }

    for (const [sec, rows] of sections) {
      const secEl = c.createEl("div", { cls: "dictcc-section" });
      secEl.createEl("h4", { cls: "dictcc-section-title", text: sec });
      const table = secEl.createEl("table", { cls: "dictcc-table" });
      const thead = table.createEl("thead");
      const hrow = thead.createEl("tr");
      hrow.createEl("th", { text: "English" });
      hrow.createEl("th", { text: "Deutsch" });
      const tbody = table.createEl("tbody");
      for (const row of rows) {
        const tr = tbody.createEl("tr");
        tr.createEl("td", { text: row.english });
        tr.createEl("td", { text: row.german });
      }
    }
  }
}

// ── Settings Tab ─────────────────────────────────────────────────────────────

class DictCCSettingTab extends PluginSettingTab {
  private plugin: DictCCPlugin;
  constructor(app: App, plugin: DictCCPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Translation direction")
      .setDesc("Filter which direction to show results for.")
      .addDropdown((drop) =>
        drop
          .addOption("both", "DE ↔ EN (both)")
          .addOption("de-en", "DE → EN only")
          .addOption("en-de", "EN → DE only")
          .setValue(this.plugin.settings.direction)
          .onChange(async (val) => {
            this.plugin.settings.direction = val as Direction;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max results")
      .setDesc("Maximum number of translation rows to display (5–200).")
      .addSlider((s) =>
        s
          .setLimits(5, 200, 5)
          .setValue(this.plugin.settings.maxResults)
          .onChange(async (val) => {
            this.plugin.settings.maxResults = val;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ── Main Plugin ───────────────────────────────────────────────────────────────

export default class DictCCPlugin extends Plugin {
  settings!: DictCCSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new DictCCSidebarView(leaf, this));
    this.addSettingTab(new DictCCSettingTab(this.app, this));

    // Editor right-click menu
    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, _view: MarkdownView) => {
          const word = editor.getSelection().trim().split(/\s+/)[0];
          if (!word) return;
          menu.addItem((item) =>
            item
              .setTitle(`dict.cc: "${word}"`)
              .setIcon("languages")
              .onClick(() => {
                this.openAndLookup(word).catch(console.error);
              })
          );
        }
      )
    );

    // Reading view right-click
    this.registerDomEvent(activeDocument, "contextmenu", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      if (!target.closest(".markdown-preview-view")) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const selectedText = selection.toString().trim();
      const word = selectedText.split(/\s+/)[0];
      if (!word) return;
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Copy")
          .setIcon("copy")
          .onClick(() => navigator.clipboard.writeText(selectedText))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(`dict.cc: "${word}"`)
          .setIcon("languages")
          .onClick(() => {
            this.openAndLookup(word).catch(console.error);
          })
      );
      menu.showAtMouseEvent(evt);
    });

    // Command palette
    this.addCommand({
      id: "dictcc-lookup-selection",
      name: "Look up selection in dict.cc",
      editorCallback: (editor: Editor) => {
        const word = editor.getSelection().trim().split(/\s+/)[0];
        if (word) {
          this.openAndLookup(word).catch(console.error);
        }
      },
    });
  }

  onunload(): void {
    // Let Obsidian handle detach, don't detach in onunload to keep the user's workspace layout
  }

  async openAndLookup(word: string): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    const pReveal = workspace.revealLeaf(leaf) as unknown;
    if (pReveal instanceof Promise) {
      await pReveal;
    }
    if (leaf.view instanceof DictCCSidebarView) {
      await leaf.view.lookup(word);
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<DictCCSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
