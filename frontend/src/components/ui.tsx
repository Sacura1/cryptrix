import { Usdc } from './Usdc';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { message } from '../lib/api';
import { short, type Plan } from '../types';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    wallet: (
      <>
        <path d="M20 8H4V5h14v3M4 8v12h16V8M15 12h6v4h-6z" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    play: <path d="m8 4 12 8-12 8z" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c6 6 6 12 0 18-6-6-6-12 0-18" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    stats: <><path d="M4 20h16M7 16V9M12 16V4M17 16v-5" /></>,
    sound: (
      <>
        <path d="m3 9 5 0 5-5v16l-5-5H3zM17 8c3 2 3 6 0 8" />
      </>
    ),
    expand: <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" />,
    check: <path d="m5 12 4 4L20 5" />,
    bot: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <path d="M12 7V3M9 3h6M8 12v2M16 12v2M9 17h6" />
      </>
    ),
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M19 11a7 7 0 0 0-12-5M5 13a7 7 0 0 0 12 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.arrow}
    </svg>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    document.body.style.overflow = 'hidden';
    const element = ref.current;
    element?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') {
        const items = element?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        );
        if (!items?.length) {
          e.preventDefault();
          return;
        }
        const first = items[0],
          last = items[items.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === element)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', key);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="section-top">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div role="alert" className="error-box">
      <strong>We couldn’t complete that.</strong>
      <p>{error}</p>
      {retry && (
        <button className="button small secondary" onClick={retry}>
          Try again <Icon name="refresh" size={16} />
        </button>
      )}
    </div>
  );
}
export function Loading({ text = 'Getting the latest…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">
        <Icon name="bot" size={32} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Copy({ value, label = 'Copy' }: { value: string; label?: string }) {
  const { notify } = useApp();
  return (
    <button
      className="button small secondary"
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(() => notify('Copied to clipboard.'))
          .catch(() => notify('Clipboard access is unavailable. Select and copy the text.'))
      }
    >
      <Icon name="copy" size={16} />
      {label}
    </button>
  );
}
export function PageHeading({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
