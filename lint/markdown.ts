// Frontmatter and section parsing for plan files (design §5.2). Pure functions, no I/O.
import { parse as parseYaml } from "yaml";

export type Split =
  | { ok: true; frontmatter: string; body: string }
  | { ok: false; error: string };

/** Split `---\n<yaml>\n---\n<body>`; the file must open with the fence on its first line. */
export function splitFrontmatter(text: string): Split {
  const lines = text.split("\n");
  if (stripCr(lines[0] ?? "") !== "---") {
    return { ok: false, error: "does not open with a `---` frontmatter fence on its first line" };
  }
  for (let i = 1; i < lines.length; i++) {
    if (stripCr(lines[i] ?? "") === "---") {
      return { ok: true, frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { ok: false, error: "has no closing `---` frontmatter fence" };
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** YAML 1.2 core schema, duplicate keys refused, aliases capped (the input is untrusted data). */
export function parseFrontmatter(yamlText: string): Parsed {
  try {
    const value = parseYaml(yamlText, { uniqueKeys: true, maxAliasCount: 16, prettyErrors: false, strict: true });
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `frontmatter is not valid YAML: ${message.split("\n")[0]}` };
  }
}

export interface Section {
  /** The heading's text, without the `## ` marker. */
  title: string;
  /** 0-based index of the heading line in the body. */
  line: number;
  /** The section's lines after the heading, up to the next level-2 heading. */
  lines: string[];
}

export interface Sections {
  /** Lines before the first level-2 heading. */
  preamble: string[];
  sections: Section[];
}

/** Level-2 (`## `) sections of a Markdown body, ignoring headings inside fenced code blocks. */
export function level2Sections(body: string): Sections {
  const lines = body.split("\n").map(stripCr);
  const out: Sections = { preamble: [], sections: [] };
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = { char: marker.charAt(0), len: marker.length };
      } else if (marker.charAt(0) === fence.char && marker.length >= fence.len && line.trim() === marker) {
        fence = null;
      }
    }
    const heading = fence === null ? /^## +(.*?)(?: +#+)? *$/.exec(line) : null;
    if (heading && !fenceMatch) {
      out.sections.push({ title: (heading[1] ?? "").trim(), line: i, lines: [] });
      continue;
    }
    const current = out.sections[out.sections.length - 1];
    if (current) current.lines.push(line);
    else out.preamble.push(line);
  }
  return out;
}

/** Top-level list items of a section (`- `, `* `, `+ `, `1. `, `1) `); indented lines continue an item. */
export function listItems(lines: string[]): { items: string[]; stray: string[] } {
  const items: string[] = [];
  const stray: string[] = [];
  for (const line of lines) {
    const start = /^(?:[-*+]|\d{1,3}[.)]) +(.*)$/.exec(line);
    if (start) {
      items.push((start[1] ?? "").trim());
    } else if (line.trim() === "") {
      continue;
    } else if (/^\s{2,}\S/.test(line) && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    } else {
      stray.push(line);
    }
  }
  return { items, stray };
}

/** Length in Unicode code points — what a reader counts as characters. */
export function charLength(text: string): number {
  return [...text].length;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
