// A single AdSense ad slot. Renders NOTHING unless ALL of:
//   - AdSense is configured (ADSENSE_CLIENT set in lib/ads.ts), AND
//   - the user isn't premium (premium = ad-free), AND
//   - cookie consent isn't denied (PDPA / Consent Mode).
// So today (no client id) it's inert everywhere. Place only on browse surfaces.

import { useEffect, useRef } from "react";
import { ADSENSE_CLIENT, isAdSenseConfigured, loadAdSense } from "../lib/ads";
import { useConsent } from "../lib/consent";
import { usePremium } from "../lib/premium";

export function AdUnit({ slot, className }: { slot: string; className?: string }) {
  const consent = useConsent();
  const premium = usePremium();
  const ref = useRef<HTMLModElement>(null);
  const show = isAdSenseConfigured() && !premium && consent !== "denied";

  useEffect(() => {
    if (!show) return;
    loadAdSense();
    try {
      const w = window as unknown as { adsbygoogle?: unknown[] };
      (w.adsbygoogle = w.adsbygoogle || []).push({});
    } catch {
      /* adsbygoogle not ready / blocked — silent */
    }
  }, [show, slot]);

  if (!show) return null;

  return (
    <ins
      ref={ref}
      className={`adsbygoogle block ${className ?? ""}`}
      style={{ display: "block" }}
      data-ad-client={ADSENSE_CLIENT}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}
