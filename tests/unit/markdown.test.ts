import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../app/Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, citeBase: "src-m1" }));

describe("Markdown renderer", () => {
  it("renders bold, lists and paragraphs", () => {
    const out = html("**Supabase Pro** is $25/month.\n\n- Includes 8 GB\n- Daily backups\n\n1. First\n2. Second");
    expect(out).toContain("<strong>Supabase Pro</strong> is $25/month.");
    expect(out).toContain("<ul><li>Includes 8 GB</li><li>Daily backups</li></ul>");
    expect(out).toContain("<ol><li>First</li><li>Second</li></ol>");
  });

  it("turns [n] and [1, 3] into links to the source list", () => {
    const out = html("Pro is $25 [1]; Team is $599 [1, 3].");
    expect(out).toContain('<sup class="cite"><a href="#src-m1-1">1</a></sup>');
    expect(out).toContain('<a href="#src-m1-1">1</a>,<a href="#src-m1-3">3</a>');
  });

  it("never injects HTML or unsafe links from model or web text", () => {
    const out = html('<script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders only http(s) links", () => {
    expect(html("See [pricing](https://supabase.com/pricing).")).toContain(
      '<a href="https://supabase.com/pricing" target="_blank" rel="noopener noreferrer">pricing</a>',
    );
  });
});
