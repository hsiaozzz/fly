import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokens = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s()]+\)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`"))
      nodes.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**"))
      nodes.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    else {
      const link = token.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      try {
        const url = new URL(link[2]);
        nodes.push(
          ["https:", "http:"].includes(url.protocol) ? (
            <a
              key={match.index}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link[1]}
            </a>
          ) : (
            token
          )
        );
      } catch {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Small chat renderer: all content is React text, including raw HTML. */
export default function ChatMarkdown({ children }: { children: string }) {
  const lines = children.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let position = 0;
  while (position < lines.length) {
    const line = lines[position];
    if (!line.trim()) {
      position += 1;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)([\w-]*)\s*$/);
    if (fence) {
      const start = position++;
      const code: string[] = [];
      while (position < lines.length && lines[position].trim() !== fence[1])
        code.push(lines[position++]);
      if (position < lines.length) position += 1;
      blocks.push(
        <pre key={start}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push(<h4 key={position++}>{inline(heading[1])}</h4>);
      continue;
    }
    const listItem = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const start = position,
        ordered = !listItem[1];
      const items: ReactNode[] = [];
      while (position < lines.length) {
        const item = lines[position].match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
        if (!item) break;
        const itemIsOrdered = !item[1];
        if (itemIsOrdered !== ordered) break;
        items.push(<li key={position++}>{inline(item[2])}</li>);
      }
      blocks.push(
        ordered ? <ol key={start}>{items}</ol> : <ul key={start}>{items}</ul>
      );
      continue;
    }
    const start = position;
    const paragraph: string[] = [];
    do {
      paragraph.push(lines[position++]);
    } while (
      position < lines.length &&
      lines[position].trim() &&
      !/^\s*(?:```|~~~|#{1,6}\s|[-*]\s|\d+[.)]\s)/.test(lines[position])
    );
    blocks.push(
      <p key={start}>
        {paragraph.map((text, index) => (
          <Fragment key={index}>
            {index > 0 && <br />}
            {inline(text)}
          </Fragment>
        ))}
      </p>
    );
  }
  return <div className="chat-markdown">{blocks}</div>;
}
