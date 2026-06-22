// PDPA cookie-consent state (Thailand) + Google Consent Mode v2 bridge.
//
// State lives in localStorage; `null` = undecided (the banner shows). On a
// decision we (a) persist it, (b) push a Consent Mode `update` into dataLayer
// so GA/AdSense honour it, and (c) fire an event so React surfaces re-render.
//
// Pushing the command as a plain array into dataLayer is equivalent to calling
// gtag('consent','update',{…}) and works even if gtag.js hasn't loaded yet
// (it queues). analytics.ts sets the matching `default` (denied unless already
// granted) when it boots, so ordering converges on the stored value.

import { useEffect, useState } from "react";

export type ConsentState = "granted" | "denied";
const KEY = "consent";
const EVENT = "consent-change";

export function getStoredConsent(): ConsentState | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function pushConsentUpdate(state: ConsentState) {
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push([
    "consent",
    "update",
    {
      ad_storage: state,
      ad_user_data: state,
      ad_personalization: state,
      analytics_storage: state,
    },
  ]);
}

export function setConsent(state: ConsentState) {
  try {
    localStorage.setItem(KEY, state);
  } catch {
    /* private mode / quota — consent just won't persist */
  }
  pushConsentUpdate(state);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Reactive consent hook. `null` = undecided → show the banner. */
export function useConsent(): ConsentState | null {
  const [v, setV] = useState<ConsentState | null>(getStoredConsent);
  useEffect(() => {
    const f = () => setV(getStoredConsent());
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return v;
}
