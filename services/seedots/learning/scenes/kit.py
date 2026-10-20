"""SeeDots Scene Kit: the only surface L2 scene code may touch.

Scene code is a function body that receives `kit`:

    const lr = kit.param("lr", {label: "Learning rate", min: 0.01, max: 1.2, step: 0.01, value: 0.1});
    const {ctx, w, h} = kit.canvas();
    function draw() { ...; kit.observe("final_x", x); }
    kit.onChange(draw);  draw();  kit.ready();

Event protocol between the scene (in a sandboxed iframe) and the host page:
    scene -> host  ready{params}, observe{name, value}, error{message}, ack{name, value}
    host  -> scene set_param{name, value}
The host renders the controls, runs predict -> try -> observe -> explain, and logs events.
The same runner page is used by the browser and by the headless gate, so what passed the
gates is exactly what learners run.

Engines are optional, pinned, and loaded from one CDN only: canvas (none), JSXGraph,
Matter.js, Three.js.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass

CDN = "https://cdn.jsdelivr.net/npm"
ENGINES: dict[str, list[str]] = {
    "canvas": [],
    "jsxgraph": [f'<link rel="stylesheet" href="{CDN}/jsxgraph@1.10.1/distrib/jsxgraph.css">',
                 f'<script src="{CDN}/jsxgraph@1.10.1/distrib/jsxgraphcore.js"></script>'],
    "matter": [f'<script src="{CDN}/matter-js@0.20.0/build/matter.min.js"></script>'],
    "three": [f'<script src="{CDN}/three@0.159.0/build/three.min.js"></script>'],
}
ENGINE_GLOBAL = {"jsxgraph": "JXG", "matter": "Matter", "three": "THREE"}

MAX_CODE = 20_000
FORBIDDEN = [
    (r"\bfetch\s*\(", "network access (fetch)"),
    (r"XMLHttpRequest|WebSocket|EventSource|sendBeacon", "network access"),
    (r"\bimport\s*\(|\bimport\s+[\w{*]|\brequire\s*\(", "module loading"),
    (r"\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(", "dynamic code"),
    (r"\b(parent|top|opener)\b\s*\.|window\s*\.\s*(parent|top|opener)", "reaching outside the sandbox"),
    (r"postMessage", "talking to the host directly (use kit)"),
    (r"localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie", "storage"),
    (r"\blocation\b\s*[.=]|window\s*\.\s*open", "navigation"),
    (r"innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write", "raw HTML injection"),
    (r"\bWorker\s*\(|SharedWorker|serviceWorker", "workers"),
    (r"<\s*/?\s*script", "script tags"),
]
REQUIRED = [(r"kit\s*\.\s*ready\s*\(", "call kit.ready() once the scene is drawn"),
            (r"kit\s*\.\s*observe\s*\(", "report what changed with kit.observe(name, value)"),
            (r"kit\s*\.\s*param\s*\(", "declare at least one control with kit.param(...)")]

KIT_JS = r"""
(function () {
  var post = function (m) { m.__seedots = 1; try { parent.postMessage(m, "*"); } catch (e) {} };
  var root = document.getElementById("stage");
  var dark = /theme=dark/.test(location.hash);
  var params = {}, order = [], onChange = [], readySent = false;
  var colors = dark
    ? { ink: "#e3e9e1", soft: "#a8b5ac", paper: "#0f1813", line: "#2a3831", moss: "#84bb9f", pollen: "#e7b93a", ember: "#e3826a", lichen: "#4f6a5c" }
    : { ink: "#17251e", soft: "#4a5a51", paper: "#edefe8", line: "#cfd6cc", moss: "#2f5d4a", pollen: "#d8a31a", ember: "#b5442e", lichen: "#9db3a4" };
  var kit = {
    root: root, colors: colors, dark: dark,
    size: function () { return { w: root.clientWidth, h: root.clientHeight }; },
    canvas: function () {
      var c = document.createElement("canvas"), r = window.devicePixelRatio || 1;
      var w = root.clientWidth, h = root.clientHeight;
      c.width = Math.round(w * r); c.height = Math.round(h * r);
      c.style.width = w + "px"; c.style.height = h + "px";
      root.appendChild(c);
      var ctx = c.getContext("2d"); ctx.scale(r, r);
      return { canvas: c, ctx: ctx, w: w, h: h };
    },
    param: function (name, o) {
      if (!params[name]) order.push(name);
      params[name] = { name: name, label: o.label || name, min: +o.min, max: +o.max, step: +o.step || 0.01, value: +o.value };
      return params[name].value;
    },
    get: function (name) { return params[name] ? params[name].value : undefined; },
    onChange: function (fn) { onChange.push(fn); },
    observe: function (name, value) {
      if (typeof value === "number" && !isFinite(value)) value = String(value);
      post({ type: "observe", name: String(name), value: value });
    },
    ready: function () {
      if (readySent) return; readySent = true;
      post({ type: "ready", params: order.map(function (n) { return params[n]; }) });
    }
  };
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || !m.__seedots || m.type !== "set_param" || !params[m.name]) return;
    var p = params[m.name], v = Math.min(p.max, Math.max(p.min, +m.value));
    p.value = v;
    for (var i = 0; i < onChange.length; i++) {
      try { onChange[i](m.name, v); } catch (err) { post({ type: "error", message: String(err && err.message || err) }); }
    }
    post({ type: "ack", name: m.name, value: v });
  });
  window.addEventListener("error", function (e) { post({ type: "error", message: String(e.message) }); });
  window.__kit = kit;
})();
"""


@dataclass
class StaticReport:
    ok: bool
    problems: list[str]


def static_check(code: str, engine: str) -> StaticReport:
    problems: list[str] = []
    if engine not in ENGINES:
        problems.append(f"unknown engine {engine!r}; use one of {', '.join(ENGINES)}")
    if len(code) > MAX_CODE:
        problems.append(f"code is {len(code)} characters; keep it under {MAX_CODE}")
    stripped = re.sub(r"//[^\n]*|/\*.*?\*/", "", code, flags=re.S)
    for pattern, what in FORBIDDEN:
        if re.search(pattern, stripped):
            problems.append(f"not allowed: {what}")
    for pattern, what in REQUIRED:
        if not re.search(pattern, stripped):
            problems.append(f"missing: {what}")
    if engine in ENGINE_GLOBAL and ENGINE_GLOBAL[engine] not in stripped:
        problems.append(f"engine {engine} is loaded but {ENGINE_GLOBAL[engine]} is never used")
    return StaticReport(not problems, problems)


CSP = ("default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; "
       "style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src data: blob:; font-src https://cdn.jsdelivr.net")


def runner_html(code: str, engine: str, title: str = "Scene") -> str:
    """A complete page: CSP, engine, kit, and the scene code wrapped in a function scope."""
    tags = "\n".join(ENGINES.get(engine, []))
    body = code.replace("</", "<\\/")      # cannot close the script element early
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{html.escape(CSP)}">
<title>{html.escape(title)}</title>
<style>html,body{{margin:0;height:100%;overflow:hidden;background:transparent;font:14px system-ui,sans-serif}}
#stage{{position:absolute;inset:0}} canvas{{display:block}}</style>
{tags}
</head><body><div id="stage"></div>
<script>{KIT_JS}</script>
<script>
window.__scene = function (kit) {{
"use strict";
{body}
}};
// start once the frame has a size (a srcdoc/iframe can run scripts before layout)
(function boot(tries) {{
  if (document.getElementById("stage").clientWidth > 0 || tries > 120) {{
    try {{ window.__scene(window.__kit); }} catch (e) {{ window.dispatchEvent(new ErrorEvent("error", {{message: String(e && e.message || e)}})); }}
  }} else requestAnimationFrame(function () {{ boot(tries + 1); }});
}})(0);
</script>
</body></html>"""


def host_html(runner: str, width: int, height: int) -> str:
    """Host page used by the headless gate: same sandbox attributes as the web app."""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>body{{margin:0;background:#edefe8}}
iframe{{border:0;display:block}}</style></head><body>
<iframe id="scene" sandbox="allow-scripts" width="{width}" height="{height}" srcdoc="{html.escape(runner, quote=True)}"></iframe>
<script>
window.__log = [];
window.addEventListener("message", function (e) {{ if (e.data && e.data.__seedots) window.__log.push(Object.assign({{t: performance.now()}}, e.data)); }});
window.__set = function (name, value) {{
  document.getElementById("scene").contentWindow.postMessage({{__seedots: 1, type: "set_param", name: name, value: value}}, "*");
}};
</script></body></html>"""


def describe_params(params: list[dict]) -> str:
    return json.dumps(params, ensure_ascii=False)
