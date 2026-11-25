export function Logo({ size = 28 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo.svg" width={size} height={size} alt="WhereTo" className="shrink-0" />;
}

export const APP_NAME = "WhereTo";
export const TAGLINE = "Your perfect Saturday, planned around your mood, budget & time.";
