/** The review screen's stylesheet, served from `/static/review.css` (the CSP forbids inline). */
export const REVIEW_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f5f1; --panel: #ffffff; --ink: #1f2328; --muted: #5d6670; --line: #d7d4cc;
  --ic: #1f6feb; --narration: #6f42c1; --rules: #0a7f6e; --ooc: #7a7f87; --mixed: #b76e00;
  --uncertain: #b35900; --none: #8a8f96;
  --danger: #b3261e; --danger-bg: #fdecea; --warn: #8a5a00; --warn-bg: #fff4d6;
  --gm: #4a2c7a; --gm-bg: #f0e9fb; --player: #14532d; --player-bg: #e8f5ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --panel: #1f2226; --ink: #e8e6e1; --muted: #a0a7b0; --line: #363a40;
    --ic: #6ea8fe; --narration: #b598f0; --rules: #4fd1bd; --ooc: #9aa0a8; --mixed: #e6b04d;
    --uncertain: #f0a35c; --none: #9aa0a8;
    --danger: #ff8a80; --danger-bg: #3d1f1d; --warn: #f2c94c; --warn-bg: #3a2e12;
    --gm: #d6c2f7; --gm-bg: #2c2240; --player: #a3e6b8; --player-bg: #17301f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
header.page { padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
header.page h1 { margin: 0; font-size: 18px; }
header.page p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 16px; padding: 16px 20px; align-items: start; }
@media (max-width: 900px) { main { grid-template-columns: minmax(0, 1fr); } }
aside.side { position: sticky; top: 8px; max-height: calc(100vh - 16px); overflow-y: auto; }
@media (max-width: 900px) { aside.side { position: static; max-height: none; } }
section.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
section.panel h2 { margin: 0 0 8px; font-size: 16px; }
a { color: var(--ic); }
.muted { color: var(--muted); font-size: 13px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.alert { border-radius: 6px; padding: 8px 10px; margin: 6px 0; font-size: 14px; }
.alert.danger { background: var(--danger-bg); color: var(--danger); font-weight: 600; }
.alert.warn { background: var(--warn-bg); color: var(--warn); }
.chip { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 12px; border: 1px solid currentColor; white-space: nowrap; }
.chip.danger { background: var(--danger); color: #fff; border-color: var(--danger); font-weight: 700; }
.chip.warn { background: var(--warn-bg); color: var(--warn); }
.label-ic { --accent: var(--ic); } .label-narration { --accent: var(--narration); }
.label-rules { --accent: var(--rules); } .label-ooc { --accent: var(--ooc); }
.label-mixed { --accent: var(--mixed); } .label-uncertain { --accent: var(--uncertain); }
.label-none { --accent: var(--none); }
.chip.label { color: var(--accent); }
article.segment { background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; scroll-margin-top: 12px; }
article.segment:target { outline: 3px solid var(--ic); }
article.segment.spoiler { border-color: var(--danger); border-left-width: 8px; }
article.segment.excluded .effective { opacity: 0.65; }
.segment .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; }
.segment .effective { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 16px; }
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 6px 0; }
.compare div { border: 1px dashed var(--line); border-radius: 4px; padding: 4px 8px; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.compare h4 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
table.corrections { border-collapse: collapse; font-size: 13px; margin: 4px 0; }
table.corrections td, table.corrections th { padding: 1px 8px 1px 0; text-align: left; overflow-wrap: anywhere; }
tr.spelling td { color: var(--warn); font-weight: 600; }
details.edit { margin-top: 6px; }
details.edit summary { cursor: pointer; color: var(--muted); font-size: 13px; }
form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 8px; align-items: end; }
form.grid label, form.grid fieldset { font-size: 13px; }
form.grid fieldset { border: 1px solid var(--line); border-radius: 4px; }
form.grid .wide { grid-column: 1 / -1; }
textarea { width: 100%; min-height: 70px; font: inherit; }
select, input[type="text"] { width: 100%; font: inherit; }
button { font: inherit; padding: 3px 10px; cursor: pointer; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
form.inline { display: inline; }
.foundry-event { border-left: 3px dotted var(--muted); padding: 2px 8px; margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.foundry-event pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
ol.queue { margin: 0; padding: 0; list-style: none; }
ol.queue li { padding: 3px 0; border-bottom: 1px solid var(--line); font-size: 14px; overflow-wrap: anywhere; }
nav.timeline { display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
section.player { border-color: var(--player); }
section.player h2 { color: var(--player); }
section.player .banner, section.gm-only .banner { font-size: 12px; font-weight: 700; padding: 3px 8px; border-radius: 4px; display: inline-block; margin-bottom: 6px; }
section.player .banner { background: var(--player-bg); color: var(--player); }
section.gm-only { border: 2px solid var(--gm); background: var(--gm-bg); }
section.gm-only h2 { color: var(--gm); }
section.gm-only .banner { background: var(--gm); color: var(--gm-bg); }
ol.sentences { margin: 0; padding-left: 20px; }
ol.sentences li { margin-bottom: 8px; overflow-wrap: anywhere; }
sup.foot a { text-decoration: none; }
ul.notes { margin: 0; padding-left: 18px; }
ul.notes li { margin-bottom: 6px; overflow-wrap: anywhere; }
#filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
#filters[hidden] { display: none; }
#filters button[aria-pressed="true"] { outline: 2px solid var(--ic); }
.spoiler-list a { display: inline-block; margin-right: 8px; }
section.approval dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 0 0 8px; font-size: 13px; }
section.approval dd { margin: 0; overflow-wrap: anywhere; }
.state-draft { color: var(--muted); } .state-reviewed { color: var(--warn); }
.state-approved, .state-exported { color: var(--player); font-weight: 700; }
textarea#copy-source { min-height: 110px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.removed { color: var(--muted); text-decoration: line-through; }
`;
