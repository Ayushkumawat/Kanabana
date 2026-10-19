import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearToken, getToken, setToken } from './api';

const AuthContext = createContext(null);
const ToastContext = createContext(() => {});

export function useAuth() {
  return useContext(AuthContext);
}

export function useToast() {
  return useContext(ToastContext);
}

export function AppState({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return undefined;
    }
    let cancel = false;
    api('/me')
      .then((data) => {
        if (!cancel) setUser(data.user);
      })
      .catch(() => {
        clearToken();
        if (!cancel) setUser(null);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const toast = useCallback((message, tone = 'ok') => {
    const toastId = crypto.randomUUID();
    setToasts((list) => [...list, { id: toastId, message, tone }]);
    setTimeout(() => {
      setToasts((list) => list.filter((item) => item.id !== toastId));
    }, 3600);
  }, []);

  const auth = useMemo(() => ({
    user,
    loading,
    setUser,
    async login(email, password) {
      const data = await api('/login', { method: 'POST', body: { email, password } });
      setToken(data.token);
      setUser(data.user);
      return data.user;
    },
    logout() {
      clearToken();
      setUser(null);
    },
    async refresh() {
      const data = await api('/me');
      setUser(data.user);
      return data.user;
    },
  }), [user, loading]);

  return (
    <AuthContext.Provider value={auth}>
      <ToastContext.Provider value={toast}>
        {children}
        <div className="toasts" aria-live="polite">
          {toasts.map((item) => (
            <div key={item.id} className={`toast ${item.tone}`}>{item.message}</div>
          ))}
        </div>
      </ToastContext.Provider>
    </AuthContext.Provider>
  );
}
