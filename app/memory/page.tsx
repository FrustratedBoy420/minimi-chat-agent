"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Fact {
  id: string;
  subject: string;
  plan: string | null;
  attribute: string;
  value: string;
  origin: "web" | "user_said" | "assistant_said";
  quote: string;
  url: string | null;
  seenAt: string;
}

const ORIGIN_LABEL: Record<Fact["origin"], string> = {
  web: "web page",
  user_said: "you said",
  assistant_said: "I said",
};

/** "What I remember": every stored fact with its quote, source and date, so memory is inspectable. */
export default function MemoryPage() {
  const [facts, setFacts] = useState<Fact[] | null>(null);

  useEffect(() => {
    void fetch("/api/facts")
      .then((r) => r.json())
      .then(setFacts);
  }, []);

  return (
    <main className="memory">
      <header>
        <Link href="/">← Back to chat</Link>
        <h1>What I remember</h1>
        <p className="muted">
          Facts I recorded from web sources and from what you told me. Each one keeps the exact quote it came from;
          change checks compare against these.
        </p>
      </header>
      {facts === null ? (
        <p className="muted">Loading…</p>
      ) : facts.length === 0 ? (
        <p className="muted">Nothing yet. Ask about prices or tell me about a decision, and I’ll remember the facts.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>Value</th>
              <th>Source</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.subject}
                  {f.plan ? ` ${f.plan}` : ""} <span className="muted">· {f.attribute}</span>
                </td>
                <td title={`“${f.quote}”`}>{f.value}</td>
                <td>
                  {f.url ? (
                    <a href={f.url} target="_blank" rel="noopener noreferrer">
                      {new URL(f.url).hostname.replace(/^www\./, "")}
                    </a>
                  ) : (
                    ORIGIN_LABEL[f.origin]
                  )}
                </td>
                <td>{new Date(f.seenAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
