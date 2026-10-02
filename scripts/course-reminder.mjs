// Prints a yearly checklist of the marathon courses in the catalog, as Markdown.
// Run by .github/workflows/course-reminder.yml every January; nothing else can tell a stale course from a current one.
import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
const year = new Date().getFullYear();
const courses = catalog.entries.filter((e) => e.group === 'marathon' && e.kind === 'course');
const extras = (c) => catalog.entries.filter((e) => e.group === 'marathon' && e.kind !== 'course' && e.id.split('-')[1] === c.id.split('-')[1]);
const courseYear = (e) => Number((e.freshness || '').match(/\d{4}/)?.[0]) || null;

const lines = [
  `Race courses change most years. Cairn has ${courses.length} marathon courses, and nothing but a person can tell whether each still matches this year's race.`,
  '',
  'For each race: open the organizer\'s page, compare the course map with what Cairn shows, and tick the box. If the course changed, see "Marathon courses" in docs/HANDOFF.md for how to update it.',
  '',
];
for (const c of courses.sort((a, b) => (courseYear(a) || 0) - (courseYear(b) || 0))) {
  const y = courseYear(c);
  const age = y ? year - y : null;
  const flag = age === null ? '' : age >= 3 ? ` **${age} years old**` : age >= 1 ? ` (${age} year${age > 1 ? 's' : ''} old)` : '';
  const how = c.approximate ? 'traced by Cairn, approximate' : c.type === 'geojson' ? 'copy stored in data/courses/' : 'live layer from the publisher';
  const more = extras(c).map((e) => e.kind).join(', ');
  lines.push(`- [ ] **${c.title}**: ${y || 'year unknown'}${flag}. ${how}${more ? `; also ${more}` : ''}. [Organizer](${c.page})`);
}
lines.push('', 'Oldest first. Close this issue when every box is ticked.');
console.log(lines.join('\n'));
