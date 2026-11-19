// Context used by each Claude Code agent, read from its transcript's last `usage`.
// props: { window?: number } forces the context size (default: from the transcript's model).
// Also shows the session's provider, model and effort (from the same transcript line).
// Publishes shared("context.usage") = { address: { used, window, pct, provider, model, effort, fast } } for other mods
// (the pane-context header), and posts a warning once an agent passes 80%.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, theme, run, exec, props, checking, notify, setShared } from "herdr";

// Newest transcript of that folder, last real assistant line with usage.
// Tries the folder, then its parents (Claude may have started higher up).
const SCRIPT = `d="$1"; f=""
while [ -z "$f" ] && [ -n "$d" ]; do
  f=$(ls -t "$HOME/.claude/projects/$(printf %s "$d" | sed 's/[^A-Za-z0-9]/-/g')"/*.jsonl 2>/dev/null | head -1)
  [ "$d" = "/" ] && break; d=$(dirname "$d")
done
[ -n "$f" ] && tail -n 400 "$f" | grep '"usage"' | grep '"role":"assistant"' | grep -v '<synthetic>' | tail -1`;

// Context window by model id: these families have 1M; older ones (Haiku 4.5, Claude 3.x,
// Sonnet/Opus 4.0-4.5) have 200k. Unknown ids above 200k used are taken as 1M.
const MILLION = /fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5/;
const windowFor = (model, used) => (MILLION.test(model ?? "") || used > 200000 ? 1000000 : 200000);

// The transcript names no provider: guess it from the model id and request id.
// Bedrock ids carry an "anthropic." prefix or an ARN, older Vertex ids an "@date";
// the Anthropic API returns "req_..." request ids. Anything else stays "?".
function providerOf(model, requestId) {
  if (/^arn:aws|(^|\.)anthropic\./.test(model ?? "")) return "Bedrock";
  if ((model ?? "").includes("@")) return "Vertex";
  if (/^req_/.test(requestId ?? "")) return "Anthropic";
  return "?";
}

// "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5".
function modelName(id) {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d)(?:-(\d)(?!\d))?/.exec(id ?? "");
  if (!m) return id ?? "?";
  return m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "");
}

// "Anthropic · Opus 5.5 · medium" (+ " · fast" in fast mode).
const describe = (c) =>
  [c.provider, c.model, c.effort, c.fast ? "fast" : null].filter(Boolean).join(" · ");

const WARN = 80;   // warn at this %
const REARM = 70;  // warn again only after dropping below this (e.g. after /compact)
const short = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : Math.round(n / 1000) + "k");

export default class Context extends View {
  init(_props, cx) {
    this.ctx = {}; // address -> { used, window, pct }
    try { this.warned = new Set(JSON.parse(localStorage.getItem("warned") ?? "[]")); } catch (_) { this.warned = new Set(); }
    if (checking()) return;
    cx.timer.every(5000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      // The pane's live folder; the core's cwd can be the shell's, not the agent's.
      const cwds = new Map(terminals().map((t) => [t.address, t.cwd]));
      for (const p of panes()) if (p.terminal && p.cwd) cwds.set(p.terminal, p.cwd);
      const fixed = props()?.window;
      for (const a of agents().filter((a) => a.app === "claude-code" || a.program?.key === "claude")) {
        const cwd = cwds.get(a.address);
        if (!cwd) continue;
        const machine = spaces().find((s) => s.id === a.space)?.machine ?? null;
        try {
          const r = await exec("sh", ["-c", SCRIPT, "sh", cwd], { on: machine, timeout: 4000 });
          const line = r.stdout.trim();
          if (!line) continue;
          const entry = JSON.parse(line);
          const msg = entry.message;
          const u = msg.usage;
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          const window = fixed ?? windowFor(msg.model, used);
          const pct = Math.min(100, Math.round((100 * used) / window));
          this.ctx[a.address] = {
            used, window, pct,
            provider: providerOf(msg.model, entry.requestId),
            model: modelName(msg.model),
            effort: entry.perTurnEffort ?? entry.effort ?? null,
            fast: u.speed === "fast",
          };
          this.warn(a, pct, used, window);
        } catch (_) { /* machine offline or line cut: keep the last value */ }
      }
      // Forget agents that are gone, then share only when something changed.
      const live = new Set(agents().map((a) => a.address));
      for (const k of Object.keys(this.ctx)) if (!live.has(k)) delete this.ctx[k];
      const json = JSON.stringify(this.ctx);
      if (json !== this.last) { this.last = json; setShared("context.usage", this.ctx); }
      cx.notify();
    });
  }

  warn(a, pct, used, window) {
    if (pct < REARM && this.warned.delete(a.address)) this.save();
    if (pct < WARN || this.warned.has(a.address)) return;
    this.warned.add(a.address);
    this.save();
    notify({
      title: `Context at ${pct}%`,
      body: `${a.space_name} · ${short(used)}/${short(window)} · /compact`,
      level: "warning",
      action: { name: "agent.focus", args: { terminal: a.address } },
    });
  }

  save() {
    try { localStorage.setItem("warned", JSON.stringify([...this.warned])); } catch (_) {}
  }

  render() {
    const t = theme();
    const list = agents().filter((a) => this.ctx[a.address]);
    const bar = (pct) => {
      const color = pct >= 80 ? t.blocked : pct >= 60 ? t.working : t.done;
      return div().w(60).h(5).rounded(3).bg(t.border)
        .child(div().h_full().rounded(3).bg(color).w(Math.max(2, Math.round((60 * pct) / 100))));
    };
    return h_flex().size_full().px(14).gap(18).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.5).text_color(t.muted)
      .when(list.length === 0, (el) => el.child(div().text_color(t.dim).child("No Claude Code agents")))
      .children(list.map((a) => {
        const c = this.ctx[a.address];
        const { used, window, pct } = c;
        return h_flex().id(`ctx-${a.address}`).gap(7).items_center().rounded(4).px(4)
          .hover((s) => s.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address }))
          .child(div().text_color(a.focused ? t.foreground : t.muted).truncate().max_w(180).child(/^\d+$/.test(a.tab_name ?? "") ? a.space_name : `${a.space_name} · ${a.tab_name}`))
          .child(div().text_color(t.dim).truncate().max_w(220).child(describe(c)))
          .child(bar(pct))
          .child(div().text_color(pct >= 80 ? t.blocked : t.dim).child(`${short(used)}/${short(window)} · ${pct}%`));
      }));
  }
}
