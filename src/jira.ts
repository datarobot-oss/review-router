export function extractTicketIds(title: string): string[] {
  return [...title.matchAll(/\[([A-Z][A-Z0-9]*-\d+)\]/g)].map((m) => m[1]);
}
