import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { navigate, home } from '../router.js';

export function LoginPage() {
  const { login } = useAuth();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { const u = await login(f.email, f.password); navigate(home(u.role)); }
    catch (x) { setErr(x.message); }
  };
  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Enter the Trials</h1>
        <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>Password<input type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary">Log in</button>
        <p className="muted">New student? <a href="#/register">Register</a></p>
      </form>
    </main>
  );
}

const SKILLS = ['Coding', 'Tech', 'HR'];

export function RegisterPage() {
  const { register } = useAuth();
  const [f, setF] = useState({ name: '', email: '', password: '', regNo: '', branch: '', skills: [] });
  const [errs, setErrs] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (s) => setF({ ...f, skills: f.skills.includes(s) ? f.skills.filter((x) => x !== s) : [...f.skills, s] });

  const submit = async (e) => {
    e.preventDefault();
    const v = {};
    if (!f.name.trim()) v.name = 'Name is required';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) v.email = 'Enter a valid email';
    if (f.password.length < 8) v.password = 'At least 8 characters';
    if (!f.regNo.trim()) v.regNo = 'Registration number is required';
    if (!f.branch.trim()) v.branch = 'Branch is required';
    if (!f.skills.length) v.skills = 'Pick at least one skill';
    setErrs(v);
    if (Object.keys(v).length) return;
    try { const u = await register(f); navigate(home(u.role)); }
    catch (x) { setErrs({ form: x.message }); }
  };
  const field = (k, label, type = 'text') => (
    <label>{label}
      <input type={type} value={f[k]} onChange={set(k)} aria-invalid={!!errs[k]} />
      {errs[k] && <span className="err">{errs[k]}</span>}
    </label>
  );
  return (
    <main className="auth">
      <form className="card" onSubmit={submit} noValidate>
        <h1>Student Registration</h1>
        {field('name', 'Full name')}
        {field('email', 'Email', 'email')}
        {field('password', 'Password', 'password')}
        {field('regNo', 'Registration no.')}
        {field('branch', 'Branch')}
        <fieldset><legend>Skills</legend>
          {SKILLS.map((s) => (
            <label key={s} className="inline"><input type="checkbox" checked={f.skills.includes(s)} onChange={() => toggle(s)} /> {s}</label>
          ))}
          {errs.skills && <span className="err">{errs.skills}</span>}
        </fieldset>
        {errs.form && <p className="err" role="alert">{errs.form}</p>}
        <button className="primary">Create account</button>
        <p className="muted">Have an account? <a href="#/login">Log in</a></p>
      </form>
    </main>
  );
}