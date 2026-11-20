// AWS spend for one project (Cost Explorer, by cost-allocation tag) plus the live state of its EC2 instances.
// props: { value: "my-project", tag?: "Project", region?: "eu-west-1", hourly?: number, label?: string }
// The instances are the ones carrying the same tag; their on-demand Linux price comes from the
// Pricing API (cached) unless `hourly` is given. Cost Explorer lags ~24h and each call costs $0.01,
// so it is asked at most every 6h (cached); instance state is free and polled every 2 min.
// Click the panel to force a refresh.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, theme, checking } from "herdr";

const DEFAULTS = { tag: "Project", value: "", region: "eu-west-1", hourly: null, label: null };
const CE_EVERY = 6 * 3600 * 1000;
const EC2_EVERY = 2 * 60 * 1000;

// A stale session token in ~/.aws/credentials beats a profile's credential_process
// (e.g. IAM Roles Anywhere); set props.ignoreCredentialsFile: false to keep the file.
const aws = (cfg, args) => exec("env", [
  ...(cfg.ignoreCredentialsFile === false ? [] : ["AWS_SHARED_CREDENTIALS_FILE=/dev/null"]),
  "aws", ...args, "--output", "json"], { timeout: 60000 });
async function awsJson(cfg, args) {
  const r = await aws(cfg, args);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop());
  return JSON.parse(r.stdout);
}

const ymd = (d) => d.toISOString().slice(0, 10);
const usd = (n) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const SHORT = {
  "Amazon Elastic Compute Cloud - Compute": "EC2",
  "EC2 - Other": "EBS/red",
  "Amazon Inspector": "Inspector",
  "Amazon Virtual Private Cloud": "VPC",
  "AmazonCloudWatch": "CloudWatch",
  "Amazon Simple Storage Service": "S3",
};

export default class AwsCost extends View {
  init(_props, cx) {
    this.cfg = { ...DEFAULTS, ...(props() ?? {}) };
    this.cost = null;    // { at, month, key, days: [{date, total}], services: [[name, amt]], total }
    this.ec2 = null;     // [{ id, type, state, launch }]
    this.prices = {};    // instance type -> USD/h
    this.error = null;
    this.loading = false;
    try { this.cost = JSON.parse(localStorage.getItem("cost") ?? "null"); } catch (_) {}
    try { this.prices = JSON.parse(localStorage.getItem("prices") ?? "{}"); } catch (_) {}
    if (checking() || !this.cfg.value) return;
    cx.timer.every(EC2_EVERY, (cx) => this.refresh(cx, false));
    this.refresh(cx, false);
  }

  key() { return `${this.cfg.tag}=${this.cfg.value}`; }

  refresh(cx, force) {
    if (!this.cfg.value) return;
    cx.spawn(async (cx) => {
      this.loading = true; cx.notify();
      try {
        this.ec2 = await awsJson(this.cfg, ["ec2", "describe-instances", "--region", this.cfg.region,
          "--filters", `Name=tag:${this.cfg.tag},Values=${this.cfg.value}`,
          "Name=instance-state-name,Values=pending,running,stopping,stopped",
          "--query", "Reservations[].Instances[].{id:InstanceId,type:InstanceType,state:State.Name,launch:LaunchTime}"]);
        if (this.cfg.hourly == null) await this.fetchPrices();

        const c = this.cost;
        const stale = !c || c.key !== this.key() || Date.now() - c.at > CE_EVERY || c.month !== ymd(new Date()).slice(0, 7);
        if (force || stale) await this.fetchCost();
        this.error = null;
      } catch (e) {
        this.error = String(e.message ?? e).replace(/^.*?\): /, "").slice(0, 140);
      }
      this.loading = false; cx.notify();
    });
  }

  // On-demand Linux, shared tenancy, from the Pricing API (served from us-east-1).
  async fetchPrices() {
    for (const type of new Set(this.ec2.map((i) => i.type))) {
      if (this.prices[type] != null) continue;
      const f = (field, value) => `Type=TERM_MATCH,Field=${field},Value=${value}`;
      const r = await awsJson(this.cfg, ["pricing", "get-products", "--region", "us-east-1", "--service-code", "AmazonEC2",
        "--filters", f("instanceType", type), f("regionCode", this.cfg.region), f("operatingSystem", "Linux"),
        f("tenancy", "Shared"), f("preInstalledSw", "NA"), f("capacitystatus", "Used"), "--max-items", "1"]);
      const product = r.PriceList?.[0] ? JSON.parse(r.PriceList[0]) : null;
      const dims = Object.values(product?.terms?.OnDemand ?? {}).flatMap((t) => Object.values(t.priceDimensions));
      if (dims[0]) this.prices[type] = +dims[0].pricePerUnit.USD;
    }
    try { localStorage.setItem("prices", JSON.stringify(this.prices)); } catch (_) {}
  }

  async fetchCost() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const filter = JSON.stringify({ Tags: { Key: this.cfg.tag, Values: [this.cfg.value] } });
    const res = (await awsJson(this.cfg, ["ce", "get-cost-and-usage", "--time-period", `Start=${ymd(start)},End=${ymd(end)}`,
      "--granularity", "DAILY", "--metrics", "UnblendedCost", "--filter", filter,
      "--group-by", "Type=DIMENSION,Key=SERVICE"])).ResultsByTime;
    const services = {};
    const days = res.map((d) => {
      let total = 0;
      for (const g of d.Groups) {
        const a = +g.Metrics.UnblendedCost.Amount;
        total += a;
        services[g.Keys[0]] = (services[g.Keys[0]] ?? 0) + a;
      }
      return { date: d.TimePeriod.Start, total };
    });
    this.cost = {
      at: Date.now(), month: ymd(start).slice(0, 7), key: this.key(), days,
      total: days.reduce((s, d) => s + d.total, 0),
      services: Object.entries(services).sort((a, b) => b[1] - a[1]).filter(([, a]) => a >= 0.005),
    };
    try { localStorage.setItem("cost", JSON.stringify(this.cost)); } catch (_) {}
  }

  render() {
    const t = theme();
    const root = v_flex().id("aws-cost").size_full().px(14).py(10).gap(8).text_size(12).text_color(t.muted)
      .border_t(1).border_color(t.border);
    if (!this.cfg.value) return root.child(div().text_color(t.dim).child("aws-cost: falta props.value (valor del tag)"));

    const c = this.cost?.key === this.key() ? this.cost : null;
    const running = (this.ec2 ?? []).filter((i) => i.state === "running");
    const hoursOf = (i) => (Date.now() - Date.parse(i.launch)) / 3.6e6;
    const priceOf = (i) => this.cfg.hourly ?? this.prices[i.type] ?? 0;
    const hours = running.length ? Math.max(...running.map(hoursOf)) : 0;
    const session = running.reduce((s, i) => s + hoursOf(i) * priceOf(i), 0);
    const hourly = running.reduce((s, i) => s + priceOf(i), 0);

    const now = new Date();
    const dim = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
    // Projection from the complete days only (today is partial in Cost Explorer).
    const full = c ? c.days.filter((d) => d.date < ymd(now)) : [];
    const avg = full.length ? full.reduce((s, d) => s + d.total, 0) / full.length : 0;
    const projected = c ? c.total + avg * (dim - now.getUTCDate() + 1 - (c.days.length - full.length)) : 0;
    const max = Math.max(0.01, ...(c?.days ?? []).map((d) => d.total));

    const state = !this.ec2 ? "" : running.length ? `${hours.toFixed(1)}h on`
      : this.ec2.length ? this.ec2[0].state : "sin EC2";
    const dot = div().size(7).rounded(4).bg(running.length ? t.ansi2 : this.ec2 ? t.dim : t.unknown);
    const header = h_flex().gap(6).items_center().justify_between()
      .child(h_flex().gap(6).items_center().child(dot)
        .child(div().text_color(t.foreground).font_semibold().truncate().child(this.cfg.label ?? this.cfg.value)))
      .child(div().text_color(t.dim).text_size(10.5).child(this.loading ? "…" : state));

    const body = c
      ? v_flex().gap(6)
          .child(h_flex().items_end().justify_between()
            .child(div().text_size(20).font_semibold().text_color(t.foreground).child(usd(c.total)))
            .child(div().text_size(10.5).text_color(t.muted).child(`→ ~${usd(projected)} /mes`)))
          .child(h_flex().h(28).gap(1).items_end().children(
            Array.from({ length: dim }, (_, i) => {
              const d = c.days[i];
              const h = d ? Math.max(1, Math.round((d.total / max) * 28)) : 1;
              return div().flex_1().h(h).rounded(1).bg(d ? t.accent : t.border);
            })))
          .child(div().text_size(10.5).text_color(t.muted).truncate().child(
            c.services.slice(0, 3).map(([n, a]) => `${SHORT[n] ?? n} ${usd(a)}`).join(" · ")))
          .when(running.length > 0 && hourly > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim)
            .child(`Sesión: ~${usd(session)} (${usd(hourly)}/h)`)))
      : div().text_color(t.dim).child(this.error ? "" : "Cargando coste…");

    return root
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.refresh(cx, true))
      .child(header)
      .child(body)
      .when(!!this.error, (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(this.error)));
  }
}
