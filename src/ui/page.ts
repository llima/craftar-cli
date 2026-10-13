/**
 * The page of `craftar ui` (spec 36 §4.7, §7.4): one document, one script, one stylesheet, hand-written, as three
 * string constants — `dist/` holds only what `tsc` emits. The server sends the document with a CSP that allows
 * no inline script and no inline style, and the script puts every value it receives into the document as text
 * (`textContent`), never as markup. `test/ui-page.test.ts` reads these sources; what the page does in a browser
 * is a by-hand run.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>craftar</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main id="app"></main>
<script src="/app.js"></script>
</body>
</html>
`;

export const PAGE_CSS = `:root { color-scheme: light dark; --fg: #1b1f24; --bg: #ffffff; --dim: #5c6670; --line: #d5dae0; --soft: #f3f5f7; --ok: #1a7f37; --warn: #9a6700; --bad: #b42318; --add: #1a7f37; --del: #b42318; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ec; --bg: #0f1317; --dim: #9aa5b1; --line: #2b333b; --soft: #171c21; --ok: #4ac26b; --warn: #d4a72c; --bad: #ff7b72; --add: #4ac26b; --del: #ff7b72; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1200px; margin: 0 auto; padding: 16px 20px 48px; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
h3 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); }
p { margin: 4px 0; }
.dim { color: var(--dim); }
.mono, code, pre, td.path { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0 12px; }
button { font: inherit; color: inherit; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
button:hover { border-color: var(--dim); }
button.link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; font-weight: 600; }
button.on { border-color: var(--fg); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
th { font-weight: 600; color: var(--dim); white-space: nowrap; }
td.path { overflow-wrap: anywhere; }
.state { font-weight: 600; white-space: nowrap; }
.s-up-to-date, .s-unchanged { color: var(--ok); }
.s-outdated, .s-update, .s-new, .s-adopt, .s-orphan, .s-no-lock { color: var(--warn); }
.s-drift, .s-collision, .s-orphan-drift, .s-error, .s-missing { color: var(--bad); }
.note { border-left: 3px solid var(--line); padding: 2px 10px; margin: 8px 0; }
.note.warn { border-color: var(--warn); }
.note.bad { border-color: var(--bad); }
.detail { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; margin: 6px 0 10px; }
pre { margin: 6px 0 0; overflow-x: auto; white-space: pre; }
pre .add { color: var(--add); }
pre .del { color: var(--del); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; }
dt { color: var(--dim); }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: 4px 0; padding-left: 18px; }
code.cmd { background: var(--soft); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; user-select: all; }
`;

export const PAGE_JS = String.raw`"use strict";
(function () {
  var NO_TOKEN = "open the address printed by craftar ui — this tab has no token";
  var KEY = "craftar-ui-token";
  var MAX_DIFF_LINES = 2000;
  var STATES = ["new", "update", "adopt", "drift", "collision", "orphan", "orphan-drift", "unchanged"];
  /* The states sync acts on without a flag. */
  var SYNC_ACTS = { "new": true, "update": true, "adopt": true, "orphan": true };
  var app = document.getElementById("app");
  var table = null;

  var fromHash = location.hash.slice(1);
  var token = fromHash;
  try {
    if (fromHash) sessionStorage.setItem(KEY, fromHash);
    else token = sessionStorage.getItem(KEY) || "";
  } catch (e) {
    /* storage refused: the token lives for this page load only */
  }
  if (fromHash) history.replaceState(null, "", location.pathname);

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function button(label, onClick, className) {
    var b = el("button", className || "", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function list(items, className) {
    var ul = el("ul", className || "");
    items.forEach(function (item) { add(ul, el("li", "", item)); });
    return ul;
  }
  function row(tag, cells) {
    var tr = el("tr");
    cells.forEach(function (cell) {
      var td = el(tag);
      if (cell && cell.nodeType) add(td, cell);
      else td.textContent = cell === null || cell === undefined ? "" : String(cell);
      add(tr, td);
    });
    return tr;
  }
  function grid(head, rows) {
    var t = el("table");
    add(t, add(el("thead"), row("th", head)));
    var body = el("tbody");
    rows.forEach(function (cells) { add(body, row("td", cells)); });
    return add(el("div", "scroll"), add(t, body));
  }
  function note(text, kind) {
    return el("p", "note" + (kind ? " " + kind : ""), text);
  }
  function short(commit) {
    return commit ? commit.slice(0, 7) : "no git";
  }
  /* A path as one word of a command line: as it is when plain; single-quoted for a POSIX path (nothing expands
     inside single quotes); double-quoted, only the quote escaped, otherwise. */
  function shellWord(text) {
    if (/^[A-Za-z0-9_.,:=@%+\/\\-]+$/.test(text)) return text;
    if (text.charAt(0) === "/") return "'" + text.replace(/'/g, "'\\''") + "'";
    return '"' + text.replace(/"/g, '\\"') + '"';
  }
  function forgeLine(forge) {
    return forge.source + (forge.ref ? " (ref " + forge.ref + ")" : "") + " @ " + short(forge.commit);
  }

  function api(path) {
    return fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store" }).then(function (res) {
      return res.json().then(
        function (body) { return { status: res.status, body: body }; },
        function () { return { status: res.status, body: null }; }
      );
    });
  }

  /* What the page says for an answer that is not 200. asked: the file's path when the request named one. */
  function problem(into, answer, asked) {
    clear(into);
    if (answer.status === 403) return add(into, note(NO_TOKEN, "bad"));
    if (answer.status === 404) {
      if (asked !== undefined) return add(into, note("craftar does not manage " + asked, "warn"));
      return add(into, note("this workspace is no longer registered", "warn"), button("Refresh", showWorkspaces));
    }
    if (answer.status === 409 && answer.body) {
      add(into, note(String(answer.body.error), "bad"));
      if (answer.body.warnings && answer.body.warnings.length) add(into, list(answer.body.warnings, "dim"));
      return into;
    }
    if (answer.status === 400 && answer.body) return add(into, note(String(answer.body.error), "bad"));
    if (answer.status === 500) return add(into, note("craftar ui failed — see its terminal", "bad"));
    return add(into, note("unexpected answer: " + answer.status, "bad"));
  }
  function unreachable(into) {
    clear(into);
    return add(into, note("craftar ui is not answering — it may have been stopped in its terminal", "bad"));
  }
  function load(path, into, asked, render) {
    add(clear(into), el("p", "dim", "loading…"));
    api(path).then(
      function (answer) {
        if (answer.status !== 200 || answer.body === null) return problem(into, answer, asked);
        clear(into);
        render(answer.body);
      },
      function () { unreachable(into); }
    );
  }

  /* View 1: the table of craftar workspaces. */
  function showWorkspaces() {
    clear(app);
    var head = add(el("div"), el("h1", "", "craftar — workspaces"));
    var body = el("div");
    add(app, head, add(el("div", "bar"), button("Refresh", showWorkspaces)), body);
    if (!token) return add(clear(body), note(NO_TOKEN, "bad"));
    load("/api/workspaces", body, undefined, function (doc) {
      table = doc;
      add(head, el("p", "dim", "craftar " + doc.version + " · registry " + doc.registry));
      if (!doc.workspaces.length) {
        add(body, note("no workspace is registered on this machine yet — run craftar sync in one"));
      } else {
        add(body, grid(
          ["workspace", "path", "profile", "stack", "targets", "forge", "last sync", "status"],
          doc.workspaces.map(function (w) {
            var stack = Object.keys(w.stack || {}).map(function (k) { return k + " " + w.stack[k]; }).join(", ");
            var state = el("span", "state s-" + w.status, w.status.replace(/-/g, " ") + (w.forgeMoved ? " · forge moved" : ""));
            var path = el("span", "mono", w.path);
            return [button(w.name, function () { showWorkspace(w, "files"); }, "link"), path, w.profile, stack, w.targets.join(", "), forgeLine(w.forge), w.lastSync, state];
          })
        ));
        if (doc.workspaces.some(function (w) { return w.forge.kind === "remote"; })) add(body, el("p", "dim", "status read offline from the Forge cache"));
      }
      if (doc.warnings.length) add(body, el("h3", "", "warnings"), list(doc.warnings));
    });
  }

  function wordLayer(layer, profile) {
    if (layer === "profile") return "profile " + profile;
    if (typeof layer === "string") return layer;
    if (layer && layer.recipe !== undefined) return "recipe " + layer.recipe;
    if (layer && layer.profile !== undefined) return "profile " + layer.profile;
    return "";
  }

  function frame(w, tab) {
    clear(app);
    var body = el("div");
    add(
      app,
      add(el("div", "bar"), button("← Workspaces", showWorkspaces)),
      el("h1", "", w.name),
      el("p", "mono dim", w.path),
      add(
        el("div", "bar"),
        button("Files", function () { showWorkspace(w, "files"); }, tab === "files" ? "on" : ""),
        button("Its Forge", function () { showWorkspace(w, "forge"); }, tab === "forge" ? "on" : ""),
        button("Refresh", function () { showWorkspace(w, tab); })
      ),
      body
    );
    return body;
  }
  function cachedLine(into, kind) {
    if (kind === "remote") add(into, el("p", "dim", "read from the cached copy of the Forge — not fetched"));
  }

  function showWorkspace(w, tab) {
    var body = frame(w, tab);
    if (!token) return add(body, note(NO_TOKEN, "bad"));
    if (tab === "forge") return showForge(w, body);
    load("/api/workspaces/" + w.id, body, undefined, function (doc) {
      cachedLine(body, doc.forge.kind);
      var facts = el("dl");
      [
        ["profile", doc.profile],
        ["recipes", doc.recipes.join(", ")],
        ["targets", doc.targets.join(", ")],
        ["forge", forgeLine(doc.forge)],
        ["lock", doc.forge.lockCommit ? "generated from " + short(doc.forge.lockCommit) : "records no commit"]
      ].forEach(function (pair) { add(facts, el("dt", "", pair[0]), el("dd", "", pair[1])); });
      add(body, facts);
      if (doc.unsetParams.length) {
        add(body, note("sync is refused: " + doc.unsetParams.length + " declared parameter(s) have no value — set each in the profile or in craftar.yaml", "bad"));
        add(body, list(doc.unsetParams.map(function (u) {
          return u.key + " — declared by " + u.declaredBy.join(", ") + "; cited by " + u.citedBy.join(", ");
        })));
      }
      if (doc.warnings.length) add(body, el("h3", "", "warnings"), list(doc.warnings));
      if (!doc.statuses.length) add(body, note("the Forge produces no file for this workspace"));
      STATES.concat(doc.statuses.map(function (s) { return s.state; }).filter(function (s, i, all) { return STATES.indexOf(s) === -1 && all.indexOf(s) === i; })).forEach(function (state) {
        var files = doc.statuses.filter(function (s) { return s.state === state; });
        if (!files.length) return;
        var title = el("h2", "", "");
        add(title, el("span", "state s-" + state, state), document.createTextNode(" · " + files.length));
        add(body, title);
        if (SYNC_ACTS[state] && !doc.unsetParams.length) {
          add(body, add(el("p", "dim", "to apply, run in a terminal: "), el("code", "cmd", "craftar sync --workspace " + shellWord(doc.path))));
        }
        files.forEach(function (f) { add(body, fileRow(w, doc, f)); });
      });
    });
  }

  function fileRow(w, doc, f) {
    var box = el("div");
    var detail = el("div", "detail");
    detail.hidden = true;
    var bar = add(el("div", "bar"), el("span", "mono", f.path), el("span", "dim", [f.target, f.ingredient].filter(Boolean).join(" · ")));
    var query = "?path=" + encodeURIComponent(f.path);
    if (f.state !== "unchanged" && f.state !== "adopt") {
      add(bar, button("diff", function () {
        detail.hidden = false;
        load("/api/workspaces/" + w.id + "/diff" + query, detail, f.path, function (d) { showDiff(detail, d); });
      }));
    }
    if (f.state !== "orphan" && f.state !== "orphan-drift") {
      add(bar, button("explain", function () {
        detail.hidden = false;
        load("/api/workspaces/" + w.id + "/explain" + query, detail, f.path, function (x) { showExplain(detail, x); });
      }));
    }
    add(bar, button("close", function () { detail.hidden = true; clear(detail); }));
    return add(box, bar, detail);
  }

  function showDiff(into, d) {
    if (d.from) add(into, el("p", "mono dim", "--- " + d.from));
    if (d.to) add(into, el("p", "mono dim", "+++ " + d.to));
    if (d.note) add(into, note(d.note, d.hidden ? "warn" : ""));
    if (d.diff === null) {
      if (!d.note) add(into, el("p", "dim", "nothing to show: sync leaves this file as it is"));
      return;
    }
    var lines = d.diff.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    var pre = el("pre");
    lines.slice(0, MAX_DIFF_LINES).forEach(function (line) {
      var kind = line.charAt(0) === "+" ? "add" : line.charAt(0) === "-" ? "del" : "";
      add(pre, el("span", kind, line), document.createTextNode("\n"));
    });
    add(into, pre);
    if (lines.length > MAX_DIFF_LINES) add(into, el("p", "dim", "… " + (lines.length - MAX_DIFF_LINES) + " more lines"));
  }

  function showExplain(into, x) {
    var dl = el("dl");
    var pairs = [
      ["ingredient", x.ingredient],
      ["target", x.target],
      ["brought by", x.via === null ? "no single recipe" : x.via.join(", ")],
      ["imported from", x.origin ? x.origin.workspace + " · " + x.origin.path : "not imported"],
      ["profile", x.profile],
      ["recipes", x.recipes.join(", ")],
      ["hash", x.hash]
    ];
    x.sections.forEach(function (s) { pairs.push(["section " + s.name, wordLayer(s.layer, x.profile)]); });
    x.params.forEach(function (p) { pairs.push(["param " + p.key, wordLayer(p.layer, x.profile)]); });
    pairs.forEach(function (pair) { add(dl, el("dt", "", pair[0]), el("dd", "mono", pair[1])); });
    add(into, dl);
  }

  /* View 3: the Forge of one workspace — its recipes, then its ingredients. */
  function showForge(w, body) {
    cachedLine(body, w.forge.kind);
    var recipes = el("div");
    var ingredients = el("div");
    add(body, el("h2", "", "Recipes"), recipes, el("h2", "", "Ingredients"), ingredients);
    load("/api/workspaces/" + w.id + "/recipes", recipes, undefined, function (doc) {
      add(recipes, el("p", "dim", "forge " + doc.forge.name + " @ " + short(doc.forge.commit)));
      add(recipes, grid(
        ["recipe", "slot", "parents", "profiles", "registered workspaces", "here"],
        doc.recipes.map(function (r) {
          var users = !table || w.forge.key === null ? [] : table.workspaces.filter(function (o) {
            return o.forge.key !== null && o.forge.key === w.forge.key && o.recipes.indexOf(r.name) !== -1;
          }).map(function (o) { return o.name; });
          var here = r.removedByWorkspace ? "removed by this workspace" : r.inUse ? "in use (" + r.inUse.by.join(", ") + ")" : "";
          return [r.name, r.slot, r.extends.join(", "), r.profiles.join(", "), users.join(", "), here];
        })
      ));
      if (doc.warnings.length) add(recipes, el("h3", "", "warnings"), list(doc.warnings));
      var said = doc.warnings;
      load("/api/workspaces/" + w.id + "/ingredients", ingredients, undefined, function (ing) {
        add(ingredients, grid(
          ["ingredient", "type", "written as", "recipes", "targets", "here"],
          ing.ingredients.map(function (i) {
            var here = i.disabled ? "disabled by this workspace" : i.inUse ? "in use" : "";
            return [i.ref, i.type, i.outputName, i.recipes.join(", "), i.targets === "*" ? "every target" : i.targets.join(", "), here];
          })
        ));
        var more = ing.warnings.filter(function (w) { return said.indexOf(w) === -1; });
        if (more.length) add(ingredients, el("h3", "", "warnings"), list(more));
        if (ing.missing.length) {
          add(ingredients, el("h3", "", "named by a recipe, not in the Forge"), list(ing.missing.map(function (m) { return m.ref + " — " + m.recipes.join(", "); })));
        }
      });
    });
  }

  showWorkspaces();
})();
`;
