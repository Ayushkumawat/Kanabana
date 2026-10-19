export default function Avatar({ name, size = 28 }) {
  const palette = ['#1f6b4a', '#b5522a', '#1e4d6b', '#6d5420', '#3d4a78', '#6b3452'];
  let hash = 0;
  for (const char of name || '?') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const initials = (name || '?').split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return (
    <span
      className="avatar"
      style={{ background: palette[hash % palette.length], width: size, height: size, fontSize: size < 26 ? 10 : 12 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
