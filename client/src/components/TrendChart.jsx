import { parseISODate } from '../util';

function weekTick(start) {
  return parseISODate(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function monthTick(month) {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

function deltaText(delta, unit) {
  if (delta === 0) return `Same as last ${unit}`;
  if (delta > 0) return `${delta} more than last ${unit}`;
  return `${Math.abs(delta)} fewer than last ${unit}`;
}

export default function TrendChart({ title, points, unit }) {
  const series = (points || []).map((point) => ({
    key: point.start || point.month,
    label: point.start ? weekTick(point.start) : monthTick(point.month),
    completed: point.completed,
  }));
  const max = Math.max(1, ...series.map((item) => item.completed));
  const latest = series.at(-1)?.completed ?? 0;
  const previous = series.at(-2)?.completed ?? 0;
  const summary = series.map((item) => `${item.label}: ${item.completed}`).join(', ');

  return (
    <section className="chart-card">
      <div className="row-between">
        <h3>{title}</h3>
        <span className="stat">{deltaText(latest - previous, unit)}</span>
      </div>
      <div className="bars" role="img" aria-label={`${title}. ${summary}`}>
        {series.map((item) => (
          <div className="bar-col" key={item.key}>
            <span className="bar-value">{item.completed}</span>
            <div className="bar-track">
              <div
                className="bar"
                style={{ height: `${item.completed === 0 ? 0 : Math.max(8, (item.completed / max) * 100)}%` }}
              />
            </div>
            <span className="bar-label">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
