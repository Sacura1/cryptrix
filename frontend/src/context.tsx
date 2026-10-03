import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Context as ReactContext } from 'react';
import type { Address, Hex, EIP1193Provider } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import { api, message } from './lib/api';
import { guardTransaction } from './lib/guards';
import type { Config, Transaction } from './types';

type Provider = EIP1193Provider & {
  on?: (event: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
};
interface Choice {
  name: string;
  id: string;
  provider: Provider;
  practice?: boolean;
}
interface Session {
  token: string;
  owner: string;
  expiresAt: number;
}
interface AppContext {
  config?: Config;
  configError: string;
  retryConfig: () => void;
  session?: Session;
  connecting: boolean;
  connectError: string;
  choices: Choice[];
  connect: (choice: Choice) => Promise<void>;
  disconnect: () => void;
  practiceWallet: boolean;
  transact: (tx: Transaction, onHash: (hash: string) => void) => Promise<string>;
  notify: (text: string) => void;
}
// Preserve context identity across development hot updates; production uses a fresh context.
const Context: ReactContext<AppContext> =
  import.meta.hot?.data.context ?? createContext<AppContext>(null!);
if (import.meta.hot) import.meta.hot.data.context = Context;
export const useApp = () => useContext(Context);
declare global {
  interface Window {
    ethereum?: Provider;
  }
}
export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config>();
  const [configError, setConfigError] = useState('');
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<Session>();
  const [provider, setProvider] = useState<Provider>();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [practiceWallet, setPracticeWallet] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    let alive = true;
    api<Config>('/config')
      .then((c) => {
        if (alive) {
          setConfig(c);
          setConfigError('');
        }
      })
      .catch((e) => {
        if (alive) setConfigError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  useEffect(() => {
    const announce = (e: Event) => {
      const d = (e as CustomEvent<{ info: { name: string; uuid: string }; provider: Provider }>)
        .detail;
      if (d?.provider)
        setChoices((old) =>
          old.some((c) => c.id === d.info.uuid)
            ? old
            : [...old, { name: d.info.name, id: d.info.uuid, provider: d.provider }],
        );
    };
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    if (window.ethereum)
      setChoices((old) =>
        old.some((c) => c.provider === window.ethereum)
          ? old
          : [...old, { name: 'Browser wallet', id: 'injected', provider: window.ethereum! }],
      );
    return () => window.removeEventListener('eip6963:announceProvider', announce);
  }, []);
  useEffect(() => {
    let alive = true;
    if (
      import.meta.env.DEV &&
      import.meta.env.VITE_ENABLE_DEV_WALLET === 'true' &&
      config?.mode === 'practice' &&
      ['localhost', '127.0.0.1'].includes(location.hostname)
    ) {
      void import('viem/accounts').then(({ generatePrivateKey, privateKeyToAccount }) => {
        if (!alive) return;
        const account = privateKeyToAccount(generatePrivateKey());
        const local = {
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts')
              return [account.address];
            if (method === 'personal_sign') {
              const p = params as string[];
              return account.signMessage({ message: { raw: p[0] as Hex } });
            }
            throw new Error('The local practice wallet cannot send transactions.');
          },
        } as Provider;
        setChoices((old) => [
          ...old.filter((c) => !c.practice),
          { name: 'Local practice wallet', id: 'local-practice', provider: local, practice: true },
        ]);
      });
    }
    return () => {
      alive = false;
    };
  }, [config]);
  useEffect(() => {
    if (!provider) return;
    const changed = () => {
      setSession(undefined);
      setProvider(undefined);
      setPracticeWallet(false);
    };
    provider.on?.('accountsChanged', changed);
    provider.on?.('disconnect', changed);
    return () => {
      provider.removeListener?.('accountsChanged', changed);
      provider.removeListener?.('disconnect', changed);
    };
  }, [provider]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession(undefined);
        setProvider(undefined);
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function connect(choice: Choice) {
    setConnecting(true);
    setConnectError('');
    try {
      const { createWalletClient, custom } = await import('viem');
      const client = createWalletClient({ transport: custom(choice.provider) });
      const [address] = await client.requestAddresses();
      if (!address) throw new Error('Select an account in your wallet.');
      const challenge = await api<{ challengeId: string; message: string }>(
        '/auth/challenge',
        undefined,
        { wallet: address },
      );
      const signature = await client.signMessage({ account: address, message: challenge.message });
      const result = await api<Session>('/auth/verify', undefined, {
        challengeId: challenge.challengeId,
        signature,
      });
      setSession(result);
      setProvider(choice.provider);
      setPracticeWallet(!!choice.practice);
    } catch (e) {
      setConnectError(message(e));
    } finally {
      setConnecting(false);
    }
  }
  function disconnect() {
    if (session) void api('/auth/logout', session.token, {}).catch(() => {});
    setSession(undefined);
    setProvider(undefined);
    setPracticeWallet(false);
  }
  async function transact(tx: Transaction, onHash: (hash: string) => void) {
    guardTransaction(tx, config, session?.owner, practiceWallet);
    if (!provider || !session) throw new Error('Reconnect your owner wallet.');
    const { createWalletClient, createPublicClient, custom, http } = await import('viem');
    const chain = tx.chainId === 5042 ? arc : arcTestnet;
    const rpc = chain.rpcUrls.default.http[0];
    const wallet = createWalletClient({ transport: custom(provider), chain });
    try {
      await wallet.switchChain({ id: chain.id });
    } catch (e) {
      if ((e as { code?: number }).code === 4902) {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      } else throw e;
    }
    const accounts = await wallet.getAddresses();
    if (accounts[0]?.toLowerCase() !== session.owner.toLowerCase())
      throw new Error('The selected wallet account changed. Reconnect.');
    const publicClient = createPublicClient({ chain, transport: http(rpc) });
    const request = {
      account: session.owner as Address,
      to: tx.to as Address,
      data: tx.data,
      value: 0n,
    };
    await publicClient.estimateGas(request);
    const gasPrice = await publicClient.getGasPrice();
    const maxFeePerGas = gasPrice * 2n > 20_000_000_000n ? gasPrice * 2n : 20_000_000_000n;
    if (maxFeePerGas > 100_000_000_000n)
      throw new Error('Estimated gas price exceeds the UI fee ceiling. Try again when fees fall.');
    const hash = await wallet.sendTransaction({
      ...request,
      maxFeePerGas,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    onHash(hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success')
      throw new Error('Transaction reverted. No successful operation should be assumed.');
    return hash;
  }
  return (
    <Context.Provider
      value={{
        config,
        configError,
        retryConfig: () => setRevision((v) => v + 1),
        session,
        connecting,
        connectError,
        choices,
        connect,
        disconnect,
        practiceWallet,
        transact,
        notify: setToast,
      }}
    >
      {children}
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </Context.Provider>
  );
}
