"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { readEvents, type Citation } from "@/lib/protocol";
import { Markdown } from "./Markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  citations?: Citation[];
}

interface QuotaStatus {
  models: { label: string; configured: boolean; usedToday: number; dailyLimit: number | null; nearLimit: boolean }[];
  search: { configured: boolean; usedToday: number; dailyLimit: number };
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function ChatPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) setConversations(await res.json());
    const status = await fetch("/api/status");
    if (status.ok) setQuota(await status.json());
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  async function openConversation(id: string) {
    if (busy) return;
    setError(null);
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    const data = (await res.json()) as { id: string; messages: Message[] };
    setConversationId(data.id);
    setMessages(data.messages);
  }

  function newConversation() {
    if (busy) return;
    setConversationId(undefined);
    setMessages([]);
    setError(null);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setError(null);
    setBusy(true);
    setStatus("Thinking…");
    const userTemp: Message = { id: `tmp-user-${Date.now()}`, role: "user", content: text };
    const assistantTemp: Message = { id: `tmp-assistant-${Date.now()}`, role: "assistant", content: "" };
    setMessages((prev) => [...prev, userTemp, assistantTemp]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: text, timezone: timezone() }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }

      for await (const event of readEvents(res.body)) {
        switch (event.type) {
          case "meta":
            setConversationId(event.conversationId);
            setMessages((prev) => prev.map((m) => (m.id === userTemp.id ? { ...m, id: event.userMessageId } : m)));
            break;
          case "status":
            setStatus(event.text);
            break;
          case "sources":
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantTemp.id ? { ...m, citations: event.sources } : m)),
            );
            break;
          case "delta":
            setStatus(null);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantTemp.id ? { ...m, content: m.content + event.text } : m)),
            );
            break;
          case "done":
            setMessages((prev) => prev.map((m) => (m.id === assistantTemp.id ? { ...m, id: event.messageId } : m)));
            break;
          case "error":
            setError(event.message);
            setMessages((prev) => prev.filter((m) => !(m.id === assistantTemp.id && m.content === "")));
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Request failed");
        setMessages((prev) => prev.filter((m) => !(m.id === assistantTemp.id && m.content === "")));
      }
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;
      void loadConversations();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Chat Agent</h1>
          <button className="primary" onClick={newConversation} disabled={busy}>
            New chat
          </button>
          <a className="memory-link" href="/memory">
            What I remember
          </a>
        </header>
        <nav aria-label="Conversations">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conv ${c.id === conversationId ? "active" : ""}`}
              onClick={() => void openConversation(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </nav>
        {quota && <QuotaLine quota={quota} />}
      </aside>

      <main className="main">
        <div className="thread">
          <div className="thread-inner">
            {messages.length === 0 && (
              <p className="empty">Ask anything. I can search the web and remember what we discussed.</p>
            )}
            {messages.map((m) =>
              m.role === "assistant" && m.content === "" ? null : (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === "assistant" ? <Markdown text={m.content} citeBase={`src-${m.id}`} /> : m.content}
                  {m.citations && m.citations.length > 0 && <Sources citations={m.citations} anchorBase={`src-${m.id}`} />}
                  {m.createdAt && (
                    <span className="time">{new Date(m.createdAt).toLocaleString()}</span>
                  )}
                </div>
              ),
            )}
            {status && <div className="status" aria-live="polite">{status}</div>}
            {error && <div className="error" role="alert">{error}</div>}
            <div ref={threadEnd} />
          </div>
        </div>

        <div className="composer">
          <form onSubmit={(e) => void send(e)}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)"
              rows={1}
              aria-label="Message"
            />
            <button className="primary" type="submit" disabled={busy || input.trim() === ""}>
              Send
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

function Sources({ citations, anchorBase }: { citations: Citation[]; anchorBase: string }) {
  return (
    <ol className="sources" aria-label="Sources">
      {citations.map((c) => (
        <li key={c.n} value={c.n} id={`${anchorBase}-${c.n}`}>
          <a href={c.url} target="_blank" rel="noopener noreferrer">
            {c.title}
          </a>
          <span className="domain"> · {hostname(c.url)}</span>
          {c.publishedAt && <span className="domain"> · {new Date(c.publishedAt).toLocaleDateString()}</span>}
        </li>
      ))}
    </ol>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "Free quota today": search credits and the first configured model, so limits are never a surprise. */
function QuotaLine({ quota }: { quota: QuotaStatus }) {
  const model = quota.models.find((m) => m.configured);
  return (
    <footer className="quota" title="Free-tier usage today (UTC)">
      <div>
        Search: {quota.search.configured ? `${quota.search.usedToday}/${quota.search.dailyLimit} today` : "no key set"}
      </div>
      {model ? (
        <div className={model.nearLimit ? "warn" : undefined}>
          {model.label.split(":")[1]}: {model.usedToday}
          {model.dailyLimit ? `/${model.dailyLimit}` : ""} today{model.nearLimit ? " (near limit, using backups)" : ""}
        </div>
      ) : (
        <div className="warn">No model key set</div>
      )}
    </footer>
  );
}
