import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FORGE_SCHEMA_PROFILE_LOCAL, RecipeSchema, WorkspaceConfigSchema, type IngredientRef } from "../schema/index.js";
import { readForgeFile, readForgeText } from "./contain.js";
import { assertNoLinkIn, assertNoLinkOnPath, copyForgeForProof, listFiles, loadForge, parseYaml, typeFolder, type Forge, type LoadedIngredient } from "./forge.js";
import { ingredientText, occupied, recipeFiles, resolveAll, swapEntry, unreadable, writeEdits, type ForgeWrite } from "./forge-edits.js";
import { impactOf, planAll, type ForgeWorkspace, type Planned } from "./impact.js";
import { recipesOrWritten } from "./integrations.js";
import { isLocalMessage, localOwners, readsProfileLocal } from "./profile-local.js";
import { plan, type Workspace } from "./sync.js";
import type { WriteJournal } from "./unify.js";
import { editYamlText } from "./yaml-edit.js";

// Spec 51 §5 — `forge localize` moves a root ingredient only one profile resolves into `profiles/<p>/`, with the root
// recipes that would otherwise cite a local (L3); `forge share` moves a local back to the root. Three steps a caller
// runs in order, as `forge promote`'s: the edit set (reads only), the proof on a scratch copy (every profile and every
// registered workspace plans the same paths and bytes), the writes through a journal.

export type MoveCommand = "forge localize" | "forge share";

export interface ForgeMove {
  command: MoveCommand;
  /** The Forge's root, absolute. */
  root: string;
  /** The ref named on the command line. */
  ref: IngredientRef;
  /** The ref after the move: the same, or `<type>/<as>` for a base-less variant that becomes a local. */
  to: IngredientRef;
  profile: string;
  /** Forge-relative POSIX directories. */
  moved: { from: string; to: string };
  /** The recipes that move with it (localize only), Forge-relative POSIX files. */
  recipes: Array<{ name: string; from: string; to: string }>;
  /** In write order. */
  writes: ForgeWrite[];
  /** Files deleted after every write. */
  removes: string[];
  /** Existing paths the run overwrites or deletes. */
  mustHold: string[];
  warnings: string[];
}

const posix = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

function gate(forge: Forge, command: MoveCommand): void {
  if (!readsProfileLocal(forge.manifest)) {
    throw new Error(
      `${command}: the Forge is at schema ${forge.manifest.schema} — profile-local ingredients need schema ${FORGE_SCHEMA_PROFILE_LOCAL} in craftar.forge.yaml; no command raises it, since every older craftar then refuses the Forge, for every client`,
    );
  }
}

function knownProfile(forge: Forge, profile: string, command: MoveCommand): void {
  if (!forge.profiles.has(profile)) throw new Error(`${command}: profile ${profile} does not exist in this Forge`);
}

/** The ingredient's files as writes under `toDir`, copied as bytes, with `ingredient.yaml` replaced by `meta` when given. */
async function copyFiles(ing: LoadedIngredient, toDir: string, meta: string | null): Promise<ForgeWrite[]> {
  const out: ForgeWrite[] = [];
  for (const rel of await listFiles(ing.dir)) {
    const content = rel === "ingredient.yaml" && meta !== null ? meta : await readForgeFile(ing.forgeRoot, path.join(ing.dir, rel));
    out.push({ abs: path.join(toDir, rel), content, created: true });
  }
  return out;
}

/** The plan of §5.1: what moves where, and the refusals that need no proof. Reads the Forge only. */
export async function planLocalize(forge: Forge, ref: string, profile: string): Promise<ForgeMove> {
  const command: MoveCommand = "forge localize";
  gate(forge, command);
  knownProfile(forge, profile, command);
  const ing = forge.ingredients.get(ref as IngredientRef);
  if (!ing) {
    const owners = localOwners(forge, ref);
    if (owners.length) throw new Error(`${command}: ${isLocalMessage(ref, owners)} already`);
    throw new Error(`${command}: ${ref} is not an ingredient of this Forge`);
  }
  const { type, name, as } = ing.meta;
  const warnings: string[] = [];

  // A variant becomes a local only when it is this profile's own and has no base (L1, L6).
  let localName = name;
  if (as !== undefined) {
    const baseRef = `${type}/${as}` as IngredientRef;
    if (forge.ingredients.has(baseRef)) throw new Error(`${command}: ${ref} is a variant of ${baseRef}, which is at the root — a local and a root variant of its own profile cannot write one file (L1); promote or unify it first`);
    if (name !== `${as}--${profile}`) throw new Error(`${command}: ${ref} is a variant (as: ${as}) not named ${as}--${profile} — only profile ${profile}'s own base-less variant becomes its local, under its output name`);
    localName = as;
  } else {
    const variant = [...forge.ingredients.values()].find((i) => i.meta.type === type && i.meta.as === name);
    if (variant) throw new Error(`${command}: ${ref} has the variant ${variant.ref} — a local has no variant; unify or promote it first`);
  }
  const to = `${type}/${localName}` as IngredientRef;
  if (forge.locals.get(profile)?.ingredients.has(to)) throw new Error(`${command}: profile ${profile} already holds the local ${to}`);

  // The recipes that move: every root recipe citing the ref, and every root recipe extending one of those, transitively.
  const moving = new Set([...forge.recipes.values()].filter((r) => r.ingredients.includes(ref)).map((r) => r.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of forge.recipes.values()) {
      if (!moving.has(r.name) && r.extends.some((e) => moving.has(e))) {
        moving.add(r.name);
        grew = true;
      }
    }
  }

  // Who resolves what: only this profile may use the ingredient or a recipe that moves.
  const all = resolveAll(forge);
  const mine = all.get(profile)!;
  if (mine instanceof Error) throw new Error(`${command}: profile ${profile} does not resolve (${firstLine(mine)}) — fix it first`);
  if (!mine.ingredients.some((i) => i.ref === ref)) throw new Error(`${command}: profile ${profile} does not resolve ${ref} — localize moves an ingredient its profile uses`);
  for (const [q, res] of all) {
    if (q === profile) continue;
    if (res instanceof Error) {
      // Judged on what it names: its written recipes, or what its integrations block selects (spec 51 §5.1).
      const listed = recipesOrWritten(forge, forge.profiles.get(q)!).recipes;
      const ownLocals = forge.locals.get(q)?.recipes;
      const names = [...listed.filter((r) => moving.has(r)), ...[...(ownLocals?.values() ?? [])].filter((l) => l.recipe.extends.some((e) => moving.has(e)) || l.recipe.ingredients.includes(ref)).map((l) => l.recipe.name)];
      if (names.length) throw new Error(`${command}: profile ${q} does not resolve, and its recipes name ${[...new Set(names)].sort().join(", ")}, which would move — fix that profile first`);
      warnings.push(`profile ${q} does not resolve (${firstLine(res)}) — not proved; its recipes name nothing this move touches`);
      continue;
    }
    if (res.ingredients.some((i) => i.ref === ref)) throw new Error(`${command}: profile ${q} also resolves ${ref} — only an ingredient no other profile resolves becomes local`);
    const shared = res.recipes.filter((r) => moving.has(r) && forge.recipes.has(r));
    if (shared.length) throw new Error(`${command}: profile ${q} resolves recipe ${shared[0]}, which would move with ${ref} — only recipes no other profile resolves move`);
  }
  for (const r of [...moving].sort()) {
    if (!mine.recipes.includes(r)) throw new Error(`${command}: recipe ${r} cites ${ref} and would have to move, but no profile resolves it — a root recipe cannot cite a local (L3); remove ${ref} from it, or delete it, commit, and re-run`);
  }

  await assertNoLinkIn(forge.root, ing.dir, command);

  // The destination.
  const toDirRel = `profiles/${profile}/ingredients/${typeFolder(type)}/${localName}`;
  const toDir = path.join(forge.root, ...toDirRel.split("/"));
  if (await occupied(toDir, toDirRel, command)) throw new Error(`${command}: ${toDirRel} already exists — remove it by hand, commit, and re-run`);

  const renamed = to !== ref;
  const meta = renamed ? ingredientText(await readForgeText(ing.forgeRoot, path.join(ing.dir, "ingredient.yaml")), posix(forge.root, path.join(ing.dir, "ingredient.yaml")), ing.meta, localName, null, command) : null;
  const writes: ForgeWrite[] = await copyFiles(ing, toDir, meta);
  const removes = (await listFiles(ing.dir)).map((rel) => path.join(ing.dir, rel));

  // The recipe files: moved unchanged, or rewired to the new ref.
  const files = await recipeFiles(forge.root);
  const recipes: ForgeMove["recipes"] = [];
  const rewire = (raw: string, label: string, expected: unknown, schema = RecipeSchema): string => {
    const text = editYamlText(raw, { command, label, keys: ["ingredients"] }, (doc) => void swapEntry(doc, "ingredients", ref, to));
    if (!isDeepStrictEqual(parseYaml(label, text, schema), expected)) throw unreadable(label, `${ref} replaced by ${to}`, command);
    return text;
  };
  for (const r of [...moving].sort()) {
    const f = files.get(r);
    if (!f) throw new Error(`${command}: recipe ${r} has no file under recipes/`);
    const from = posix(forge.root, f.abs);
    const toRel = `profiles/${profile}/recipes/${path.basename(f.abs)}`;
    const toAbs = path.join(forge.root, ...toRel.split("/"));
    if (await occupied(toAbs, toRel, command)) throw new Error(`${command}: ${toRel} already exists — remove it by hand, commit, and re-run`);
    const recipe = forge.recipes.get(r)!;
    const content = renamed && recipe.ingredients.includes(ref) ? rewire(f.raw, from, { ...recipe, ingredients: recipe.ingredients.map((i) => (i === ref ? to : i)) }) : await fs.readFile(f.abs);
    writes.push({ abs: toAbs, content, created: true });
    removes.push(f.abs);
    recipes.push({ name: r, from, to: toRel });
  }
  // This profile's own local recipes that cite the variant's old ref follow the rename, in place.
  const edited: string[] = [];
  if (renamed) {
    for (const l of forge.locals.get(profile)?.recipes.values() ?? []) {
      if (!l.recipe.ingredients.includes(ref)) continue;
      const abs = path.join(forge.root, ...l.file.split("/"));
      writes.push({ abs, content: rewire(await fs.readFile(abs, "utf8"), l.file, { ...l.recipe, ingredients: l.recipe.ingredients.map((i) => (i === ref ? to : i)) }), created: false });
      edited.push(abs);
    }
  }

  return {
    command,
    root: forge.root,
    ref: ref as IngredientRef,
    to,
    profile,
    moved: { from: posix(forge.root, ing.dir), to: toDirRel },
    recipes,
    writes,
    removes,
    mustHold: [...removes, ...edited].sort(),
    warnings,
  };
}

/** The plan of §5.2: a local of `profile` back to the root, its local recipes left as they are. Reads the Forge only. */
export async function planShare(forge: Forge, ref: string, profile: string): Promise<ForgeMove> {
  const command: MoveCommand = "forge share";
  gate(forge, command);
  knownProfile(forge, profile, command);
  const ing = forge.locals.get(profile)?.ingredients.get(ref as IngredientRef);
  if (!ing) {
    const owners = localOwners(forge, ref);
    if (owners.length) throw new Error(`${command}: ${isLocalMessage(ref, owners)}, not to profile ${profile}`);
    throw new Error(`${command}: ${ref} is not local to profile ${profile}`);
  }
  const { type, name } = ing.meta;
  if (forge.ingredients.has(ref as IngredientRef)) throw new Error(`${command}: ${ref} is also at the root (L1) — remove one by hand, commit, and re-run`);
  const variant = [...forge.ingredients.values()].find((i) => i.meta.type === type && i.meta.as === name);
  if (variant) throw new Error(`${command}: ${variant.ref} at the root is a variant named ${name} — sharing ${ref} would give it a base other profiles resolve beside it; promote or unify it first`);
  const others = localOwners(forge, ref).filter((q) => q !== profile);
  if (others.length) throw new Error(`${command}: ${isLocalMessage(ref, others)} too — at the root it would stand beside that local (L1)`);

  const warnings: string[] = [];
  for (const [q, res] of resolveAll(forge)) if (res instanceof Error) warnings.push(`profile ${q} does not resolve (${firstLine(res)}) — not proved`);

  await assertNoLinkIn(forge.root, ing.dir, command);
  const toDirRel = `ingredients/${typeFolder(type)}/${name}`;
  const toDir = path.join(forge.root, ...toDirRel.split("/"));
  if (await occupied(toDir, toDirRel, command)) throw new Error(`${command}: ${toDirRel} already exists — remove it by hand, commit, and re-run`);
  const writes = await copyFiles(ing, toDir, null);
  const removes = (await listFiles(ing.dir)).map((rel) => path.join(ing.dir, rel));
  return {
    command,
    root: forge.root,
    ref: ref as IngredientRef,
    to: ref as IngredientRef,
    profile,
    moved: { from: posix(forge.root, ing.dir), to: toDirRel },
    recipes: [],
    writes,
    removes,
    mustHold: [...removes].sort(),
    warnings,
  };
}

/** Plan one profile with no workspace layer, in an empty directory: what that profile alone gives. */
async function planProfile(forge: Forge, profile: string, wsRoot: string): Promise<Map<string, Buffer>> {
  const ws: Workspace = {
    root: wsRoot,
    config: WorkspaceConfigSchema.parse({ forge: ".", profile }),
    forge,
    origin: { kind: "path", source: forge.root, ref: null, defaultBranch: null, fetched: false, fromLocalFile: false },
    warnings: [],
  };
  const p = await plan(ws);
  return new Map(p.files.map((f) => [f.path, f.content]));
}

function differs(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const out: string[] = [];
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(p);
    const b = after.get(p);
    if (!a || !b || !a.equals(b)) out.push(p);
  }
  return out.sort();
}

const notSame = (command: MoveCommand, who: string, what: string) => new Error(`${command}: ${who} would not plan the same after the move — ${what}; nothing written`);

/**
 * The proof of §5.1 (and §5.2): on a scratch copy holding the move, every profile that plans today, and every
 * registered workspace that plans today, plans the same paths and the same bytes (`Buffer.equals`). Reads the Forge
 * only; the scratch directory — the Forge's copy and one empty directory the profiles are planned in — is always
 * removed. Returns the warnings of what it could not prove.
 */
export async function proveMove(forge: Forge, move: ForgeMove, registered: ForgeWorkspace[]): Promise<string[]> {
  const { command } = move;
  const warnings: string[] = [];
  const moving = new Set(move.recipes.map((r) => r.name));
  let scratch: string;
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-forge-move-"));
  } catch (e) {
    throw new Error(`${command}: cannot make the scratch copy in the temporary directory (${(e as NodeJS.ErrnoException).code ?? firstLine(e)}) — nothing was written`);
  }
  try {
    const copy = path.join(scratch, "forge");
    const wsRoot = path.join(scratch, "workspace");
    await fs.mkdir(wsRoot);
    await copyForgeForProof(forge.root, copy, command);
    try {
      await writeEdits(forge.root, copy, move);
    } catch (e) {
      const at = (e as NodeJS.ErrnoException).path;
      throw new Error(`${command}: ${at ? posix(copy, at) : "a file"} could not be written on the scratch copy the move is proved on (${(e as NodeJS.ErrnoException).code ?? "the write failed"}) — it cannot be written in the Forge either; nothing written`);
    }
    let edited: Forge;
    try {
      edited = await loadForge(copy);
    } catch (e) {
      throw new Error(`${command}: the Forge would not load after the move:\n${(e instanceof Error ? e.message : String(e)).split(copy).join(forge.root)}\nnothing written`);
    }

    for (const q of [...forge.profiles.keys()].sort()) {
      let before: Map<string, Buffer>;
      try {
        before = await planProfile(forge, q, wsRoot);
      } catch {
        continue; // planLocalize / planShare already warned or refused about a profile that does not resolve
      }
      let after: Map<string, Buffer>;
      try {
        after = await planProfile(edited, q, wsRoot);
      } catch (e) {
        throw notSame(command, `profile ${q}`, firstLine(e).split(copy).join(forge.root));
      }
      const changed = differs(before, after);
      if (changed.length) throw notSame(command, `profile ${q}`, changed.join(", "));
    }

    // A registered workspace of another profile that adds, by name, a recipe this move takes into the profile's folder.
    const beforeWs: Planned[] = await planAll(registered, forge);
    for (let i = 0; i < registered.length; i++) {
      const b = beforeWs[i];
      if (b.kind !== "planned") continue;
      const q = b.workspace.config.profile;
      const added = b.workspace.config.recipes.add.filter((r) => moving.has(r));
      if (q !== move.profile && added.length) {
        throw new Error(`${command}: workspace ${registered[i].entry.path} (profile ${q}) adds recipe ${added[0]}, which would move to profiles/${move.profile} — remove it from that workspace's recipes.add first; nothing written`);
      }
    }
    const afterWs = await planAll(registered, edited);
    for (let i = 0; i < registered.length; i++) {
      const where = `workspace ${registered[i].entry.path}`;
      if (beforeWs[i].kind !== "planned") {
        warnings.push(`${where} does not plan today — not proved`);
        continue;
      }
      const r = impactOf(beforeWs[i], afterWs[i]);
      if (r.state === "error") throw notSame(command, where, (r.error ?? "it fails").split("\n")[0].split(copy).join(forge.root));
      if (r.state !== "no-effect") throw notSame(command, where, r.files.join(", "));
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return warnings;
}

/** Write a move into its Forge: every write, then every removal, each noted in `journal` before it is touched. */
export async function applyMove(move: ForgeMove, journal: WriteJournal): Promise<void> {
  await assertNoLinkOnPath(move.root, [...move.writes.map((w) => w.abs), ...move.removes], move.command);
  await writeEdits(move.root, move.root, move, journal);
}
