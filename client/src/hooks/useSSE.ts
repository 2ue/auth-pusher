import { useEffect, useRef, useState } from 'react';

export function useSSE<T = unknown>(url: string | null, onMessage: (data: T) => void) {
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as T;
        cbRef.current(data);
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      setConnected(false);
      es.close();
    };
    return () => { es.close(); setConnected(false); };
  }, [url]);

  return { connected };
}
