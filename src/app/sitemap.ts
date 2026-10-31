import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://thesma.vercel.app";

/** Public, no-login surfaces only. App internals stay out of the index. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/start`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/markets`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/demo`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/security`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.4 },
  ];
}
