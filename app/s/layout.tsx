import type { Metadata } from "next";

// The plan itself lives in the URL fragment (never sent to servers), so the preview for a shared link is a
// generic branded card rather than plan-specific. Nested openGraph/twitter objects replace (not merge with)
// the root ones, so the image is named explicitly.
const title = "A Saturday plan on WhereTo";
const description = "Open to see the schedule, map and directions.";
const image = { url: "/opengraph-image.png", width: 1200, height: 630, alt: "WhereTo: your perfect Saturday, planned" };

export const metadata: Metadata = {
  title: "A Saturday plan",
  description: "Someone shared a day plan made with WhereTo. Open it to see the schedule, map and directions.",
  openGraph: { type: "website", siteName: "WhereTo", title, description, images: [image] },
  twitter: { card: "summary_large_image", title, description, images: [image.url] },
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
