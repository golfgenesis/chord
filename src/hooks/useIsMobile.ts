import { useEffect, useState } from "react";

// True below Tailwind's `sm` breakpoint (640px) — i.e. the phone layout where
// the TopBar utility buttons are collapsed into the profile menu instead of
// sitting inline. Reactive to viewport resize / device rotation.
const QUERY = "(max-width: 639.98px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(QUERY).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return mobile;
}
