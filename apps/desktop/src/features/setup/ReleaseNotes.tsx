import type { ReactNode } from "react";

// Only what release-notes.md uses: headings, bullets (wrapped lines indented under them),
// paragraphs, **bold** and `code`. Built as elements, never as HTML, so the notes cannot
// carry markup in (#277).
const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
    : part);

export const ReleaseNotes = ({ text }: { text: string }) => {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    items = [];
    para = [];
  };
  for (const line of text.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (heading) {
      flush();
      blocks.push(heading[1].length < 3 ? <h4 key={blocks.length}>{inline(heading[2])}</h4> : <h5 key={blocks.length}>{inline(heading[2])}</h5>);
    } else if (bullet) {
      if (para.length) flush();
      items.push(bullet[1]);
    } else if (!line.trim()) {
      flush();
    } else if (items.length && /^\s/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      if (items.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <>{blocks}</>;
};
