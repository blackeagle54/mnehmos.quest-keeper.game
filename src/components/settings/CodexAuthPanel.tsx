import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface CodexAuthStatus {
    authenticated: boolean;
    accountId?: string | null;
    expiresAt?: number | null;
    message: string;
}

export const CodexAuthPanel: React.FC = () => {
    const [status, setStatus] = useState<CodexAuthStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refreshStatus = async () => {
        try {
            const next = await invoke<CodexAuthStatus>('codex_auth_status');
            setStatus(next);
        } catch (err: any) {
            setError(err?.message || String(err));
        }
    };

    useEffect(() => {
        refreshStatus();
    }, []);

    const authenticate = async () => {
        setBusy(true);
        setError(null);
        try {
            const next = await invoke<CodexAuthStatus>('codex_authenticate');
            setStatus(next);
        } catch (err: any) {
            setError(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const logout = async () => {
        setBusy(true);
        setError(null);
        try {
            const next = await invoke<CodexAuthStatus>('codex_logout');
            setStatus(next);
        } catch (err: any) {
            setError(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const expiresAt = status?.expiresAt
        ? new Date(status.expiresAt).toLocaleString()
        : null;

    return (
        <div className="space-y-3 rounded border border-terminal-green-dim bg-black/40 p-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-bold text-terminal-green">CODEX OAUTH</div>
                    <div className="text-xs text-terminal-green-dim">
                        {status?.authenticated ? 'Подключено' : 'Не подключено'}
                        {status?.accountId ? ` · ${status.accountId}` : ''}
                    </div>
                    {expiresAt && (
                        <div className="text-xs text-terminal-green-dim">Истекает: {expiresAt}</div>
                    )}
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={authenticate}
                        disabled={busy}
                        className="rounded border border-terminal-green px-3 py-2 text-xs font-bold text-terminal-green hover:bg-terminal-green/10 disabled:opacity-50"
                    >
                        {status?.authenticated ? 'ПЕРЕПОДКЛЮЧИТЬ' : 'ПОДКЛЮЧИТЬ'}
                    </button>
                    {status?.authenticated && (
                        <button
                            type="button"
                            onClick={logout}
                            disabled={busy}
                            className="rounded border border-red-500/70 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                            ВЫЙТИ
                        </button>
                    )}
                </div>
            </div>
            {busy && <div className="text-xs text-terminal-green-dim">Жду авторизацию в браузере...</div>}
            {error && <div className="text-xs text-red-300">{error}</div>}
        </div>
    );
};
