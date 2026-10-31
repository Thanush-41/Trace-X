export class UnionFind<T> {
  private parent = new Map<T, T>();

  add(x: T): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: T): T {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: T, b: T): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  groups(): T[][] {
    const out = new Map<T, T[]>();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      if (!out.has(r)) out.set(r, []);
      out.get(r)!.push(x);
    }
    return [...out.values()];
  }
}
