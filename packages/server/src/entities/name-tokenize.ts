export function tokenizeName(name: string): string[] {
  return stripDomainSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function stripDomainSuffix(value: string): string {
  return value.trim().replace(/\.(com|org|net|io|ai|co|in|dev|app)\b\.?$/i, "");
}
