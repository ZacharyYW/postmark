import { useCallback, useEffect, useState } from 'preact/hooks';
import { browserHostPermissions, GMAIL_PATTERN, type HostPermissions } from '../permissions';
import s from './PermissionsBanner.module.css';

function describe(missing: string[]): string {
  const gmail = missing.includes(GMAIL_PATTERN);
  const server = missing.some((p) => p !== GMAIL_PATTERN);
  if (gmail && server) return 'Postmark can’t access Gmail or your Postmark server.';
  if (gmail) return 'Postmark can’t access Gmail, so tracking isn’t offered when you compose.';
  return 'Postmark can’t reach your Postmark server.';
}

/**
 * Shown only when a required host permission is missing (in practice: Firefox, where the user
 * can withhold them). `onGrant` overrides the button, e.g. the popup sends people to Options.
 */
export function PermissionsBanner({
  serverUrl,
  permissions = browserHostPermissions,
  onGrant,
  onGranted,
}: {
  serverUrl: string;
  permissions?: HostPermissions;
  onGrant?: () => void;
  onGranted?: () => void;
}) {
  const [missing, setMissing] = useState<string[]>([]);
  const [denied, setDenied] = useState(false);

  const check = useCallback(async () => {
    setMissing(await permissions.missing(serverUrl));
  }, [permissions, serverUrl]);

  useEffect(() => void check(), [check]);

  if (missing.length === 0) return null;

  const grant = async () => {
    if (onGrant) return onGrant();
    const ok = await permissions.request(missing);
    setDenied(!ok);
    await check();
    if (ok) onGranted?.();
  };

  return (
    <div class={s.banner} role="alert" data-state="needs-permission">
      <p>
        {describe(missing)} {denied && <span>Permission wasn’t granted. </span>}
      </p>
      <button class={s.grant} onClick={() => void grant()}>
        {onGrant ? 'Fix in settings' : 'Grant access'}
      </button>
    </div>
  );
}
