// Premium entitlement (remove-ads + future perks).
//
// Standalone, local-only for now: a flag in localStorage. Ads (GearCTA + the
// AdSense AdUnit) are gated on `!isPremium`, so when a real purchase flow lands
// (a payment processor like Omise sets this flag — ideally synced via the
// signed-in cloud doc), monetization gating already works end-to-end.
//
// ⚠️ There is no purchase flow yet, so this is not user-settable in production
// (the upsell sheet's CTA is a "coming soon" placeholder). A DEV-only toggle in
// PremiumSheet lets the owner preview the ad-free state locally.

import { useEffect, useState } from "react";

const KEY = "premium";
const EVENT = "premium-change";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let cache = read();

export function isPremium(): boolean {
  return cache;
}

export function setPremium(v: boolean) {
  cache = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function usePremium(): boolean {
  const [v, setV] = useState(cache);
  useEffect(() => {
    const f = () => setV(cache);
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return v;
}
