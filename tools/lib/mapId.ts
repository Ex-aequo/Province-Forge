// Content address of a map: sha256 of the static JSON without the parts that change
// from run to run (creation time, generator timings). Same generator + same params
// → same mapId, so bundles are deduplicated and caches stay valid.
import { createHash } from 'node:crypto';

export function mapContentId(exp: { createdAt?: string; stats?: object }): string {
  const { createdAt: _c, ...rest } = exp;
  const stats = rest.stats ? { ...rest.stats, timings: undefined } : undefined;
  return createHash('sha256').update(JSON.stringify({ ...rest, stats })).digest('hex').slice(0, 16);
}
