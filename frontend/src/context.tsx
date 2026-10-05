import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, message } from './lib/api';
import type { Config } from './types';

const Context = createContext<{
  config?: Config; configError: string; retryConfig: () => void; notify: (text: string) => void;
}>({ configError: '', retryConfig: () => {}, notify: () => {} });
export const useApp = () => useContext(Context);
export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config>();
  const [configError, setError] = useState(''), [revision, setRevision] = useState(0), [toast, setToast] = useState('');
  useEffect(() => {
    let alive = true;
    api<Config>('/config').then(value => { if (alive) { setConfig(value); setError(''); } }).catch(error => { if (alive) setError(message(error)); });
    return () => { alive = false; };
  }, [revision]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  return <Context.Provider value={{ config, configError, retryConfig: () => setRevision(n => n + 1), notify: setToast }}>
    {children}{toast && <div className="toast" role="status">{toast}</div>}
  </Context.Provider>;
}
