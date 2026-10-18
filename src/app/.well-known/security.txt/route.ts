/**
 * GET /.well-known/security.txt — public security contact (RFC 9116).
 * No personal secrets: reports go through the public product surface.
 */
export async function GET() {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://thesma.vercel.app";
  const body = [
    "Contact: https://thesma.vercel.app/security",
    `Canonical: ${base}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "Policy: https://thesma.vercel.app/security",
  ].join("\n");
  return new Response(`${body}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
