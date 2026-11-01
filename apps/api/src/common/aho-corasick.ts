/**
 * Aho-Corasick 多模式匹配。
 * 用于语料入库时的实体召回：20 万实体名 + 别名 → 扫一遍正文 → article_hit 倒排表。
 * 不依赖搜索引擎，单次 O(正文长度 + 命中数)。
 */

interface Node {
  next: Map<string, Node>;
  fail: Node | null;
  out: { entityId: number; pattern: string }[];
}

export interface AcHit {
  entityId: number;
  pattern: string;
  /** 命中起始偏移（字符索引） */
  start: number;
  end: number;
}

export class AhoCorasick {
  private root: Node = { next: new Map(), fail: null, out: [] };
  private built = false;

  addPattern(pattern: string, entityId: number): void {
    if (!pattern) return;
    let node = this.root;
    for (const ch of pattern) {
      let next = node.next.get(ch);
      if (!next) {
        next = { next: new Map(), fail: null, out: [] };
        node.next.set(ch, next);
      }
      node = next;
    }
    node.out.push({ entityId, pattern });
  }

  build(): this {
    const queue: Node[] = [];
    for (const child of this.root.next.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length) {
      const current = queue.shift() as Node;
      for (const [ch, child] of current.next) {
        let fail = current.fail as Node;
        while (fail && !fail.next.has(ch)) fail = fail.fail as Node;
        child.fail = fail ? (fail.next.get(ch) as Node) : this.root;
        if (!child.fail) child.fail = this.root;
        child.out = child.out.concat(child.fail.out);
        queue.push(child);
      }
    }
    this.built = true;
    return this;
  }

  /** 扫描文本，返回全部命中（含重叠） */
  search(text: string): AcHit[] {
    if (!this.built) this.build();
    const hits: AcHit[] = [];
    let node = this.root;
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      while (node !== this.root && !node.next.has(ch)) node = node.fail as Node;
      node = node.next.get(ch) ?? this.root;
      for (const o of node.out) {
        hits.push({ entityId: o.entityId, pattern: o.pattern, start: i - o.pattern.length + 1, end: i + 1 });
      }
    }
    return hits;
  }

  /** 扫描文本，按实体聚合：命中次数 + 首次偏移 + 命中别名 */
  summarize(text: string): Map<number, { hitCount: number; firstOffset: number; matchedAlias: string }> {
    const agg = new Map<number, { hitCount: number; firstOffset: number; matchedAlias: string }>();
    for (const h of this.search(text)) {
      const cur = agg.get(h.entityId);
      if (!cur) {
        agg.set(h.entityId, { hitCount: 1, firstOffset: h.start, matchedAlias: h.pattern });
      } else {
        cur.hitCount += 1;
        if (h.start < cur.firstOffset) {
          cur.firstOffset = h.start;
          cur.matchedAlias = h.pattern;
        }
      }
    }
    return agg;
  }
}
