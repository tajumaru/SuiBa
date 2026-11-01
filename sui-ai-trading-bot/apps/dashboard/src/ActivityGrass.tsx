/**
 * The activity "grass" (GitHub-style contribution heatmap) for
 * the Overview tab: one cell per day for the last 18 weeks,
 * coloured by the day's recorded order activity for the pair on
 * screen. Fills dominate — a day with a fill is always brighter
 * than a day with only attempts. Everything derives from the
 * orders the dashboard already holds; days the history no
 * longer covers simply stay dark (the worker keeps the newest
 * 200 orders).
 */

export interface ActivityDay {
  /** Local-time day key, YYYY-MM-DD. */
  dateKey: string;
  /** Column (week) and row (weekday, 0 = Sunday). */
  week: number;
  weekday: number;
  fills: number;
  orders: number;
  /** 0 none, 1 attempts only, 2 one fill, 3 two fills, 4 three+. */
  level: 0 | 1 | 2 | 3 | 4;
  isToday: boolean;
  isFuture: boolean;
}

function dayKeyOf(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function buildActivityWeeks(
  orders: readonly Record<string, unknown>[],
  nowMs: number,
  weeks = 18,
): ActivityDay[][] {
  const counts = new Map<string, { fills: number; orders: number }>();
  for (const o of orders) {
    const ts = o.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    const key = dayKeyOf(new Date(ts));
    const entry = counts.get(key) ?? { fills: 0, orders: 0 };
    entry.orders += 1;
    if (o.status === "FILLED") entry.fills += 1;
    counts.set(key, entry);
  }
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  // The grid ends with the current week; its first column
  // starts on a Sunday.
  const lastSunday = new Date(today);
  lastSunday.setDate(today.getDate() - today.getDay());
  const firstSunday = new Date(lastSunday);
  firstSunday.setDate(lastSunday.getDate() - (weeks - 1) * 7);
  const todayKey = dayKeyOf(today);
  const grid: ActivityDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: ActivityDay[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const d = new Date(firstSunday);
      d.setDate(firstSunday.getDate() + w * 7 + weekday);
      const key = dayKeyOf(d);
      const c = counts.get(key) ?? { fills: 0, orders: 0 };
      const level = (
        c.fills >= 3 ? 4 : c.fills === 2 ? 3 : c.fills === 1 ? 2 : c.orders > 0 ? 1 : 0
      ) as ActivityDay["level"];
      column.push({
        dateKey: key,
        week: w,
        weekday,
        fills: c.fills,
        orders: c.orders,
        level,
        isToday: key === todayKey,
        isFuture: d.getTime() > today.getTime(),
      });
    }
    grid.push(column);
  }
  return grid;
}

export interface ActivityStreaks {
  /** Consecutive recorded days ending today — or ending
   * yesterday while today is still blank (the day is not over,
   * so the streak is still alive). */
  current: number;
  /** Longest run inside the visible window. */
  longest: number;
}

/** Streaks of "grass grew" days (any order record that day). */
export function activityStreaks(
  weeks: readonly ActivityDay[][],
): ActivityStreaks {
  const days = weeks.flat().filter((d) => !d.isFuture);
  let longest = 0,
    run = 0;
  for (const d of days) {
    run = d.orders > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.orders > 0) {
      current++;
      continue;
    }
    if (d.isToday) continue;
    break;
  }
  return { current, longest };
}

/** Month labels for the columns whose month changes. */
export function activityMonthLabels(
  weeks: readonly ActivityDay[][],
): { week: number; label: string }[] {
  const out: { week: number; label: string }[] = [];
  let prev = "";
  weeks.forEach((column, i) => {
    const month = column[0].dateKey.slice(0, 7);
    if (month !== prev) {
      out.push({ week: i, label: `${Number(month.slice(5))}月` });
      prev = month;
    }
  });
  return out;
}

const WEEKDAY_LABELS = ["", "月", "", "水", "", "金", ""];

export function ActivityGrass({
  orders,
}: {
  orders: Record<string, unknown>[];
}) {
  const weeks = buildActivityWeeks(orders, Date.now());
  const monthLabels = activityMonthLabels(weeks);
  const streaks = activityStreaks(weeks);
  return (
    <section className="activity-grass-section">
      <div className="activity-grass-head">
        <h3>活動（直近18週）</h3>
        {streaks.longest > 0 && (
          <p className="activity-grass-streak">
            連続 {streaks.current}日 ・ 最長 {streaks.longest}日
          </p>
        )}
      </div>
      <div className="activity-grass-scroll">
        <div className="activity-grass-months" aria-hidden="true">
          {monthLabels.map((m) => (
            <span
              key={m.week}
              style={{ left: `calc(18px + ${m.week} * 14px)` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="activity-grass"
          role="img"
          aria-label="日ごとの約定・注文の記録ヒートマップ"
        >
          <div className="activity-grass-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((label, i) => (
              <span key={i}>{label}</span>
            ))}
          </div>
          {weeks.map((column, w) => (
            <div className="activity-grass-col" key={w}>
              {column.map((day) => (
                <span
                  key={day.dateKey}
                  className={`activity-grass-cell level-${day.level}${day.isToday ? " today" : ""}${day.isFuture ? " future" : ""}`}
                  title={`${day.dateKey}：約定 ${day.fills} 件・注文 ${day.orders} 件`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="activity-grass-legend">
        少ない
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`activity-grass-cell level-${level}`} />
        ))}
        多い（濃い日は約定があった日）
      </p>
    </section>
  );
}
