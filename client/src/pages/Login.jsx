import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { user, loading, login } = useAuth();
  const [email, setEmail] = useState('admin@aiunika.com');
  const [password, setPassword] = useState('Admin123!');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="boot">Opening the board…</div>;
  if (user) return <Navigate to="/" replace />;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <aside className="login-aside">
        <div>
          <div className="brand light">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="brand-name">Kanabana</span>
          </div>
          <h1>The office board, with a name on every card.</h1>
          <p>
            Each person signs in and sees their week. When someone finishes a step and names who takes the next one,
            that work shows up on the next person’s board.
          </p>
        </div>
        <p className="aside-foot">Projects can cross teams. Team leads can move a timeline, and they have to say why.</p>
      </aside>
      <section className="login-panel">
        <div className="login-card">
          <h2>Sign in</h2>
          <form className="stack" onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p className="hint">Admin sign-in is admin@aiunika.com. Change that password after you sign in. New people are added from Directory.</p>
        </div>
      </section>
    </div>
  );
}
