function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function timestamp(t: number = Date.now()): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
