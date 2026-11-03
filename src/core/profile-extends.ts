/**
 * A profile that extends a profile (spec 54 Part B): the gate, the family, the merged profile and the load checks E1–E3.
 * Pure: `loadForge` reads the files and hands their contents in. Below Forge schema 12 no loaded profile holds `extends`
 * or `abstract` (the load refuses them), so every function here answers a profile's own self.
 */
import type { Profile, Sections } from "../schema/index.js";
import { FORGE_SCHEMA_PROFILE_EXTENDS } from "../schema/index.js";
import { deepMerge } from "./merge.js";
import { shownLocalName } from "./profile-local.js";

/** Whether the Forge reads a profile's `extends` and `abstract` (spec 54 §5.2). The ONE comparison with that constant. */
export function readsProfileExtends(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_PROFILE_EXTENDS;
}

/** The near miss below the gate (spec 54 §5.2): names the file and the first key it holds, never a value. */
export function profileExtendsNearMiss(file: string, key: "extends" | "abstract"): string {
  return `${file}: ${key} in a profile needs schema: ${FORGE_SCHEMA_PROFILE_EXTENDS} in craftar.forge.yaml`;
}

/** What the family functions read: the written profiles, and which top-level keys each `profile.yaml` holds. */
export interface FamilySource {
  profiles: ReadonlyMap<string, Profile>;
  /** Keys present in each profile's YAML document (spec 54 §5.3 "written"); absent for a Forge built in memory. */
  writtenKeys?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The family of `name`, nearest first: the profile, then each profile up its `extends` chain. Stops at a name the Forge
 * lacks or one already in the chain (E1 and E3 refuse those at load), so it always terminates.
 */
export function familyOf(forge: FamilySource, name: string): string[] {
  const out: string[] = [];
  let at: string | undefined = name;
  while (at !== undefined && forge.profiles.has(at) && !out.includes(at)) {
    out.push(at);
    at = forge.profiles.get(at)!.extends;
  }
  return out;
}

/** Whether `name` is an abstract profile (spec 54 §5.7). */
export function isAbstract(forge: FamilySource, name: string): boolean {
  return forge.profiles.get(name)?.abstract === true;
}

/** The concrete profiles whose family holds `name` (itself excluded), sorted. */
export function childrenOf(forge: FamilySource, name: string): string[] {
  return [...forge.profiles.keys()].filter((q) => q !== name && !isAbstract(forge, q) && familyOf(forge, q).includes(name)).sort();
}

/** The profiles a workspace may use (spec 54 §5.7): every profile that is not abstract. */
export function concreteProfiles(forge: FamilySource): string[] {
  return [...forge.profiles.keys()].filter((q) => !isAbstract(forge, q));
}

/** The one wording of an abstract profile used where a workspace's profile goes (spec 54 §5.7). */
export function abstractRefusal(forge: FamilySource, name: string): string {
  const kids = childrenOf(forge, name);
  const which = kids.length ? `a profile that extends it: ${kids.map((k) => shownLocalName(k, "profile")).join(", ")}` : "a profile that extends it";
  return `profile ${shownLocalName(name, "profile")} is abstract — a workspace uses ${which}`;
}

const written = (forge: FamilySource, p: Profile, key: string): boolean => {
  const keys = forge.writtenKeys?.get(p.name);
  return keys ? keys.has(key) : true;
};

/** The layers of `name`'s family, farthest first, each a written profile. */
export function familyLayers(forge: FamilySource, name: string): Profile[] {
  return familyOf(forge, name).reverse().map((n) => forge.profiles.get(n)!);
}

/**
 * The profile `name` resolves as (spec 54 §5.3, D6), its family folded farthest first: `params` and `sections` by key (the
 * nearer wins), `integrations` per slot (a written slot replaces the parent's whole), `recipes` the parent's then the child's
 * with a duplicate kept at its first place, `targets`, `repos`, `templates` and `docs` the nearest written one, the old blocks
 * key by key; `name`, `description`, `abstract` and `extends` are the profile's own. A profile with no parent is itself.
 */
export function mergedProfile(forge: FamilySource, name: string): Profile {
  const layers = familyLayers(forge, name);
  const self = forge.profiles.get(name)!;
  if (layers.length <= 1) return self;
  const out: Profile = { ...self };
  let params: Record<string, unknown> = {};
  let sections: Sections = {};
  let integrations: Record<string, unknown> = {};
  const recipes: string[] = [];
  const blocks = ["language", "identity", "scm", "naming", "frontend", "executor"] as const;
  const merged: Record<string, Record<string, unknown>> = Object.fromEntries(blocks.map((b) => [b, {}]));
  for (const l of layers) {
    params = { ...params, ...l.params };
    sections = deepMerge(sections, l.sections) as Sections;
    integrations = { ...integrations, ...l.integrations };
    for (const r of l.recipes) if (!recipes.includes(r)) recipes.push(r);
    for (const b of blocks) merged[b] = { ...merged[b], ...(l[b] as Record<string, unknown>) };
    if (written(forge, l, "targets")) out.targets = l.targets;
    if (written(forge, l, "repos")) out.repos = l.repos;
    if (written(forge, l, "templates")) out.templates = l.templates;
    if (written(forge, l, "docs")) out.docs = l.docs;
  }
  Object.assign(out, merged);
  return { ...out, params, sections, integrations, recipes, name: self.name, description: self.description, abstract: self.abstract, extends: self.extends };
}

/** The sections `name`'s parents give (its family less itself), folded farthest first, and the parent that set each value. */
export function parentSections(forge: FamilySource, name: string): { sections: Sections; setBy: Map<string, string> } {
  const layers = familyLayers(forge, name).slice(0, -1);
  let sections: Sections = {};
  const setBy = new Map<string, string>();
  for (const l of layers) {
    sections = deepMerge(sections, l.sections) as Sections;
    for (const [key, values] of Object.entries(l.sections)) for (const n of Object.keys(values)) setBy.set(`${key}\0${n}`, l.name);
  }
  return { sections, setBy };
}

/** E1–E3 (spec 54 §5.2) over every profile: a missing parent, a parent that is not abstract, a cycle. */
export function checkFamilies(forge: FamilySource, fileOf: (name: string) => string): string[] {
  const findings: string[] = [];
  for (const [name, p] of [...forge.profiles].sort(([a], [b]) => a.localeCompare(b))) {
    if (p.extends === undefined) continue;
    const parent = forge.profiles.get(p.extends);
    if (!parent) findings.push(`E1 ${fileOf(name)}: extends ${shownLocalName(p.extends, "profile")}, which is not a profile of this Forge`);
    else if (parent.abstract !== true) findings.push(`E2 ${fileOf(name)}: extends ${shownLocalName(p.extends, "profile")}, which is not abstract — mark it abstract: true, or extend an abstract profile`);
  }
  const cycles = new Set<string>();
  for (const name of forge.profiles.keys()) {
    const chain: string[] = [];
    let at: string | undefined = name;
    while (at !== undefined && forge.profiles.has(at)) {
      const i = chain.indexOf(at);
      if (i >= 0) {
        const loop = chain.slice(i);
        const start = loop.indexOf([...loop].sort()[0]);
        const rot = [...loop.slice(start), ...loop.slice(0, start)];
        cycles.add([...rot, rot[0]].map((n) => shownLocalName(n, "profile")).join(" → "));
        break;
      }
      chain.push(at);
      at = forge.profiles.get(at)!.extends;
    }
  }
  for (const c of [...cycles].sort()) findings.push(`E3 extends cycle: ${c}`);
  return findings;
}
