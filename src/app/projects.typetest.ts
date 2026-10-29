// Compile-time only (npm run typecheck; not exported, not bundled): list items carry no settings, get() does.
import type { Project, ProjectListItem } from './index';
import type { Projects } from './resources';

export async function listed(projects: Projects): Promise<string[]> {
  const items: ProjectListItem[] = await projects.list();
  return items.map(item => `${item.id} ${item.name} v${item.version ?? 0} ${item.updatedAt ?? ''}`);
}

// Settings come from get(id).
export async function designing(projects: Projects, id: string): Promise<unknown> {
  const full: Project = await projects.get(id);
  return full.settings?.designing;
}

export async function notOnTheList(projects: Projects): Promise<unknown> {
  const [first] = await projects.list();
  // @ts-expect-error - a list item has no settings; get(id) has them.
  return first?.settings?.designing;
}

// A list item with settings does not type-check either.
// @ts-expect-error - settings are not part of a list item.
export const withSettings: ProjectListItem = { id: 'p1', name: 'Table', settings: { app: 'crava' } };
