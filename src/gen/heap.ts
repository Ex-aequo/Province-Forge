/** Minimal binary min-heap keyed by float priority, storing integer payloads. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size() { return this.keys.length; }

  push(key: number, val: number) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }

  /** Returns payload of min element; read `lastKey` for its priority. */
  lastKey = 0;
  pop(): number {
    const k = this.keys, v = this.vals;
    const topV = v[0];
    this.lastKey = k[0];
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c];
        i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return topV;
  }
}
