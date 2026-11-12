import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe Markdown for chat answers: paragraphs, bullet and numbered lists, **bold**, `code`,
 * [text](https://…) links and [n] citations. Builds React elements only (no HTML injection), so model
 * output and web text can never inject markup or scripts.
 */
export function Markdown({ text, citeBase }: { text: string; citeBase?: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "), citeBase)}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item, citeBase)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        <p key={blocks.length} className="md-heading">
          {inline(heading[1], citeBase)}
        </p>,
      );
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div className="md">{blocks}</div>;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\[\d+(?:\s*,\s*\d+)*\])/g;

function inline(text: string, citeBase?: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      );
    }
    const cite = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
    if (cite) {
      const numbers = cite[1].split(",").map((n) => n.trim());
      return (
        <sup key={i} className="cite">
          {numbers.map((n, j) => (
            <Fragment key={n}>
              {j > 0 && ","}
              {citeBase ? <a href={`#${citeBase}-${n}`}>{n}</a> : n}
            </Fragment>
          ))}
        </sup>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
