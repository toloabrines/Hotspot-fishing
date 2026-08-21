import { ADMIN_EMAILS } from "@/lib/modules";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomInviteCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

export function assertInviteAdmin(email: unknown): void {
  const normalizedEmail = typeof email === "string" ? email.toLowerCase() : "";
  if (!ADMIN_EMAILS.includes(normalizedEmail)) {
    throw new Error("Sólo administración puede gestionar códigos");
  }
}
