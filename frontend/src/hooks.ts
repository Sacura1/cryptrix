import { useEffect, useState, useCallback } from 'react';
import { api, message } from './lib/api';
export function useResource<T>(path: string | null, token?: string, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let alive = true,
      pending = false;
    setData(undefined);
    setError('');
    setLoading(!!path);
    const load = async () => {
      if (!path || pending) return;
      pending = true;
      try {
        const result = await api<T>(path, token);
        if (alive) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (alive) setError(message(e));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = interval ? window.setInterval(load, interval) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, token, interval, version]);
  return { data, error, loading, refresh, setData };
}
