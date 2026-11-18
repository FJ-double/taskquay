import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export interface Skill { name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }
interface Diagnostic { type: string; message: string; path: string; collision?: { resourceType: string; name: string } }
export interface LoadSkillsResult { skills: Skill[]; diagnostics: Diagnostic[] }

export function loadSkillsFromDir({ dir, source }: { dir: string; source: string }): LoadSkillsResult {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    const canonical = realpathSync(path);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (statSync(path).isDirectory()) {
      const skill = join(path, "SKILL.md");
      if (existsSync(skill)) visit(skill);
      else for (const entry of readdirSync(path)) if (!entry.startsWith(".")) visit(join(path, entry));
      return;
    }
    if (basename(path) !== "SKILL.md") return;
    try {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(path, "utf8"));
      const data = match ? parse(match[1]) as Record<string, unknown> : {};
      if (typeof data.description !== "string" || !data.description.trim()) throw new Error("Skill requires a description.");
      result.skills.push({ name: typeof data.name === "string" ? data.name : basename(dirname(path)), description: data.description,
        filePath: resolve(path), baseDir: dirname(resolve(path)), source, disableModelInvocation: data["disable-model-invocation"] === true });
    } catch (error) { result.diagnostics.push({ type: "warning", path, message: String(error) }); }
  };
  visit(dir);
  return result;
}
export function loadSkills({ skillPaths }: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }): LoadSkillsResult {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  for (const dir of skillPaths) {
    const loaded = loadSkillsFromDir({ dir, source: "configured" });
    result.diagnostics.push(...loaded.diagnostics);
    for (const skill of loaded.skills) {
      if (result.skills.some(existing => existing.name === skill.name)) result.diagnostics.push({ type: "collision", path: skill.filePath,
        message: `Duplicate skill: ${skill.name}`, collision: { resourceType: "skill", name: skill.name } });
      else result.skills.push(skill);
    }
  }
  return result;
}
export function loadProjectContextFiles({ cwd, agentDir }: { cwd: string; agentDir: string }): Array<{ path: string; content: string }> {
  const directories: string[] = [];
  let current = resolve(cwd);
  for (;;) { directories.unshift(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  return [...new Set([agentDir, ...directories])].flatMap(dir => ["AGENTS.md", "CLAUDE.md"].flatMap(name => {
    const path = join(dir, name);
    return existsSync(path) && statSync(path).isFile() ? [{ path, content: readFileSync(path, "utf8") }] : [];
  }));
}
