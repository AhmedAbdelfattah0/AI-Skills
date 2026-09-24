function escapeIdentifier(value) {
  return String(value).replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, digit) => digit ? `\\3${digit} ` : `\\${match}`);
}

/**
 * Build a CSS path from leaf-to-root descriptors. A unique id terminates the
 * path; otherwise nth-of-type disambiguates same-tag siblings.
 */
export function selectorPathFromChain(chain) {
  const parts = [];
  for (const node of chain) {
    if (node.id && node.idUnique) {
      parts.unshift(`#${escapeIdentifier(node.id)}`);
      break;
    }
    const tag = String(node.tag || '*').toLowerCase();
    parts.unshift(node.sameTagCount > 1 ? `${tag}:nth-of-type(${node.sameTagIndex})` : tag);
  }
  return parts.join(' > ');
}

export function selectorChainsFromHtml(html) {
  const root = { tag: 'html', id: '', children: [], parent: null };
  const stack = [root];
  const nodes = [];
  for (const match of String(html).matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
    const closing = match[0][1] === '/';
    const tag = match[1].toLowerCase();
    if (closing) {
      while (stack.length > 1 && stack.at(-1).tag !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1] ?? '';
    const node = { tag, id, children: [], parent: stack.at(-1) };
    node.parent.children.push(node);
    nodes.push(node);
    if (!/\/$/.test(match[0]) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) stack.push(node);
  }
  const idCounts = new Map();
  for (const node of nodes) if (node.id) idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  return nodes.map((node) => {
    const chain = [];
    for (let current = node; current; current = current.parent) {
      const peers = current.parent?.children.filter((peer) => peer.tag === current.tag) ?? [current];
      chain.push({ tag: current.tag, id: current.id, idUnique: Boolean(current.id && idCounts.get(current.id) === 1),
        sameTagCount: peers.length, sameTagIndex: peers.indexOf(current) + 1 });
    }
    return selectorPathFromChain(chain);
  });
}
