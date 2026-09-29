// The console's few number and time formats, in the wireframes' voice: "6 min",
// "6:40 pm", "$1.84", "2 h 20 m".

export function clock(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s/g, " ");
}

export function clockSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** "6 min", "42 min", "2 h", "3 days" — how long something has waited. */
export function waited(fromIso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(fromIso));
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** "5 min ago", or "just now" — never "just now ago". */
export function ago(fromIso: string, now = Date.now()): string {
  const w = waited(fromIso, now);
  return w === "just now" ? w : `${w} ago`;
}

/** "2 h 20 m" — a span, for the quota strip. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} m` : `${m} m`;
}

/** "1 m 12 s" — elapsed, for a phase. */
export function elapsed(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} m ${s % 60} s` : `${s} s`;
}

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return `$${usd.toFixed(2)}`;
}

/** "one", "two", … "nine", then digits — how the wireframes write small counts. */
export function words(n: number): string {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function formatAgo(iso: string): string {
  return `${waited(iso)} ago`;
}
