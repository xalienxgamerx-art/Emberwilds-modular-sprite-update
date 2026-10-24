/**
 * Two-generation cache aging for pure, seeded queries.
 *
 * The world's per-seed queries (tiles, height levels, objects) are pure
 * functions of the seed — their caches never need invalidation, only size
 * control. The old scheme cleared the whole map at a size cap, which threw
 * away the hot working set around the player and forced an expensive
 * recompute storm after every overflow. This cache instead promotes hits
 * from the previous generation into the current one, so the hot neighborhood
 * always survives an overflow while total memory stays bounded (2× the cap).
 */
export class TwoGenCache<V> {
  private cur = new Map<number, V>();
  private prev = new Map<number, V>();

  constructor(private readonly max: number) {}

  /** The cached value, or undefined when absent (never for stored nulls). */
  get(key: number): V | undefined {
    const v = this.cur.get(key);
    if (v !== undefined) return v;
    const p = this.prev.get(key);
    if (p !== undefined) {
      // a hit from the last generation is hot: promote it so the next
      // overflow keeps it
      this.prev.delete(key);
      this.cur.set(key, p);
      return p;
    }
    return undefined;
  }

  set(key: number, value: V): void {
    this.prev.delete(key);
    if (this.cur.size >= this.max) {
      this.prev = this.cur;
      this.cur = new Map();
    }
    this.cur.set(key, value);
  }

  /** Drops everything — for the rare caller whose cache is keyed by world seed. */
  clear(): void {
    this.cur.clear();
    this.prev.clear();
  }
}
