/**
 * Single source of "now" for the whole app.
 * AGENT_NOW freezes time so dated scenarios ("last Tuesday") are reproducible in tests and demos.
 * Read on every call (not cached) so tests and the seed endpoint can change it at runtime.
 */
export function now(): Date {
  const fixed = process.env.AGENT_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`AGENT_NOW is not a valid ISO date: "${fixed}"`);
    }
    return d;
  }
  return new Date();
}

/** Returns the timezone if it is a valid IANA name, otherwise undefined. */
export function validTimezone(tz: unknown): string | undefined {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}
