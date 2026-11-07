import { HOOK_CANDIDATES } from "../core/hook-catalog.js";
import { MODULE_ID } from "../core/ids.js";
import { escapeHtml as h } from "../core/journal.js";
import { resolveWriter, writerCandidates, type UserLike } from "../core/writer.js";
import { currentWriterSetting, exportEvents, importJournalFile, mark, setWriter, thisClientWrites } from "./actions.js";
import type { SpikeRuntime } from "./runtime.js";

/**
 * Plain ApplicationV2 (no Handlebars templates) GM-only panel. `foundry.applications.api.ApplicationV2`,
 * `DEFAULT_OPTIONS.actions`, `_renderHTML`/`_replaceHTML`/`_onRender` are candidate APIs: verify on v14.
 * Created lazily (after `init`) so the `foundry` global exists.
 */
export function createPanelClass(rt: SpikeRuntime): any {
  const { ApplicationV2 } = foundry.applications.api;

  const notify = (level: "info" | "warn" | "error", msg: string) => ui?.notifications?.[level]?.(msg);

  class SpikePanel extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: `${MODULE_ID}-panel`,
      tag: "div",
      window: { title: "S03 spike panel (GM only, throwaway)", resizable: true },
      position: { width: 620, height: "auto" },
      actions: {
        refresh: async function (this: any) {
          await this.render();
        },
        mark: async function (this: any) {
          if (!mark(rt)) notify("warn", "Mark ignored: this client is not the designated writer.");
          await this.render();
        },
        flush: async function (this: any) {
          await rt.writer?.flush("manual");
          await this.render();
        },
        exportEvents: async function (this: any) {
          try {
            await exportEvents(rt);
          } catch (err) {
            notify("error", `Export failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await this.render();
        },
        saveWriter: async function (this: any) {
          const sel = this.element?.querySelector?.("select[name=writer]") as HTMLSelectElement | null;
          try {
            await setWriter(sel?.value ?? "");
          } catch (err) {
            notify("error", String(err));
          }
          await this.render();
        },
        pickImport: function (this: any) {
          (this.element?.querySelector?.("input[name=importFile]") as HTMLInputElement | null)?.click();
        },
      },
    };

    async render(options?: any): Promise<any> {
      if (!game.user?.isGM) {
        notify("warn", "The S03 spike panel is GM-only.");
        return this;
      }
      return super.render(options);
    }

    async _prepareContext(): Promise<Record<string, unknown>> {
      const users: UserLike[] = game.users.map((u: any) => ({ id: u.id, name: u.name, active: !!u.active, isGM: !!u.isGM }));
      return {
        users,
        writerSetting: currentWriterSetting(),
        persisted: rt.store ? await rt.store.count() : null,
      };
    }

    async _renderHTML(context: any): Promise<HTMLElement> {
      const div = document.createElement("div");
      div.className = "sargas-recap-spike";
      div.innerHTML = renderBody(rt, context);
      return div;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement): void {
      content.replaceChildren(result);
    }

    _onRender(): void {
      const input = this.element?.querySelector?.("input[name=importFile]") as HTMLInputElement | null;
      input?.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const out = await importJournalFile(rt, file);
          if (!out.ok) notify("error", `Import rejected: ${out.errors.length} error(s), see panel.`);
          else if (out.violations.length) notify("error", `Imported, but ownership is NOT GM-only (${out.violations.length}).`);
          else notify("info", "Imported test journal as GM-only.");
        } catch (err) {
          notify("error", `Import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.render();
      });
    }
  }

  return SpikePanel;
}

function renderBody(rt: SpikeRuntime, ctx: { users: UserLike[]; writerSetting: string; persisted: number | null }): string {
  const release = game.release ?? {};
  const writer = resolveWriter(ctx.writerSetting, ctx.users);
  const writerName = ctx.users.find((u) => u.id === writer.writerUserId)?.name ?? writer.writerUserId ?? "(none)";
  const stats = rt.writer?.stats;
  const options = writerCandidates(ctx.users)
    .map((u) => `<option value="${h(u.id)}" ${u.id === ctx.writerSetting ? "selected" : ""}>${h(u.name ?? u.id)}${u.isGM ? " (GM)" : ""}</option>`)
    .join("");
  const fires = rt.capture?.fires ?? {};
  const emitted = rt.capture?.emitted ?? {};
  const hookRows = HOOK_CANDIDATES.map(
    (c) => `<tr><td>${h(c.category)}</td><td><code>${h(c.hook)}</code></td><td>${fires[c.hook] ?? 0}</td><td>${emitted[c.hook] ?? 0}</td><td>${rt.probe?.errors[c.hook] ?? 0}</td></tr>`,
  ).join("");
  const lossRows = (rt.recovery?.priorSessions ?? [])
    .slice(-8)
    .map((s) => `<tr><td>${h(s.startedAt)}</td><td>${s.issued}</td><td>${s.persisted}</td><td><b>${s.lost}</b></td></tr>`)
    .join("");
  const imp = rt.lastImport;
  const importBlock = imp
    ? `<p>Last import ${h(imp.at)}: ${imp.ok ? `created journal <code>${h(imp.journalId ?? "")}</code> with ${imp.pageCount ?? 0} page(s)` : "REJECTED"}</p>
       ${imp.errors.length ? `<ul>${imp.errors.map((e) => `<li>${h(e)}</li>`).join("")}</ul>` : ""}
       ${imp.ok ? `<p>Ownership re-check: ${imp.violations.length ? `<b>${imp.violations.length} violation(s)</b><ul>${imp.violations.map((v) => `<li>${h(v)}</li>`).join("")}</ul>` : "GM-only (entry and all pages)"}</p>` : ""}`
    : "<p>No import yet.</p>";

  return `
  ${rt.initError ? `<p style="color:red">Init error: ${h(rt.initError)}</p>` : ""}
  <section>
    <h3>Versions (record these in docs/spikes/S03-foundry.md)</h3>
    <p>Foundry: ${h(String(release.version ?? game.version ?? "?"))} (generation ${h(String(release.generation ?? "?"))}, build ${h(String(release.build ?? "?"))})<br>
    System: ${h(String(game.system?.id ?? "?"))} ${h(String(game.system?.version ?? "?"))}<br>
    Browser: <code>${h(navigator.userAgent)}</code></p>
  </section>
  <section>
    <h3>Capture</h3>
    <p>Session <code>${h(rt.sessionId)}</code> · this client writes: <b>${thisClientWrites() ? "YES" : "no"}</b> ·
    designated writer: ${h(writerName)} (${h(writer.status)})</p>
    <p>Issued ${rt.capture?.issued ?? 0} · ignored (not writer) ${rt.capture?.ignored ?? 0} · buffered ${stats?.buffered ?? 0} ·
    flushed ${stats?.flushedEvents ?? 0} in ${stats?.flushes ?? 0} flush(es) · failures ${stats?.failures ?? 0} ·
    last flush ${h(String(stats?.lastFlushReason ?? "-"))} · persisted in IndexedDB (this world, all sessions) ${ctx.persisted ?? "?"} · marks ${rt.marks}</p>
    ${stats?.lastError ? `<p style="color:red">Last store error: ${h(stats.lastError)}</p>` : ""}
    <p><select name="writer"><option value="">(nobody)</option>${options}</select>
    <button type="button" data-action="saveWriter">Set designated writer</button></p>
    <p><button type="button" data-action="mark">Mark</button>
    <button type="button" data-action="flush">Flush now</button>
    <button type="button" data-action="exportEvents">Export events (JSONL)</button>
    <button type="button" data-action="refresh">Refresh</button></p>
  </section>
  <section>
    <h3>Refresh / tab-kill loss (earlier sessions on this browser)</h3>
    <table><thead><tr><th>Session start</th><th>Issued</th><th>Persisted</th><th>Lost</th></tr></thead><tbody>${lossRows || '<tr><td colspan="4">none</td></tr>'}</tbody></table>
  </section>
  <section>
    <h3>Hook probe (candidates, verify on v14/PF2e)</h3>
    <table><thead><tr><th>Category</th><th>Hook</th><th>Invocations (this client)</th><th>Events emitted</th><th>Errors</th></tr></thead><tbody>${hookRows}</tbody></table>
    ${rt.probe?.lastError ? `<p>Last probe error: ${h(rt.probe.lastError)}</p>` : ""}
  </section>
  <section>
    <h3>Import test journal (GM-only)</h3>
    <input type="file" name="importFile" accept=".json,application/json" style="display:none">
    <button type="button" data-action="pickImport">Import test journal…</button>
    ${importBlock}
    ${rt.lastExport ? `<p>Last export ${h(rt.lastExport.at)}: ${rt.lastExport.unique} unique, ${rt.lastExport.duplicates} duplicates dropped, ${rt.lastExport.invalid} invalid.</p>` : ""}
  </section>`;
}
