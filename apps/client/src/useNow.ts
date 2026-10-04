// A clock for local countdowns (phone and big screen).
import { useEffect, useState } from 'react';

/** performance.now(), updated a few times a second while `running`. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(id);
  }, [running]);
  return now;
}
