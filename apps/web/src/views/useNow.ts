import { useEffect, useState } from "react";

/** Re-render every second so "x seconds ago" stays honest between updates. */
export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
