'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { useVaultLock } from '@/hooks/use-vault-lock';
import { PinLockScreen } from '@/components/pin-lock-screen';
import { PinSetupScreen } from '@/components/pin-setup-screen';
import { SecureContextScreen } from '@/components/secure-context-screen';
import { isLoginPath } from '@/hooks/useSync';

/**
 * Client boundary that wraps app children with the PIN vault lock: it encrypts
 * the offline data; setup is forced before any app content, unlock is required
 * on every open (Sicherheitskonzept Offline-Daten, P1).
 *
 * When locked, the children container receives the HTML `inert` attribute so
 * the underlying content is unreachable via keyboard, pointer, and screen
 * readers — not merely visually covered by the overlay.
 *
 * /login and /share stay outside the vault gate: the login page must be
 * reachable to bootstrap a fresh device, and share links are public pages —
 * neither renders journal content from the encrypted stores.
 */
function isVaultExemptPath(pathname: string | null): boolean {
  return isLoginPath(pathname) || (pathname?.startsWith('/share') ?? false);
}

const emptySubscribe = () => () => {};

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const vault = useVaultLock();
  const pathname = usePathname();
  const exempt = isVaultExemptPath(pathname);

  // Cold start vs. runtime lock: before the FIRST unlock the children stay
  // unmounted — their load effects would run against the locked adapter,
  // reject, and leave dead empty views behind the overlay. Once unlocked, a
  // later auto-lock only makes the children inert: unmounting would destroy
  // live state (editor text between autosaves).
  const [everUsable, setEverUsable] = useState(false);
  useEffect(() => {
    if (vault.status === 'unlocked' || vault.status === 'none') setEverUsable(true);
  }, [vault.status]);

  // Vault P2: WebCrypto only exists in secure contexts — over plain HTTP the
  // PIN setup/unlock would fail with a cryptic TypeError. isSecureContext is
  // fixed for the page's lifetime, so an empty subscription suffices; the
  // server snapshot assumes secure and hydration corrects it.
  const secureContext = useSyncExternalStore(
    emptySubscribe,
    () => window.isSecureContext,
    () => true
  );

  const vaultOverlay = exempt ? null : !secureContext ? (
    <SecureContextScreen />
  ) : (
    vault.status === 'loading' ? (
      // Shield until the vault status is known — otherwise decrypted content
      // could flash before the lock screen mounts.
      <div className="fixed inset-0 z-[9998] bg-background" aria-hidden />
    ) : vault.status === 'none' ? (
      <PinSetupScreen onSetup={vault.setup} />
    ) : vault.status === 'locked' ? (
      <PinLockScreen onUnlock={vault.unlock} onReset={vault.resetAll} />
    ) : null
  );

  const anyLock = vaultOverlay !== null;
  const mountChildren = exempt || everUsable;

  return (
    <>
      {/* inert removes keyboard/AT access to children while a lock is active */}
      <div inert={anyLock || undefined}>
        {mountChildren ? children : null}
      </div>
      {vaultOverlay}
    </>
  );
}
